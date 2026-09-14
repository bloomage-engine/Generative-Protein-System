/**
 * The dsh runtime-side policy: everything runtime-specific the shared
 * `SessionRuntime` does not know (docs/adr/0005).
 *
 * The kit owns the run loop, reconcile, settle pipeline, watch registry and Run
 * projection; this module supplies only the committed-event→delta mapping, the
 * launch surface (`runTurn` on a generation-scoped harness session id), and the hooks dsh
 * genuinely differs on: cold-start mirror restore, mirror durability at settle,
 * an async cold watch baseline, and per-turn Run parameters. One prompt = one
 * Harness turn = one persisted `Run`, for EVERY terminal `turn/end` reason
 * (failed turns are recorded too — docs/adr/0004).
 */
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  promptWithAttachments,
  type ApplyContext,
  type ApplyResult,
  type SessionBehavior,
  type WatchSnapshot,
  type Workspace,
} from "@science-studio/transport";
import type { DshTurnClient } from "./client.js";
import type { TranscriptMirror } from "./mirror.js";
import { contentToParts, extractResultText, findToolCallMessage, runStatus, turnEndStatus } from "./mapping.js";

/**
 * The SDK runtime's create-only `session/prompt` builds the agent+session pair
 * for a client-chosen id and rejects one the harness home already holds —
 * `session "<id>" already exists`, a plain internal error on the wire (no
 * structured code for it). The home is durable ACROSS child generations, so
 * every id a previous generation persisted is permanently uncreatable (the SDK
 * wire has no resume path — docs/adr/0004). The only id even this generation
 * cannot create is one another process minted at the same instant; that failure
 * happens BEFORE any agent work, so retrying once on a fresh id cannot double a
 * reply.
 */
function isSessionAlreadyExists(err: unknown): boolean {
  return err instanceof Error && /session .* already exists/i.test(err.message);
}

export interface DshBehaviorDeps {
  client: DshTurnClient;
  mirror: TranscriptMirror | null;
  /** Science Studio session key → the harness id this child actually created. */
  harnessSessions: Map<string, string>;
  provider: string;
  model: string;
  workspace: Workspace | null;
  onError?: (message: string, error: unknown) => void;
}

export function createDshBehavior(deps: DshBehaviorDeps): SessionBehavior<SessionEvent> {
  const { client, mirror, harnessSessions, provider, model, workspace } = deps;
  const log = deps.onError ?? ((message: string, error: unknown) => console.warn(`[dsh] ${message}`, error));
  /**
   * THIS child's harness id space (one generation per harness child — this
   * module is built once per adapter init). Every id the child asks for is
   * minted inside it, so a restart starts on a fresh id instead of one the
   * durable home already holds; turns within one child stay on the same id, so
   * the conversation continues for the life of the child.
   */
  const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  function applyEvent(event: SessionEvent, ctx: ApplyContext<SessionEvent>): ApplyResult | void {
    switch (event.type) {
      case "turn/start":
        if (ctx.state.status !== "running") ctx.emit({ type: "session-status", status: "running" });
        return;

      case "turn/end": {
        const reason = event.data.reason;
        const status = turnEndStatus(reason);
        if (ctx.state.status !== status) ctx.emit({ type: "session-status", status });
        return { settled: { status: runStatus(reason) } };
      }

      case "assistant/message": {
        const data = event.data;
        if (data.message.role !== "assistant") return;
        // Committed-event granularity: ONE whole message per step.
        if (!ctx.state.messages.some((m) => m.id === data.message.id)) {
          ctx.emit({
            type: "add-message",
            message: {
              id: data.message.id,
              role: "assistant",
              parts: contentToParts(data.message.content),
            },
          });
        }
        if (data.usage) ctx.run?.note({ usage: data.usage });
        return;
      }

      case "tool/result": {
        const data = event.data;
        const block = data.message.content[0];
        if (block?.type !== "tool-result") return;
        const owner = findToolCallMessage(ctx.state.messages, block.toolCallId);
        if (!owner) return;
        ctx.mergeToolCall({
          messageId: owner.id,
          toolCallId: block.toolCallId,
          result: extractResultText(data.message.content),
          isError: Boolean(data.error) || block.isError === true,
        });
        return;
      }

      default:
        // system/message, user/message, step/*, assistant/attempt, request/* —
        // no seam rendering.
        return;
    }
  }

  return {
    apply(event, ctx) {
      return applyEvent(event, ctx);
    },

    async prepare(handle) {
      // Cold start only: the SDK wire has no history-replay request, so restore
      // OUR mirror before reconciling (never reconcile an unverifiable empty
      // transcript against a claiming client — docs/adr/0004).
      if (handle.state.messages.length > 0 || !mirror) return;
      const loaded = await mirror.load(handle.sessionKey);
      if (loaded) handle.replaceMessages(loaded.messages, loaded.status);
    },

    dispatch(request, run) {
      const message = request.messages[0];
      if (!message) return;
      const prompt = promptWithAttachments(
        message.content,
        message.attachments,
        workspace ? { toAgentPath: (relPath) => workspace.toAgentPath(relPath) } : {},
      );
      void (async () => {
        try {
          // The id is scoped to this child generation, so it cannot collide
          // with what a previous harness process persisted in the home
          // (docs/adr/0004); later turns reuse the map entry, keeping ONE
          // harness conversation for the life of this child.
          let harnessSessionId =
            harnessSessions.get(request.sessionKey) ?? `${request.sessionKey}-${generation}`;
          try {
            await client.runTurn(harnessSessionId, prompt, (event) => run.ingest(event));
          } catch (err) {
            if (!isSessionAlreadyExists(err)) throw err;
            const collided = harnessSessionId;
            harnessSessionId = `${collided}-retry`;
            log(
              `harness session "${collided}" is already taken in this harness home; continuing on "${harnessSessionId}" (the agent does not carry the prior conversation across restarts — the Science Studio transcript mirror still does)`,
              err,
            );
            await client.runTurn(harnessSessionId, prompt, (event) => run.ingest(event));
          }
          harnessSessions.set(request.sessionKey, harnessSessionId);
          run.settle();
        } catch (err) {
          log("turn failed", err);
          run.emit({ type: "session-status", status: "error" });
          run.settle({ status: "error" });
        }
      })();
    },

    async beforePersist(ctx) {
      await mirror?.save(ctx.sessionKey, ctx.state.status, ctx.state.messages);
    },

    projectRun(ctx) {
      const usage = ctx.directive.usage;
      return {
        // A turn that never reported a terminal reason is an error Run.
        status: ctx.directive.status ?? "error",
        parameters: { provider, model, ...(usage !== undefined ? { usage } : {}) },
      };
    },

    watch: {
      /** A cold Session baselines asynchronously from our own mirror. */
      async readBaseline(sessionKey): Promise<WatchSnapshot | null> {
        if (!mirror) return null;
        const loaded = await mirror.load(sessionKey);
        if (!loaded) return null;
        return {
          status: loaded.status,
          messages: Object.fromEntries(loaded.messages.map((m) => [m.id, structuredClone(m)])),
        };
      },
    },
  };
}
