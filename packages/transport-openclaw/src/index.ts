import type {
  RecordStoreLike,
  RuntimeAdapter,
  RuntimeInitOptions,
  SessionState,
  StateDelta,
  TransportCommand,
  MessagePart,
} from "@science-studio/transport";
import type { EventFrame } from "@openclaw/gateway-client/browser";
import type { Run, RunStatus } from "@science-studio/record";
import { createBackendGateway, type BackendGateway } from "./connection.js";
import {
  mapChatEvent,
  mapThinkingEvent,
  mapToolEvent,
  parseParts,
} from "./mapping.js";

const CLIENT_VERSION = "0.0.0";

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A resumable queue of streamed state deltas for one `run()` invocation.
 */
class RunFlow {
  private deltas: StateDelta[] = [];
  private waiters: (() => void)[] = [];
  private ended = false;
  /** The gateway runId this flow tracks; events for other runs are ignored. */
  targetRunId: string | null = null;

  push(delta: StateDelta): void {
    this.deltas.push(delta);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  async *iterate(): AsyncIterable<StateDelta> {
    let i = 0;
    for (;;) {
      while (i < this.deltas.length) yield this.deltas[i++]!;
      if (this.ended) break;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/**
 * Per-session transcript. Holds the normalized `SessionState` and translates
 * gateway `chat` / `agent` frames into `StateDelta`s.
 */
class SessionTranscript {
  readonly sessionKey: string;
  state: SessionState;
  private activeFlow: RunFlow | null = null;
  private lastRunId: string | null = null;

  constructor(sessionKey: string, initial: SessionState) {
    this.sessionKey = sessionKey;
    this.state = initial;
  }

  attachFlow(flow: RunFlow): void {
    this.activeFlow = flow;
  }

  detachFlow(flow: RunFlow): void {
    if (this.activeFlow === flow) this.activeFlow = null;
  }

  /** Seed the transcript from a `chat.history` response (system rows excluded). */
  seedFromHistory(messages: unknown[]): void {
    for (const row of messages) {
      if (!row || typeof row !== "object") continue;
      const m = row as Record<string, unknown>;
      // Skip non-conversational rows (e.g. the gateway's system "reset" frames).
      if (m.role === "system") continue;
      const role = typeof m.role === "string" ? m.role : "user";
      const id = typeof m.id === "string" ? m.id : `hist-${this.state.messages.length}`;
      this.state.messages.push({
        id,
        role: (role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        parts: parseParts(m),
      });
    }
  }

  private ensureAssistant(runId: string) {
    let msg = this.state.messages.find((m) => m.id === runId);
    if (!msg) {
      msg = { id: runId, role: "assistant", parts: [] };
      this.state.messages.push(msg);
      this.activeFlow?.push({ type: "add-message", message: msg });
    }
    return msg;
  }

  /**
   * Apply a delta to the local canonical transcript (`state`), which is what
   * later requests reconcile clients against. Every delta streamed to a client
   * must also be reflected here so the transcript is never stale.
   */
  private reflect(delta: StateDelta): void {
    switch (delta.type) {
      case "session-status":
        this.state.status = delta.status;
        break;
      case "add-message":
        this.state.messages.push(delta.message);
        break;
      case "update-message": {
        const msg = this.state.messages.find((m) => m.id === delta.messageId);
        if (!msg) break;
        if (delta.patch.role !== undefined) msg.role = delta.patch.role;
        if (delta.patch.parts !== undefined) msg.parts = delta.patch.parts;
        break;
      }
      case "add-part": {
        const msg = this.state.messages.find((m) => m.id === delta.messageId);
        msg?.parts.push(delta.part);
        break;
      }
      case "append-text": {
        const msg = this.state.messages.find((m) => m.id === delta.messageId);
        msg?.parts.push({ type: "text", text: delta.text });
        break;
      }
      case "stream-text": {
        const msg = this.state.messages.find((m) => m.id === delta.messageId);
        if (!msg) break;
        const i = msg.parts.length - 1;
        const last = i >= 0 ? msg.parts[i] : undefined;
        if (last && last.type === "text") {
          msg.parts[i] = {
            ...last,
            text: delta.replace ? delta.text : (last.text ?? "") + delta.text,
          };
        } else {
          msg.parts.push({ type: "text", text: delta.text });
        }
        break;
      }
      default:
        break;
    }
  }

  /** Push a delta onto the active flow (if any) AND mirror it in `state`. */
  emit(delta: StateDelta): void {
    this.activeFlow?.push(delta);
    this.reflect(delta);
  }

  /** The canonical transcript snapshot used to reconcile a client's state. */
  snapshot(): StateDelta {
    return {
      type: "reconcile",
      status: this.state.status,
      messages: this.state.messages.map((m) => structuredClone(m)),
    };
  }

  /** Translate one gateway frame into deltas; returns true when the run ended. */
  apply(frame: EventFrame): boolean {
    const target = this.activeFlow?.targetRunId ?? null;
    if (frame.event === "chat") {
      const ev = mapChatEvent((frame.payload ?? {}) as Record<string, unknown>);
      if (!ev) return false;
      this.lastRunId = ev.runId;
      if (target !== null && ev.runId !== target) return false;
      if (ev.status === "streaming") {
        if (this.state.status !== "running") {
          this.emit({ type: "session-status", status: "running" });
        }
        this.ensureAssistant(ev.runId);
        // The gateway streams one text fragment per event (`deltaText`). Grow
        // the message's trailing text part so tokens render as they arrive.
        const text = ev.deltaText ?? "";
        if (text) {
          this.emit({ type: "stream-text", messageId: ev.runId, text, replace: ev.replace });
        }
        return false;
      }
      // terminal (final / aborted / error)
      if (ev.status === "completed") {
        // Fallback for providers that return content in one shot: if nothing
        // was assembled from live deltas, surface the final snapshot (parts in
        // message order). Live-assembled parts are kept — they already follow
        // the true event order (tools interleaved chronologically).
        const msg = this.state.messages.find((m) => m.id === ev.runId);
        if (
          msg &&
          msg.parts.length === 0 &&
          ev.message &&
          typeof ev.message === "object"
        ) {
          this.emit({
            type: "update-message",
            messageId: ev.runId,
            patch: { parts: parseParts(ev.message as Record<string, unknown>) },
          });
        }
        this.emit({ type: "session-status", status: "idle" });
      } else {
        this.emit({ type: "session-status", status: "error" });
      }
      this.activeFlow?.end();
      return true;
    }

    if (frame.event === "agent") {
      const tool = mapToolEvent(frame, this.sessionKey);
      if (tool) {
        if (target !== null && tool.runId !== target) return false;
        this.ensureAssistant(tool.runId);
        this.applyToolPart(tool.runId, tool);
        return false;
      }
      const thinking = mapThinkingEvent(frame, this.sessionKey);
      if (thinking) {
        if (target !== null && thinking.runId !== target) return false;
        this.ensureAssistant(thinking.runId);
        this.applyThinkingPart(thinking.runId, thinking.text);
        return false;
      }
    }
    return false;
  }

  /**
   * Record a live `thinking` fragment. The gateway streams the reasoning text
   * as the FULL cumulative text on every event (observed ~13 Hz), so appending
   * one part per event would stack N copies of the same growing text into the
   * canonical transcript, the wire `parts` arrays, and the client DOM (O(n²)
   * churn per run — the main source of render jank during long reasoning
   * phases). Collapse consecutive thinking events into ONE reasoning part and
   * replace its text in place; a reasoning run therefore stays a single part.
   */
  private applyThinkingPart(runId: string, text: string): void {
    const msg = this.state.messages.find((m) => m.id === runId);
    if (!msg) return;
    const i = msg.parts.length - 1;
    const last = i >= 0 ? msg.parts[i] : undefined;
    if (last && last.type === "reasoning") {
      // Same reasoning run, later event with newer full text: replace.
      if (last.text === text) return;
      const next = [...msg.parts];
      next[i] = { ...last, text };
      this.emit({ type: "update-message", messageId: msg.id, patch: { parts: next } });
      return;
    }
    // First thinking event (or reasoning resumed after other content).
    this.emit({ type: "add-part", messageId: msg.id, part: { type: "reasoning", text } });
  }

  /**
   * Record one tool lifecycle event on the assistant message. `start` creates
   * the tool-call part; `result` merges the output into the same part (by
   * toolCallId) instead of appending a duplicate. Keeps canonical parts in
   * the order the gateway emitted them.
   */
  private applyToolPart(
    runId: string,
    tool: NonNullable<ReturnType<typeof mapToolEvent>>,
  ): void {
    const msg = this.ensureAssistant(runId);
    const partOf = (p: MessagePart): p is Extract<MessagePart, { type: "tool-call" }> =>
      p.type === "tool-call" && p.id === tool.toolCallId;
    const idx = msg.parts.findIndex(partOf);
    const args = typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args ?? {});
    if (idx === -1) {
      const part: Extract<MessagePart, { type: "tool-call" }> = {
        type: "tool-call",
        id: tool.toolCallId,
        name: tool.toolName,
        args,
      };
      if (tool.resultText !== undefined) part.result = tool.resultText;
      if (tool.isError) part.isError = true;
      this.emit({ type: "add-part", messageId: msg.id, part });
      return;
    }
    // Same tool, later lifecycle event (result): merge instead of duplicating.
    const next = [...msg.parts];
    const existing = next[idx] as Extract<MessagePart, { type: "tool-call" }>;
    next[idx] = {
      ...existing,
      // keep the args from the `start` phase when the result event carries none
      ...(args ? { args: existing.args || args } : {}),
      ...(tool.resultText !== undefined ? { result: tool.resultText } : {}),
      ...(tool.isError ? { isError: true } : {}),
    };
    this.emit({ type: "update-message", messageId: msg.id, patch: { parts: next } });
  }

  currentRunId(): string | null {
    return this.lastRunId;
  }
}

/**
 * OpenClaw runtime adapter (backend transport-service).
 *
 * Connects to an OpenClaw gateway as an operator client, drives `chat.send`,
 * and streams state deltas back. Persists a `Run` to the record store when a
 * run completes. NOTES:
 * - The gateway `sessionKey` is taken from `SessionState.sessionId`; mapping a
 *   Study `Session` to a gateway session is a later concern.
 * - Streaming is mapped conservatively: live text deltas (`deltaText`) grow a
 *   single trailing text part; tool lifecycle events merge into ONE part per
 *   toolCallId; thinking events collapse into ONE reasoning part replaced in
 *   place (the gateway repeats the full cumulative text per event).
 *   Full timeline ordering should be verified against a live gateway.
 */
export class OpenClawRuntimeAdapter implements RuntimeAdapter {
  runtime = "openclaw";
  private gateway: BackendGateway | null = null;
  private recordStore: RecordStoreLike | null = null;
  private transcripts = new Map<string, SessionTranscript>();
  private ready: Promise<void> | null = null;

  async init(opts: RuntimeInitOptions): Promise<void> {
    this.recordStore = opts.recordStore;
    this.gateway = createBackendGateway({
      url: opts.gateway.url,
      token: opts.gateway.token,
      version: CLIENT_VERSION,
    });

    this.gateway.onEvent((frame) => {
      const sessionKey = (frame.payload as Record<string, unknown> | null)?.sessionKey as string | undefined;
      if (typeof sessionKey !== "string") return;
      const transcript = this.transcripts.get(sessionKey);
      if (!transcript) return;
      const ended = transcript.apply(frame);
      if (ended) {
        const runId = transcript.currentRunId();
        if (runId) void this.persistRun(transcript, runId);
      }
    });

    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("gateway not ready within 15s (check URL/token)")),
        15_000,
      );
      timer.unref?.();
      this.gateway!.onReady(() => {
        clearTimeout(timer);
        resolve();
      });
      this.gateway!.start();
    });
    await this.ready;
  }

