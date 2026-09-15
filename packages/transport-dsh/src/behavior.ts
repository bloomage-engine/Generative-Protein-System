/**
 * The dsh runtime-side policy: everything runtime-specific the shared
 * `SessionRuntime` does not know (docs/adr/0005).
 *
 * The kit owns the run loop, reconcile, settle pipeline, watch registry and Run
 * projection; this module supplies only the committed-event→delta mapping, the
 * launch surface (`runTurn` on a generation-scoped harness session id), and the hooks dsh
 * genuinely differs on: cold-start mirror restore, mirror durability at settle,
 * an async cold watch baseline, per-turn Run parameters, and the runtime commands
 * — the adapter's own two, plus the HARNESS's registry through the child command
 * bridge (docs/adr/0010, docs/adr/0011).
 * One prompt = one Harness turn = one persisted `Run`, for EVERY terminal
 * `turn/end` reason (failed turns are recorded too — docs/adr/0004). A command
 * line reaches no model and records no `Run`: a warm session's is executed by
 * the child's own registry over the bridge, and a cold one's rides the prompt
 * that CREATES its agent — which the child intercepts and rejects before any
 * model call (docs/adr/0011).
 */
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  isCommandText,
  promptWithAttachments,
  type ApplyContext,
  type ApplyResult,
  type CommandDescriptor,
  type RunControl,
  type SessionBehavior,
  type WatchSnapshot,
  type Workspace,
} from "@science-studio/transport";
import type { DshTurnClient } from "./client.js";
import type { TranscriptMirror } from "./mirror.js";
import {
  DSH_COMMANDS,
  executeDshCommand,
  harnessCommandReply,
  parseCommandLine,
  type DshCommandFacts,
  type DshHarnessCommands,
} from "./commands.js";
import { contentToParts, extractResultText, findToolCallMessage, runStatus, turnEndStatus } from "./mapping.js";

/** A reply row's id: the transcript is keyed by message id, so it must be unique. */
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
  /** Harness profile the child was launched with (reported by `/status`). */
  profile: string;
  provider: string;
  model: string;
  /** The agent's working directory, as launched (reported by `/status`). */
  cwd: string;
  workspace: Workspace | null;
  /** The harness's own command registry, through the child bridge (docs/adr/0011). */
  harnessCommands: DshHarnessCommands;
  /** The merged catalog — exactly what `listCommands()` publishes, for command replies. */
  commandCatalog: () => Promise<CommandDescriptor[]>;
  onError?: (message: string, error: unknown) => void;
}

