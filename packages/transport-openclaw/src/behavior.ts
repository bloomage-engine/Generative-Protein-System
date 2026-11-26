/**
 * The openclaw runtime-side policy: everything runtime-specific the shared
 * `SessionRuntime` does not know (docs/adr/0005).
 *
 * The kit owns the run loop, reconcile, settle pipeline, watch registry and Run
 * projection; this module supplies only the gateway event→delta mapping, the
 * launch surface (`chat.send`), and the hooks openclaw genuinely differs on:
 * `chat.history` convergence before/after a run, 250 ms notify coalescing, and
 * fire-and-forget persistence. Runtime commands (`/`-prefixed text) are never
 * persisted as Runs (docs/adr/0003).
 */
import type { EventFrame } from "@openclaw/gateway-client/browser";
import type { Run } from "@gps/record";
import {
  isCommandText,
  promptWithAttachments,
  type ApplyContext,
  type ApplyResult,
  type SessionBehavior,
  type TranscriptHandle,
  type Workspace,
} from "@gps/transport";
import type { BackendGateway } from "./connection.js";
import { decideHistorySync } from "./history-sync.js";
import { mapChatEvent, mapThinkingEvent, mapToolEvent, parseParts } from "./mapping.js";

/**
 * Post-settle history-convergence poll. The gateway writes a settled turn's rows
 * into `chat.history` a few tens of ms AFTER it broadcasts the terminal frame
 * (native command replies never stream as events at all and only exist there),
 * so convergence polls until the history stops growing, bounded by this
 * deadline.
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

export interface OpenClawBehaviorDeps {
  gateway: BackendGateway;
  workspace: Workspace | null;
  onError?: (message: string, error: unknown) => void;
}

export function createOpenClawBehavior(deps: OpenClawBehaviorDeps): SessionBehavior<EventFrame> {
  const { gateway, workspace } = deps;
  const log = deps.onError ?? ((message: string, error: unknown) => console.warn(`[openclaw] ${message}`, error));
  /** Gateway runIds driven by runtime commands — never persisted as Runs. */
  const commandRunIds = new Set<string>();

  /** Converge the canonical transcript with gateway rows. Returns whether it changed. */
  function applyHistory(handle: TranscriptHandle, rows: readonly unknown[]): boolean {
    const decision = decideHistorySync({
      inFlight: handle.state.status === "running",
      messages: handle.state.messages,
      rows,
    });
    switch (decision.action) {
      case "keep":
        return false;
      case "reset":
        handle.resetSession();
        return true;
      case "rebuild":
        handle.replaceMessages(decision.messages);
        return true;
    }
  }

  /**
   * Poll `chat.history` until it stops growing (bounded), then converge and push.
   * `alwaysNotify` is the remote case, where streamed content may never have
   * reached a watcher.
   */
  async function converge(handle: TranscriptHandle, alwaysNotify: boolean): Promise<void> {
    const deadline = Date.now() + SETTLE_HISTORY_DEADLINE_MS;
    let latest: unknown[] | null = null;
    let previous: unknown[] | null = null;
    // Consecutive samples whose length matched. Rows land a few tens of ms AFTER
    // the terminal frame, so only three consecutive equal samples count as settled.
    let equalRuns = 0;
    while (Date.now() < deadline) {
      let rows: unknown[];
      try {
        const hist = (await gateway.request("chat.history", { sessionKey: handle.sessionKey })) as {
          messages?: unknown[];
        };
        rows = Array.isArray(hist.messages) ? hist.messages : [];
      } catch (error) {
        log("settle chat.history poll failed; keeping transcript", error);
        break;
      }
      latest = rows;
      if (previous !== null) equalRuns = rows.length === previous.length ? equalRuns + 1 : 0;
      previous = rows;
      if (equalRuns >= 2) break;
      if (Date.now() >= deadline) break;
      await delay(SETTLE_POLL_INTERVAL_MS);
    }
    if (latest === null) return;
    if (applyHistory(handle, latest) || alwaysNotify) handle.notify();
  }

  function applyFrame(frame: EventFrame, ctx: ApplyContext<EventFrame>): ApplyResult | void {
    if (frame.event === "chat") {
      const ev = mapChatEvent((frame.payload ?? {}) as Record<string, unknown>);
      if (!ev) return;
      ctx.reportRunId(ev.runId);
      if (ctx.targetRunId !== null && ev.runId !== ctx.targetRunId) return;
      if (ev.status === "streaming") {
        if (ctx.state.status !== "running") ctx.emit({ type: "session-status", status: "running" });
        ctx.ensureMessage(ev.runId, "assistant");
        const text = ev.deltaText ?? "";
        if (text) ctx.emit({ type: "stream-text", messageId: ev.runId, text, replace: ev.replace });
        return;
      }
      if (ev.status === "completed") {
        // Fallback for providers that return content in one shot: only when no
        // live delta assembled any part.
        const msg = ctx.state.messages.find((m) => m.id === ev.runId);
        if (msg && msg.parts.length === 0 && ev.message && typeof ev.message === "object") {
          ctx.emit({
            type: "update-message",
            messageId: ev.runId,
            patch: { parts: parseParts(ev.message as Record<string, unknown>) },
          });
        }
        ctx.emit({ type: "session-status", status: "idle" });
      } else {
        ctx.emit({ type: "session-status", status: "error" });
      }
      return { settled: true };
    }

    if (frame.event === "agent") {
      const tool = mapToolEvent(frame, ctx.sessionKey);
      if (tool) {
        if (ctx.targetRunId !== null && tool.runId !== ctx.targetRunId) return;
        ctx.ensureMessage(tool.runId, "assistant");
        const args = typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args ?? {});
        ctx.mergeToolCall({
          messageId: tool.runId,
          toolCallId: tool.toolCallId,
          name: tool.toolName,
          args,
          result: tool.resultText,
          isError: tool.isError,
        });
        return;
      }
      const thinking = mapThinkingEvent(frame, ctx.sessionKey);
      if (thinking) {
        if (ctx.targetRunId !== null && thinking.runId !== ctx.targetRunId) return;
        const msg = ctx.ensureMessage(thinking.runId, "assistant");
        const index = msg.parts.length - 1;
        const last = index >= 0 ? msg.parts[index] : undefined;
        if (last && last.type === "reasoning") {
          // The gateway repeats the full cumulative text per event (~13 Hz):
          // replace the one reasoning part in place, never append a copy.
          if (last.text !== thinking.text) {
            ctx.emit({ type: "set-part-text", messageId: msg.id, partIndex: index, text: thinking.text });
          }
        } else {
          ctx.emit({ type: "add-part", messageId: msg.id, part: { type: "reasoning", text: thinking.text } });
        }
      }
    }
  }

  return {
    apply(frame, ctx) {
      return applyFrame(frame, ctx);
    },

    async prepare(handle) {
      // The gateway owns the conversation and is not the only writer: re-sync on
      // every run (not just the first) so a gateway-side reset is followed.
      try {
        const hist = (await gateway.request("chat.history", { sessionKey: handle.sessionKey })) as {
          messages?: unknown[];
        };
        if (Array.isArray(hist.messages)) applyHistory(handle, hist.messages);
      } catch (error) {
        log("chat.history failed; keeping the in-memory transcript", error);
      }
    },

    dispatch(request, run) {
      for (const message of request.messages) {
        const isCommand = isCommandText(message.content);
        const text = promptWithAttachments(
          message.content,
          message.attachments,
          workspace ? { toAgentPath: (relPath) => workspace.toAgentPath(relPath) } : {},
        );
        void (async () => {
          try {
            const res = (await gateway.request("chat.send", {
              sessionKey: request.sessionKey,
              message: text,
              idempotencyKey: newId(),
              queueMode: "followup",
            })) as { runId?: string };
            if (res?.runId) {
              run.targetRunId = res.runId;
              if (isCommand) commandRunIds.add(res.runId);
            }
          } catch (error) {
            log("chat.send failed", error);
            // A failed send ends the stream without a Run (nothing was persisted
            // at the gateway either) — the lone user row survives a later probe.
            run.emit({ type: "session-status", status: "error" });
            run.abort();
          }
        })();
      }
    },

    cancel(sessionKey: string, runId: string | null): Promise<void> {
      // The gateway cancels mid-turn: `chat.abort` stops the named run (or the
      // session's active run) — the capability dsh's SDK wire lacks.
      const params: Record<string, unknown> = { sessionKey };
      if (runId) params["runId"] = runId;
      return gateway
        .request("chat.abort", params)
        .then(() => undefined)
        .catch((error) => {
          log("chat.abort failed", error);
        });
    },

    beforePersist(ctx) {
      if (ctx.inRun) {
        // Local settles persist immediately; the reply-only rows (native command
        // replies) land later, so converge afterwards and re-push if it changed.
        void converge(ctx, false);
        return;
      }
      // Remote settles must converge FIRST: the driving user row exists only in
      // history, and persistence must see it (so a remote command is never a Run).
      return converge(ctx, true);
    },

    projectRun(ctx) {
      const runId = ctx.runId;
      if (!runId) return null;
      // Runtime commands are not research turns (docs/adr/0003): local runIds are
      // tracked precisely, and a synced remote command turn is caught by the
      // preceding user row's `/` prefix.
      if (commandRunIds.has(runId)) {
        commandRunIds.delete(runId);
        return null;
      }
      const messages = ctx.state.messages;
      const index = messages.findIndex((m) => m.id === runId);
      if (index !== -1) {
        for (let i = index - 1; i >= 0; i--) {
          const prev = messages[i]!;
          if (prev.role !== "user") continue;
          const text = prev.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("");
          if (isCommandText(text)) return null;
          break;
        }
      }
      const assistant = messages.find((m) => m.id === runId);
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const output = assistant?.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      return {
        id: runId,
        status: "completed",
        input:
          lastUser?.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("") ?? "",
        output,
      } satisfies Partial<Run>;
    },

    watch: { coalesceMs: 250 },
    awaitSettle: false,
  };
}