  async *run(session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta> {
    if (!this.gateway) throw new Error("adapter not initialized");
    await this.ready;
    const sessionKey = session.sessionId;
    let transcript = this.transcripts.get(sessionKey);
    if (!transcript) {
      transcript = new SessionTranscript(sessionKey, session);
      this.transcripts.set(sessionKey, transcript);
      try {
        const hist = (await this.gateway.request("chat.history", { sessionKey })) as { messages?: unknown[] };
        if (Array.isArray(hist.messages)) transcript.seedFromHistory(hist.messages);
      } catch (err) {
        console.warn("[openclaw] chat.history failed; starting from an empty transcript", err);
      }
    }

    // Reconcile this client against the canonical transcript first. The
    // transport-service folds this into a full state snapshot whenever the
    // client's claimed state has drifted (e.g. a fresh page load after a
    // reload), so history is never lost across requests. Clients that are
    // already in sync simply get no extra operations.
    yield transcript.snapshot();

    const flow = new RunFlow();
    transcript.attachFlow(flow);
    try {
      // Append the user message(s) and flip to running. These deltas are
      // pushed into the flow so the client renders the user's message before
      // (or while) the gateway accepts the run — no need to wait for
      // `chat.send` to resolve first.
      const sends = commands.filter((c) => c.type === "add-message");
      for (const command of sends) {
        const userMsg = {
          id: command.message.id,
          role: "user" as const,
          parts: [{ type: "text" as const, text: command.message.content }],
        };
        transcript.emit({ type: "add-message", message: userMsg });
        transcript.emit({ type: "session-status", status: "running" });
      }

      // Kick off `chat.send` without awaiting it: gateway events (mapped via
      // onEvent → transcript.apply) stream into the same flow while the
      // request is still in flight, and the runId attaches as soon as the
      // gateway reports it.
      for (const command of sends) {
        void (async () => {
          try {
            const res = (await this.gateway!.request("chat.send", {
              sessionKey,
              message: command.message.content,
              idempotencyKey: newId(),
              queueMode: "followup",
            })) as { runId?: string };
            if (res?.runId) flow.targetRunId = res.runId;
          } catch (err) {
            console.error("[openclaw] chat.send failed", err);
            transcript.emit({ type: "session-status", status: "error" });
            flow.end();
          }
        })();
      }

      // Nothing to drive (e.g. a state/session-sync probe): terminate the
      // stream so the client's run settles instead of hanging on an open SSE
      // connection.
      if (sends.length === 0) flow.end();

      yield* flow.iterate();
    } finally {
      transcript.detachFlow(flow);
    }
  }

  abort(_reason?: string): void {
    // TODO: keep the active runId per session and issue `chat.abort`.
  }

  approve(approvalId: string, decision: "approve" | "reject"): void {
    void this.gateway?.request("approval.resolve", {
      approvalId,
      decision,
      channel: "webchat",
    });
  }

  private async persistRun(transcript: SessionTranscript, runId: string): Promise<void> {
    if (!this.recordStore) return;
    const assistant = transcript.state.messages.find((m) => m.id === runId);
    const user = [...transcript.state.messages].reverse().find((m) => m.role === "user");
    const text = assistant?.parts
      .map((p) => (p.type === "text" ? p.text : p.type === "reasoning" ? "" : ""))
      .filter(Boolean)
      .join("\n");
    const run: Run = {
      id: runId,
      taskId: transcript.state.sessionId,
      sessionId: transcript.state.sessionId,
      status: "completed" as RunStatus,
      agentId: transcript.state.agentId,
      parameters: {},
      input: user?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "",
      output: text,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    try {
      await this.recordStore.addRun(run);
    } catch (err) {
      console.warn("[openclaw] failed to persist run", err);
    }
  }
}
