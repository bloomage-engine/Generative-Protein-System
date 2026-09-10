import type {
  CommandDescriptor,
  RecordStoreLike,
  RuntimeAdapter,
  RuntimeFactory,
  RuntimeInitOptions,
  RuntimePlugin,
  SessionState,
  StateDelta,
  TransportCommand,
  MessagePart,
  WatchSnapshot,
  Workspace,
} from "@science-studio/transport";
import { RunFlow, Transcript, promptWithAttachments, userMessageParts } from "@science-studio/transport";
import type { EventFrame } from "@openclaw/gateway-client/browser";
import type { Run, RunStatus } from "@science-studio/record";
import {
  isCommandText,
  mapCommandEntries,
  type GatewayCommandEntry,
} from "./commands.js";
import { createBackendGateway, type BackendGateway, type BackendGatewayOptions } from "./connection.js";
import { OPENCLAW_CAPABILITIES, openClawLocalBinding, parseGatewayBinding, type GatewayBinding } from "./binding.js";
import {
  mapChatEvent,
  mapThinkingEvent,
  mapToolEvent,
  parseParts,
} from "./mapping.js";
import { findToolCallIndex } from "./tool-result.js";
import { decideHistorySync } from "./history-sync.js";

const CLIENT_VERSION = "0.0.0";

/** Freshness window for the cached command catalog (`listCommands`). */
const COMMAND_CATALOG_TTL_MS = 60_000;

/**
 * Post-settle history-convergence poll (`convergeSettledHistory`). The gateway
 * writes a settled turn's rows into `chat.history` a few tens of ms AFTER it
 * broadcasts the terminal frame (native command replies never stream as
 * events at all and only exist there), so convergence polls until the history
 * stops growing, bounded by this deadline.
 */
const SETTLE_POLL_INTERVAL_MS = 40;
const SETTLE_HISTORY_DEADLINE_MS = 1_500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Per-session transcript. Holds the normalized `SessionState` and translates
 * gateway `chat` / `agent` frames into `StateDelta`s.
 */
class SessionTranscript extends Transcript {
  private lastRunId: string | null = null;

  private ensureAssistant(runId: string) {
    let msg = this.state.messages.find((m) => m.id === runId);
    if (!msg) {
      msg = { id: runId, role: "assistant", parts: [] };
      this.state.messages.push(msg);
      this.flow?.push({ type: "add-message", message: msg });
    }
    return msg;
  }

  /**
   * Converge the canonical transcript with the gateway's current history on
   * every run. The gateway owns the conversation, and it is not the only
   * writer: turns can arrive from other clients (e.g. the openclaw UI) between
   * two of our runs, and their user rows never pass through this process —
   * seeding only when empty would strand the transcript on stale rows and
   * reconcile would keep serving a transcript missing those user turns (with
   * orphan assistant messages where streaming events happened to leak in).
   * So whenever the parsed history is not a content-prefix of the current
   * transcript, the transcript is rebuilt from the gateway rows.
   *
   * Returns true when the transcript changed (a rebuild or a session reset), so
   * callers know a fresh snapshot should be pushed to watchers.
   *
   * Guards: never touch an in-flight run (the gateway lags the live events,
   * and a rebuild would wipe the partially assembled assistant message); an
   * equal or gateway-lagging transcript keeps its local messages and ids (no
   * reconcile churn after every local run); clearing is guarded — an empty
   * gateway history only counts as a reset when the transcript holds >= 2
   * messages and is not mid-run, so a single never-persisted message (failed
   * `chat.send`) survives.
   */
  syncFromHistory(rows: unknown[]): boolean {
    const decision = decideHistorySync({
      inFlight: this.state.status === "running",
      messages: this.state.messages,
      rows,
    });
    switch (decision.action) {
      case "keep":
        return false;
      case "reset":
        this.state.messages = [];
        this.state.status = "idle";
        return true;
      case "rebuild":
        this.state.messages = decision.messages;
        return true;
    }
  }