export function createDshBehavior(deps: DshBehaviorDeps): SessionBehavior<SessionEvent> {
  const { client, mirror, harnessSessions, profile, provider, model, cwd, workspace, harnessCommands, commandCatalog } = deps;
  const log = deps.onError ?? ((message: string, error: unknown) => console.warn(`[dsh] ${message}`, error));
  /**
   * THIS child's harness id space (one generation per harness child — this
   * module is built once per adapter init). Every id the child asks for is
   * minted inside it, so a restart starts on a fresh id instead of one the
   * durable home already holds; turns within one child stay on the same id, so
   * the conversation continues for the life of the child.
   */
  const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  /**
   * Harness sessions this child has minted per Science Studio session. The
   * ordinal (not the session key) is what keeps a LATER mint out of the ids the
   * durable home already holds: `/new` drops the current conversation, and the
   * id it then asks for must be one this child has never created — re-asking
   * would come back as `session "<id>" already exists` (docs/adr/0004).
   */
  const minted = new Map<string, number>();

  /** The next harness session id for one Science Studio session. */
  function nextHarnessSessionId(sessionKey: string): string {
    const ordinal = (minted.get(sessionKey) ?? 0) + 1;
    minted.set(sessionKey, ordinal);
    return `${sessionKey}-${generation}-${ordinal}`;
  }

  /**
   * The COLD command prompt in flight, per Science Studio session: the line the
   * harness is being asked to run as this session's first prompt, the reply owed
   * if its registry resolves nothing, and what the turn reported. It is what
   * tells the folded `command/done` apart from the one a WARM command produces
   * (that path renders the bridge's own result text), and what decides whether
   * an unresolved line still owes the user a reply.
   */
  const coldCommands = new Map<
    string,
    { name: string; unknownReply: string; resolved: boolean; endReason: string | null }
  >();

  /**
   * Drive one prompt on this Session's harness conversation, minting the id on
   * first use and re-minting once if the harness home already holds it (a
   * collision the pin makes possible in the same instant — docs/adr/0004).
   */
  async function driveTurn(sessionKey: string, text: string, run: RunControl<SessionEvent>): Promise<void> {
    let harnessSessionId = harnessSessions.get(sessionKey) ?? nextHarnessSessionId(sessionKey);
    try {
      await client.runTurn(harnessSessionId, text, (event) => run.ingest(event));
    } catch (err) {
      if (!isSessionAlreadyExists(err)) throw err;
      const collided = harnessSessionId;
      harnessSessionId = `${collided}-retry`;
      log(
        `harness session "${collided}" is already taken in this harness home; continuing on "${harnessSessionId}" (the agent does not carry the prior conversation across restarts — the Science Studio transcript mirror still does)`,
        err,
      );
      await client.runTurn(harnessSessionId, text, (event) => run.ingest(event));
    }
    harnessSessions.set(sessionKey, harnessSessionId);
  }

  /**
   * Answer one runtime command (docs/adr/0003, docs/adr/0010, docs/adr/0011).
   *
   * The LOCAL layer answers from this adapter's own state; every other name is
   * the harness's own registry — executed in the child when this session HAS an
   * agent, and driven as the session's first prompt when it does not (the
   * child's bridge plugin then runs the line and rejects the step, so the model
   * is never called). No path prompts the MODEL, and each ends in one assistant
   * row — so `projectRun` projects nothing for a command input and the settle
   * pipeline records no `Run`. It is async because a harness command can take
   * real time (`/compact` runs a model turn of its own); the kit awaits the
   * settle pipeline before ending the run stream.
   */
  async function answerCommand(line: string, sessionKey: string, run: RunControl<SessionEvent>): Promise<void> {
    const facts: DshCommandFacts = {
      sessionKey,
      profile,
      provider,
      model,
      cwd,
      harnessSessionId: harnessSessions.get(sessionKey) ?? null,
    };
    const parsed = parseCommandLine(line);
    const local = parsed ? DSH_COMMANDS.find((candidate) => candidate.descriptor.id === parsed.name) : undefined;
    let reply: string;
    let resetConversation = false;
    if (!parsed || local) {
      // A malformed line, or a name this adapter owns: answered here, with no
      // bridge call and no child start.
      const result = executeDshCommand(line, facts);
      reply = result.reply;
      resetConversation = result.resetConversation === true;
    } else {
      try {
        const outcome = await harnessCommands.execute(harnessSessions.get(sessionKey) ?? null, line.trim());
        if (outcome.status === "cold") {
          // This session has no agent yet, and the only verb that creates one is
          // a prompt — so the line becomes its first (docs/adr/0011). A name
          // this runtime does not publish is answered here instead: creating an
          // agent for a line the harness would not resolve would buy nothing.
          const descriptors = await commandCatalog();
          if (descriptors.some((descriptor) => descriptor.id === parsed.name)) {
            await runColdCommand(line.trim(), parsed.name, sessionKey, run, descriptors);
            return;
          }
          reply = harnessCommandReply({ status: "unknown" }, parsed.name, descriptors);
        } else {
          // The catalog is read only where the reply needs it (an unknown name),
          // so an executing command pays no extra bridge round-trip.
          const descriptors = outcome.status === "unknown" ? await commandCatalog() : [];
          reply = harnessCommandReply(outcome, parsed.name, descriptors);
        }
      } catch (err) {
        // A throw must never escape into the run stream.
        log("harness command failed", err);
        reply = harnessCommandReply({ status: "unavailable", message: String(err) }, parsed.name, []);
      }
    }
    if (resetConversation) harnessSessions.delete(sessionKey);
    run.emit({
      type: "add-message",
      message: { id: newId(), role: "assistant", parts: [{ type: "text", text: reply }] },
    });
    run.emit({ type: "session-status", status: "idle" });
    // Not a research turn (docs/adr/0003): `projectRun` projects nothing for a
    // command line, so the settle pipeline records no `Run` — it still saves the
    // mirror and notifies watchers, so the command rows survive a reload.
    run.settle();
  }

  /**
   * Drive one harness command line as this session's FIRST prompt.
   *
   * The registry is agent-scoped and a prompt is the only agent-creating verb on
   * the SDK wire, so this is what makes a command usable on a session that has
   * never prompted (and after `/new`): the agent now exists, and whatever the
   * command set up — plan mode, a goal, a permission preset — is in force before
   * the conversation's first model request. The child's bridge plugin runs the
   * line and REJECTS the step, so the model never sees it and the turn ends
   * `blocked`; the harness's own `command/done` event is the reply row, and
   * `unknownReply` covers a line its registry does not resolve (see `applyEvent`).
   */
  async function runColdCommand(
    line: string,
    name: string,
    sessionKey: string,
    run: RunControl<SessionEvent>,
    descriptors: readonly CommandDescriptor[],
  ): Promise<void> {
    const pending = {
      name,
      unknownReply: harnessCommandReply({ status: "unknown" }, name, descriptors),
      resolved: false,
      endReason: null as string | null,
    };
    coldCommands.set(sessionKey, pending);
    try {
      await driveTurn(sessionKey, line, run);
      run.settle();
    } catch (err) {
      log("cold command failed", err);
      run.emit({ type: "session-status", status: "error" });
      run.settle({ status: "error" });
    } finally {
      coldCommands.delete(sessionKey);
    }
  }

  function applyEvent(event: SessionEvent, ctx: ApplyContext<SessionEvent>): ApplyResult | void {
    // The harness's registry settled one command. `command/*` is a
    // `@deepseek-ai/dsh-commands` merge-extension this package does not import
    // (the child has it, we do not), so the event is matched by name instead of
    // by the switch's discriminant. Only the COLD path renders from here: a warm
    // command is answered with the bridge's own returned text, and rendering
    // both would double the row.
    const settled = event as unknown as { type?: string; data?: { kind?: "success" | "error"; text?: string } };
    if (settled.type === "command/done" && settled.data) {
      const cold = coldCommands.get(ctx.sessionKey);
      if (!cold) return;
      cold.resolved = true;
      const { kind, text } = settled.data;
      ctx.emit({
        type: "add-message",
        message: {
          id: newId(),
          role: "assistant",
          parts: [
            {
              type: "text",
              text: harnessCommandReply(
                { status: "ok", kind: kind === "error" ? "error" : "success", ...(text === undefined ? {} : { text }) },
                cold.name,
                [],
              ),
            },
          ],
        },
      });
      return;
    }
    switch (event.type) {
      case "turn/start":
        if (ctx.state.status !== "running") ctx.emit({ type: "session-status", status: "running" });
        return;

      case "turn/end": {
        const reason = event.data.reason;
        const cold = coldCommands.get(ctx.sessionKey);
        if (cold) {
          cold.endReason = reason.kind;
          // The step was rejected, so no model saw the line — but the registry
          // resolved nothing, which is the one thing the curated cold catalog
          // can get wrong. Answer it HERE, while this Run's flow is still
          // draining: a delta emitted after the terminal event would fold into
          // the transcript without ever streaming to the client.
          if (!cold.resolved && reason.kind === "blocked") {
            ctx.emit({
              type: "add-message",
              message: {
                id: newId(),
                role: "assistant",
                parts: [{ type: "text", text: cold.unknownReply }],
              },
            });
          }
        }
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
      // A runtime command never reaches the MODEL (docs/adr/0003, docs/adr/0010,
      // docs/adr/0011): the local layer is answered here, a warm session's goes
      // to the child's registry over the bridge, and a cold session's becomes
      // its first prompt (which the child intercepts and rejects before any
      // model call). The returned promise is deliberately not awaited: the kit
      // awaits the settle pipeline, so a slow harness command keeps the run
      // stream open instead of blocking dispatch.
      if (isCommandText(message.content)) {
        void answerCommand(message.content, request.sessionKey, run);
        return;
      }
      const prompt = promptWithAttachments(
        message.content,
        message.attachments,
        workspace ? { toAgentPath: (relPath) => workspace.toAgentPath(relPath) } : {},
      );
      void (async () => {
        try {
          await driveTurn(request.sessionKey, prompt, run);
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
      // A command is not a research turn (docs/adr/0003): the driving `/cmd`
      // row is the Run's input, so it is exactly the marker to project nothing.
      if (isCommandText(ctx.input)) return null;
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