  /** Translate one gateway frame into deltas; returns true when the run ended. */
  apply(frame: EventFrame): boolean {
    const target = this.flow?.targetRunId ?? null;
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
      this.flow?.end();
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
      // Same reasoning run, later event with newer full text: replace in place
      // via a path-level text delta — never a whole-parts-array rewrite.
      if (last.text === text) return;
      this.emit({ type: "set-part-text", messageId: msg.id, partIndex: i, text });
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
    const idx = findToolCallIndex(msg.parts, tool.toolCallId);
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
export interface OpenClawRuntimeAdapterOptions {
  /**
   * Test seam: inject the gateway factory (defaults to the real backend
   * gateway). Lets a harness drive `run()` against a scripted gateway.
   */
  createGateway?: (opts: BackendGatewayOptions) => BackendGateway;
}

export class OpenClawRuntimeAdapter implements RuntimeAdapter {
  runtime = "openclaw";
  private readonly createGateway: (opts: BackendGatewayOptions) => BackendGateway;
  private gateway: BackendGateway | null = null;
  private recordStore: RecordStoreLike | null = null;
  /** The session's workspace (seam, §5); used for attachment refs in Phase 2. */
  private workspace: Workspace | null = null;
  /** Canonical session for thread ids the gateway does not namespace. */
  private defaultSession: string | undefined;
  private transcripts = new Map<string, SessionTranscript>();
  private ready: Promise<void> | null = null;
  /** Standing watchers per session (the transport-service watch endpoint). */
  private watch = new Map<string, Set<(s: WatchSnapshot) => void>>();
  private watchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Gateway runIds driven by runtime commands (user text starting with "/").
   * Such runs settle like any other but must never persist a `Run` — commands
   * are not research turns (see docs/adr/0003).
   */
  private commandRunIds = new Set<string>();
  /** Cached command catalog (see `listCommands`). */
  private commandCatalog: { fetchedAt: number; descriptors: CommandDescriptor[] } | null = null;
  private commandCatalogInflight: Promise<CommandDescriptor[]> | null = null;

  constructor(options: OpenClawRuntimeAdapterOptions = {}) {
    this.createGateway = options.createGateway ?? createBackendGateway;
  }

  async init(opts: RuntimeInitOptions): Promise<void> {
    this.recordStore = opts.recordStore;
    this.workspace = opts.workspace ?? null;
    const gateway = parseGatewayBinding(opts.binding);
    this.defaultSession = gateway.defaultSession;
    this.gateway = this.createGateway({
      url: gateway.url,
      token: gateway.token,
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
        const local = transcript.hasActiveFlow();
        if (local) {
          // Local run: the driving user row was echoed before `chat.send`, so
          // persistence can run immediately.
          if (runId) void this.persistRun(transcript, runId);
          this.notifyNow(sessionKey);
        }
        // Converge with the gateway history as it settles. The gateway writes a
        // turn's rows to chat.history only AFTER the terminal frame, and native
        // command replies never stream as events at all — so the transcript (and
        // any watcher snapshot) must be re-synced once the rows land, or a
        // command's reply would only appear on the next run/probe.
        // Remote settles additionally persist only after the sync: their driving
        // user row exists only in history, and persistence must see it so a
        // remote runtime command is never recorded as a research Run (see
        // docs/adr/0003).
        void this.convergeSettledHistory(sessionKey, transcript, !local).then(() => {
          if (!local && runId) void this.persistRun(transcript, runId);
        });
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
    }
    // The gateway owns the conversation. Re-sync the canonical transcript
    // against its current history on EVERY run (not just the first): a session
    // reset done on the gateway side empties the history, and the cached
    // transcript must follow or reconcile would keep feeding clients stale
    // messages the gateway has already forgotten.
    try {
      const hist = (await this.gateway.request("chat.history", { sessionKey })) as { messages?: unknown[] };
      if (Array.isArray(hist.messages)) transcript.syncFromHistory(hist.messages);
    } catch (err) {
      console.warn("[openclaw] chat.history failed; keeping the in-memory transcript", err);
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
          // Workspace attachments become `file` parts so the UI shows a chip
          // immediately; the agent gets the paths in the sent text below.
          parts: userMessageParts(command.message.content, command.message.attachments),
        };
        transcript.emit({ type: "add-message", message: userMsg });
        transcript.emit({ type: "session-status", status: "running" });
      }

      // Kick off `chat.send` without awaiting it: gateway events (mapped via
      // onEvent → transcript.apply) stream into the same flow while the
      // request is still in flight, and the runId attaches as soon as the
      // gateway reports it. Command messages (text starting with "/") are
      // sent verbatim — the gateway interprets them — and their runIds are
      // tracked so the settle never persists a research `Run`.
      const workspace = this.workspace;
      for (const command of sends) {
        const isCommand = isCommandText(command.message.content);
        const message = promptWithAttachments(
          command.message.content,
          command.message.attachments,
          workspace ? { toAgentPath: (relPath) => workspace.toAgentPath(relPath) } : {},
        );
        void (async () => {
          try {
            const res = (await this.gateway!.request("chat.send", {
              sessionKey,
              message,
              idempotencyKey: newId(),
              queueMode: "followup",
            })) as { runId?: string };
            if (res?.runId) {
              flow.targetRunId = res.runId;
              if (isCommand) this.commandRunIds.add(res.runId);
            }
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

  /**
   * The canonical session key a client `threadId` targets. The gateway
   * namespaces sessions `agent:…`; ids outside that namespace (assistant-ui's
   * local-mint ids, or any other client id) fall back to the configured
   * default session so probes and sends converge (see the seam doc on
   * `RuntimeAdapter.resolveSessionKey`).
   */
  resolveSessionKey(threadId: string | null): string {
    if (threadId !== null && threadId.startsWith("agent:")) return threadId;
    return this.defaultSession ?? process.env.OPENCLAW_DEFAULT_SESSION ?? "agent:main:main";
  }

  /**
   * Standing watch seam. Registers a `sink` for a session, immediately pushes
   * the current canonical transcript (baseline, if one already exists), and
   * returns an unsubscribe. Subsequent settles coalesce through
   * `convergeSettledHistory` and push a fresh `WatchSnapshot` (whole
   * transcript, keyed by message id) that a consumer can adopt via
   * `importExternalState`.
   */
  subscribe(sessionKey: string, sink: (s: WatchSnapshot) => void): () => void {
    let set = this.watch.get(sessionKey);
    if (!set) {
      set = new Set();
      this.watch.set(sessionKey, set);
    }
    set.add(sink);
    const snapshot = this.snapshotOf(sessionKey);
    if (snapshot) sink(snapshot);
    return () => {
      const watchers = this.watch.get(sessionKey);
      if (!watchers) return;
      watchers.delete(sink);
      if (watchers.size === 0) {
        this.watch.delete(sessionKey);
        const timer = this.watchTimers.get(sessionKey);
        if (timer) clearTimeout(timer);
        this.watchTimers.delete(sessionKey);
      }
    };
  }

  /**
   * Curated runtime command catalog for the frontend slash menu. Proxies the
   * gateway's `commands.list` and caches it with a short TTL so catalog
   * freshness tracks gateway config changes without a WS round-trip per
   * request; a failed refresh serves the last successful catalog (or empty).
   */
  async listCommands(): Promise<CommandDescriptor[]> {
    if (!this.gateway) return [];
    if (this.commandCatalog && Date.now() - this.commandCatalog.fetchedAt < COMMAND_CATALOG_TTL_MS) {
      return this.commandCatalog.descriptors;
    }
    if (!this.commandCatalogInflight) {
      this.commandCatalogInflight = this.refreshCommandCatalog();
    }
    return this.commandCatalogInflight;
  }

  private async refreshCommandCatalog(): Promise<CommandDescriptor[]> {
    try {
      await this.ready;
      const res = (await this.gateway!.request("commands.list", {
        includeArgs: true,
      })) as { commands?: unknown[] };
      const descriptors = mapCommandEntries((res.commands ?? []) as GatewayCommandEntry[]);
      this.commandCatalog = { fetchedAt: Date.now(), descriptors };
      return descriptors;
    } catch (err) {
      console.warn("[openclaw] commands.list failed; serving stale/empty catalog", err);
      if (this.commandCatalog) {
        // Serve the stale catalog, and defer the next refresh attempt so a
        // down gateway doesn't spam a failed fetch on every request.
        this.commandCatalog = { fetchedAt: Date.now(), descriptors: this.commandCatalog.descriptors };
        return this.commandCatalog.descriptors;
      }
      return [];
    } finally {
      this.commandCatalogInflight = null;
    }
  }

  private snapshotOf(sessionKey: string): WatchSnapshot | null {
    const transcript = this.transcripts.get(sessionKey);
    if (!transcript) return null;
    const messages: WatchSnapshot["messages"] = {};
    for (const m of transcript.state.messages) messages[m.id] = structuredClone(m);
    return { status: transcript.state.status, messages };
  }

  /**
   * Post-settle convergence for a session's transcript (local and remote).
   *
   * The gateway owns the authoritative conversation, and it is not the only
   * writer: rows can arrive in `chat.history` that never streamed as
   * `chat`/`agent` events — remote user turns, and native command replies,
   * which are written only AFTER the terminal frame (a single fetch at settle
   * time would miss them). Poll `chat.history` until it stops growing (bounded
   * by `SETTLE_HISTORY_DEADLINE_MS`), then `syncFromHistory` so those rows
   * enter the canonical transcript.
   *
   * `alwaysNotify` pushes a fresh snapshot regardless of whether the sync
   * changed the transcript — the remote-settle case, where streamed content
   * may never have reached a watcher. Local settles already fired `notifyNow`
   * at settle time, so they only re-push when the sync actually changed the
   * transcript (a command reply that just landed).
   */
  private async convergeSettledHistory(
    sessionKey: string,
    transcript: SessionTranscript,
    alwaysNotify: boolean,
  ): Promise<void> {
    if (!this.gateway) return;
    const deadline = Date.now() + SETTLE_HISTORY_DEADLINE_MS;
    let latest: unknown[] | null = null;
    let previous: unknown[] | null = null;
    // Consecutive samples whose length matched the previous sample. The settle's
    // rows land a few tens of ms AFTER the terminal frame, so a sample that
    // looks converged may still be mid-write; only treat the history as settled
    // after three consecutive equal samples (kills the race where the write
    // lands between two early equal samples).
    let equalRuns = 0;
    while (Date.now() < deadline) {
      let rows: unknown[];
      try {
        const hist = (await this.gateway.request("chat.history", { sessionKey })) as {
          messages?: unknown[];
        };
        rows = Array.isArray(hist.messages) ? hist.messages : [];
      } catch (err) {
        console.warn("[openclaw] settle chat.history poll failed; keeping transcript", err);
        break;
      }
      latest = rows;
      if (previous !== null) equalRuns = rows.length === previous.length ? equalRuns + 1 : 0;
      previous = rows;
      if (equalRuns >= 2) break; // three consecutive equal samples
      if (Date.now() >= deadline) break;
      await delay(SETTLE_POLL_INTERVAL_MS);
    }
    if (latest === null) return;
    if (transcript.syncFromHistory(latest) || alwaysNotify) this.notifyNow(sessionKey);
  }

  /**
   * Coalesce settles into one push per trailing window: the first settle after
   * a quiet period starts a 250ms timer; further settles within that window
   * are captured by the single fire (which reads the latest transcript). Keeps
   * a burst of frames from spamming the client once per frame.
   */
  private notifyNow(sessionKey: string): void {
    if (this.watchTimers.get(sessionKey)) return;
    const timer = setTimeout(() => {
      this.watchTimers.delete(sessionKey);
      const set = this.watch.get(sessionKey);
      if (!set || set.size === 0) return;
      const snapshot = this.snapshotOf(sessionKey);
      if (!snapshot) return;
      for (const sink of set) sink(snapshot);
    }, 250);
    timer.unref?.();
    this.watchTimers.set(sessionKey, timer);
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
    // Runtime commands are not research turns — never persist them as Runs
    // (docs/adr/0003). Two guards: runIds tracked from local command sends, and
    // a transcript check that skips settles whose immediately preceding user
    // row starts with "/" (covers command turns that arrived remotely and
    // were synced from chat.history before their settle).
    if (this.commandRunIds.has(runId)) {
      this.commandRunIds.delete(runId);
      return;
    }
    const messages = transcript.state.messages;
    const runIndex = messages.findIndex((m) => m.id === runId);
    if (runIndex !== -1) {
      for (let i = runIndex - 1; i >= 0; i--) {
        const prev = messages[i]!;
        if (prev.role !== "user") continue;
        const text = prev.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as Extract<MessagePart, { type: "text" }>).text)
          .join("");
        if (isCommandText(text)) return;
        break;
      }
    }
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

/**
 * The openclaw runtime factory — the ONLY registration surface the service
 * needs. Adding or replacing a runtime never edits a core package: the service
 * registers factories from configuration (docs/design/implementation-plan.md §5).
 */
export function createOpenClawRuntimeFactory(): RuntimeFactory {
  return {
    runtime: "openclaw",
    capabilities: OPENCLAW_CAPABILITIES,
    create: () => new OpenClawRuntimeAdapter(),
  };
}

/**
 * The package's plugin export. The service dynamically imports runtime modules
 * (by specifier) and collects `runtimePlugins` — no static dependency on this
 * package, so adding/replacing a runtime never edits a core package.
 */
export const runtimePlugins: RuntimePlugin[] = [
  { runtime: "openclaw", factory: createOpenClawRuntimeFactory(), localBinding: openClawLocalBinding },
];

// This runtime's own launch surface, exported explicitly (no `export *`).
export { OPENCLAW_CAPABILITIES, openClawBinding, openClawLocalBinding, parseGatewayBinding } from "./binding.js";
export type { GatewayBinding } from "./binding.js";
