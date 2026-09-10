import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunFlow,
  promptWithAttachments,
  userMessageParts,
  type RecordStoreLike,
  type RuntimeAdapter,
  type RuntimeFactory,
  type RuntimeInitOptions,
  type SessionState,
  type StateDelta,
  type TransportCommand,
  type WatchSnapshot,
  type Workspace,
} from "@science-studio/transport";
import type { Run } from "@science-studio/record";
import { createDshTurnClient, type DshClientLaunchOptions, type DshTurnClient } from "./client.js";
import { DSH_CAPABILITIES, parseDshBinding, type DshBinding } from "./binding.js";
import { TranscriptMirror } from "./mirror.js";
import { DshTranscript } from "./transcript.js";
import { runOutput, runStatus, Turn } from "./turn.js";

const DEFAULT_PROVIDER = "deepseek-official";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_PROFILE = "sdk";

/**
 * assistant-ui's in-memory thread list mints a per-page LOCAL thread id when
 * the app never declares a real remote session, and sends carry that id while
 * the mount probe sends none. Both must land on the SAME canonical session,
 * so local-mint ids resolve to the configured default session.
 */
const ASSISTANT_UI_LOCAL_THREAD_PREFIX = "__LOCALID_";

/**
 * The SDK runtime's create-only `session/prompt` rejects an id that a PREVIOUS
 * harness process already persisted in the home with `session "<id>" already
 * exists` (a plain internal error surfaced as a JSON-RPC error response — the
 * SDK wire has no structured code for it). This is the ONE failure we can
 * retry on: it happens BEFORE any agent work, so re-prompting a fresh session
 * cannot double a reply.
 */
function isSessionAlreadyExists(err: unknown): boolean {
  return err instanceof Error && /session .* already exists/i.test(err.message);
}

/** A fresh, child-scoped harness session id (never persisted before this child). */
function mintHarnessSessionId(sessionKey: string): string {
  return `${sessionKey}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface DshRuntimeAdapterOptions {
  /**
   * Test seam: inject the turn-client factory (defaults to the real SDK
   * client, which spawns `dsh --profile sdk`). Lets a harness drive `run()`
   * against a scripted runtime, mirroring the openclaw adapter's
   * `createGateway` seam.
   */
  createClient?: (options: DshClientLaunchOptions) => DshTurnClient;
  /** Override the canonical-transcript mirror directory (tests use a tmp dir). */
  transcriptDir?: string;
}

/**
 * dsh (DeepSeek Harness) runtime adapter. Unlike the openclaw adapter — which
 * connects to a remote gateway — this adapter drives a LOCAL harness spawned
 * by `@deepseek-ai/dsh-sdk-client` (a `dsh --profile sdk` child speaking stdio
 * JSON-RPC; see docs/adr/0004). Mapping summary:
 *
 * - One `run()` prompt = one Harness turn = one persisted `Run`, for EVERY
 *   terminal `turn/end` reason (failed turns are recorded too — a deliberate
 *   deviation from openclaw, which only persists settled runs).
 * - Content arrives as committed per-step `assistant/message` events (no token
 *   stream on the SDK wire), so deltas are message/step-granular.
 * - The SDK has no approval/ask-user surface and no runtime command catalog;
 *   `approve()` is a no-op and `listCommands` is omitted.
 * - Cold start restores each session's canonical transcript from Science
 *   Studio's OWN mirror file (not dsh's internal session log — see
 *   docs/adr/0004).
 */
export class DshRuntimeAdapter implements RuntimeAdapter {
  runtime = "dsh";
  private readonly createClient: (options: DshClientLaunchOptions) => DshTurnClient;
  private readonly transcriptDir: string;
  private client: DshTurnClient | null = null;
  private recordStore: RecordStoreLike | null = null;
  /** The session's workspace (seam, §5); used for attachment refs in Phase 2. */
  private workspace: Workspace | null = null;
  /** This adapter's parsed launch surface (private to the dsh binding). */
  private binding: DshBinding = {};
  private transcripts = new Map<string, DshTranscript>();
  private mirror: TranscriptMirror | null = null;
  private ready: Promise<void> | null = null;
  private activeFlows = new Map<string, RunFlow>();
  /** Standing watchers per session (the transport-service watch endpoint). */
  private watch = new Map<string, Set<(s: WatchSnapshot) => void>>();
  /**
   * Science Studio session key → the harness session id this child process
   * actually created for it. Filled only when the requested id was NOT
   * creatable (see run()); lets later turns continue the SAME fresh harness
   * conversation for the life of this child.
   */
  private harnessSessions = new Map<string, string>();
  private provider = DEFAULT_PROVIDER;
  private model = DEFAULT_MODEL;

  constructor(options: DshRuntimeAdapterOptions = {}) {
    this.createClient = options.createClient ?? createDshTurnClient;
    this.transcriptDir = options.transcriptDir ?? "";
  }

  async init(opts: RuntimeInitOptions): Promise<void> {
    this.recordStore = opts.recordStore;
    this.workspace = opts.workspace ?? null;
    const binding = parseDshBinding(opts.binding);
    this.binding = binding;

    // The binding is the launch surface; process.env is a single-user fallback
    // for keys the binding leaves unset.
    const env = (key: string): string | undefined => process.env[key];
    const profile = binding.profile ?? env("DSH_PROFILE") ?? DEFAULT_PROFILE;
    const dshHome = binding.home ?? env("DSH_HOME");
    const cwd = binding.workspace ?? env("DSH_WORKSPACE") ?? process.cwd();
    const provider = binding.provider ?? env("DSH_PROVIDER") ?? DEFAULT_PROVIDER;
    const model = binding.model ?? env("DSH_MODEL") ?? DEFAULT_MODEL;
    const maxTokens = binding.maxTokens;
    const dir =
      this.transcriptDir ||
      binding.transcriptDir ||
      env("DSH_TRANSCRIPT_DIR") ||
      join(tmpdir(), "science-studio", "transcripts");

    this.client = this.createClient({ profile, dshHome, cwd, provider, model, maxTokens });
    this.mirror = new TranscriptMirror(dir);
    this.provider = provider;
    this.model = model;
  }

  /**
   * Ensure the harness child is up (lazily, on first use). A failed start is
   * forgotten so the NEXT run retries with a fresh spawn instead of wedging
   * the adapter.
   */
  private ensureStarted(): Promise<void> {
    if (!this.client) return Promise.reject(new Error("dsh adapter not initialized"));
    if (!this.ready) {
      this.ready = this.client.start().catch((err: unknown) => {
        this.ready = null;
        console.error("[dsh] runtime start failed (check DSH_HOME/DSH_PROFILE and the LLM credentials)", err);
        throw new Error(`dsh runtime not ready: ${String(err)}`);
      });
    }
    return this.ready;
  }

  private async transcriptFor(session: SessionState): Promise<DshTranscript> {
    let transcript = this.transcripts.get(session.sessionId);
    if (!transcript) {
      transcript = new DshTranscript(session.sessionId, session);
      this.transcripts.set(session.sessionId, transcript);
    }
    return transcript;
  }

  async *run(session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta> {
    await this.ensureStarted();
    const sessionKey = session.sessionId;
    const transcript = await this.transcriptFor(session);
    // Cold start: the in-memory transcript is gone (service restart) but the
    // client may still claim history. Restore OUR mirror before reconciling —
    // never reconcile an unverifiable empty transcript against a claiming
    // client, which would wipe it.
    if (transcript.state.messages.length === 0 && this.mirror) {
      const mirror = await this.mirror.load(sessionKey);
      if (mirror) transcript.restore(mirror.messages, mirror.status);
    }

    // Reconcile this client against the canonical transcript first (history on
    // load, and after reloads).
    yield transcript.snapshot();

    const sends = commands.filter((c) => c.type === "add-message");
    if (sends.length === 0) {
      // Nothing to drive (mount/history probe): terminate so the client's
      // stream settles instead of hanging on an open SSE connection.
      const probe = new RunFlow();
      transcript.attachFlow(probe);
      try {
        probe.end();
        yield* probe.iterate();
      } finally {
        transcript.detachFlow(probe);
      }
      return;
    }

    const first = sends[0]!;
    const rest = sends.slice(1);
    const turn = new Turn({
      userMessageId: first.message.id,
      input: first.message.content,
      startedAt: new Date().toISOString(),
    });
    transcript.attachFlow(turn.flow);
    this.activeFlows.set(sessionKey, turn.flow);
    const userMsg = {
      id: first.message.id,
      role: "user" as const,
      // Workspace attachments become `file` parts so the UI shows a chip
      // immediately; the agent gets the paths in the prompt below.
      parts: userMessageParts(first.message.content, first.message.attachments),
    };
    transcript.emit({ type: "add-message", message: userMsg });
    transcript.emit({ type: "session-status", status: "running" });
    for (const extra of rest) {
      // Echo extra queued messages so the UI shows them, but dsh drives one
      // prompt per turn: log instead of silently dropping the reply.
      console.warn("[dsh] extra queued message not prompted (one prompt per run):", extra.message.content);
      transcript.emit({
        type: "add-message",
        message: {
          id: extra.message.id,
          role: "user",
          parts: userMessageParts(extra.message.content, extra.message.attachments),
        },
      });
    }
    // The driving user row (and any echoed extras) have landed; assistant rows
    // appended from here on belong to this turn.
    turn.setBaseline(transcript.state.messages.length);
    // The settle step persists the Run AND refreshes the mirror. It starts at
    // settle time (near-terminal transcript slice) and is awaited once the
    // flow has drained, so a normal run only returns after the record is
    // durable. An aborted stream that ends before settle keeps today's
    // background persist (the harness finishes the turn in the background).
    let persist: Promise<void> | null = null;
    const settle = (): void => {
      if (turn.isEnded()) return;
      turn.end();
      persist = this.settleRun(sessionKey, transcript, turn);
    };
    const workspace = this.workspace;
    const prompt = promptWithAttachments(
      first.message.content,
      first.message.attachments,
      workspace ? { toAgentPath: (relPath) => workspace.toAgentPath(relPath) } : {},
    );
    const runPrompt = (harnessSessionId: string): Promise<void> =>
      this.client!.runTurn(harnessSessionId, prompt, (event) => {
        turn.note(transcript.apply(event));
      });
    void (async () => {
      try {
        // Prefer the session key itself (a clean home creates it on first
        // use). But the SDK's `session/prompt` is CREATE-ONLY: a session id
        // a PREVIOUS harness process already persisted in the home can never
        // be created again (docs/adr/0004), so on that specific failure fall
        // back to a fresh child-scoped id and retry ONCE instead of letting
        // the whole turn die.
        let harnessSessionId = this.harnessSessions.get(sessionKey) ?? sessionKey;
        try {
          await runPrompt(harnessSessionId);
        } catch (err) {
          if (!isSessionAlreadyExists(err)) throw err;
          harnessSessionId = mintHarnessSessionId(sessionKey);
          this.harnessSessions.set(sessionKey, harnessSessionId);
          console.warn(
            `[dsh] harness session "${sessionKey}" already exists in a previous runtime and this SDK cannot resume it; continuing on a fresh harness session "${harnessSessionId}" (the agent does not carry the prior conversation across restarts — the Science Studio transcript mirror still does)`,
          );
          await runPrompt(harnessSessionId);
        }
        this.harnessSessions.set(sessionKey, harnessSessionId);
        settle();
      } catch (err) {
        console.error("[dsh] turn failed", err);
        transcript.emit({ type: "session-status", status: "error" });
        settle();
      }
    })();
    try {
      yield* turn.flow.iterate();
      if (persist) await persist;
    } finally {
      transcript.detachFlow(turn.flow);
      this.activeFlows.delete(sessionKey);
    }
  }

  /** Persist the Run for one settled turn and refresh the transcript mirror. */
  private async settleRun(
    sessionKey: string,
    transcript: DshTranscript,
    turn: Turn,
  ): Promise<void> {
    try {
      const state = transcript.state;
      const run: Run = {
        id: turn.userMessageId,
        taskId: sessionKey,
        sessionId: sessionKey,
        status: runStatus(turn.reason),
        agentId: state.agentId,
        parameters: {
          provider: this.provider,
          model: this.model,
          ...(turn.usage ? { usage: turn.usage } : {}),
        },
        input: turn.input,
        output: runOutput(state.messages, turn.baseline),
        startedAt: turn.startedAt,
        finishedAt: new Date().toISOString(),
      };
      if (this.recordStore) {
        try {
          await this.recordStore.addRun(run);
        } catch (err) {
          console.warn("[dsh] failed to persist run", err);
        }
      }
      await this.mirror?.save(sessionKey, state.status, state.messages);
      // Watchers that attached before this session had any content (cold), or
      // that sit idle on another client, now converge on the settled
      // transcript.
      this.notifySettled(sessionKey);
    } catch (err) {
      // Never let a persist failure escape into the run stream: settle is
      // awaited post-drain, and a throw would abort the client SSE mid-run.
      console.warn("[dsh] failed to settle run", err);
    }
  }

  /**
   * Abort in-flight runs. There is no wire-level cancel on the SDK protocol
   * (a timed-out request keeps running server-side), so aborting stops the
   * client stream but the harness finishes the turn in the background; the
   * transcript keeps folding its events and the Run is still persisted when it
   * settles (docs/adr/0004 — failed or interrupted turns are recorded).
   */
  abort(_reason?: string): void {
    for (const flow of this.activeFlows.values()) flow.end();
  }

  // No `approve()`: the SDK runtime has no approval surface (docs/adr/0004), so
  // the optional method is simply absent and `capabilities.approvals` is false.

  /**
   * The canonical session key a client `threadId` targets. Any stable id the
   * client chose passes through (the SDK lazily creates the session); ids the
   * assistant-ui framework mints locally (`__LOCALID_*`) and an absent id
   * (mount probe) fall back to the configured default session so probes and
   * sends converge (see the seam doc on `RuntimeAdapter.resolveSessionKey`).
   */
  resolveSessionKey(threadId: string | null): string {
    if (threadId !== null && !threadId.startsWith(ASSISTANT_UI_LOCAL_THREAD_PREFIX)) return threadId;
    return this.binding.defaultSession ?? process.env.DSH_DEFAULT_SESSION ?? "default";
  }

  /**
   * Standing watch: dsh sessions have a single writer (this adapter), so there
   * are no REMOTE settles to observe — but the canonical transcript can still
   * change after a watcher attached (a run settling on this or another
   * client), so the sink gets a baseline and then one push per settled run.
   *
   * Baseline honesty: a warm session pushes synchronously on attach; a COLD
   * session (e.g. right after a service restart, before any client ran) has no
   * in-memory transcript, so the baseline is read from our own mirror
   * asynchronously — a watcher never hangs on an open stream with content
   * already on disk. With no transcript AND no mirror yet, the watcher simply
   * waits for the first settle (the next run drives one) instead of hanging
   * forever.
   */
  subscribe(sessionKey: string, sink: (snapshot: WatchSnapshot) => void): () => void {
    let set = this.watch.get(sessionKey);
    if (!set) {
      set = new Set();
      this.watch.set(sessionKey, set);
    }
    let alive = true;
    set.add(sink);
    const transcript = this.transcripts.get(sessionKey);
    if (transcript) {
      sink(this.snapshotOf(transcript));
    } else {
      void this.mirror?.load(sessionKey).then((m) => {
        if (!alive || !m) return;
        sink({
          status: m.status,
          messages: Object.fromEntries(m.messages.map((msg) => [msg.id, structuredClone(msg)])),
        });
      }).catch(() => {
        // Cold baseline is best-effort: the first settle will push anyway.
      });
    }
    return () => {
      alive = false;
      const watchers = this.watch.get(sessionKey);
      if (!watchers) return;
      watchers.delete(sink);
      if (watchers.size === 0) this.watch.delete(sessionKey);
    };
  }

  private snapshotOf(transcript: DshTranscript): WatchSnapshot {
    return {
      status: transcript.state.status,
      messages: Object.fromEntries(transcript.state.messages.map((m) => [m.id, structuredClone(m)])),
    };
  }

  /** Push the current canonical transcript to a session's standing watchers. */
  private notifySettled(sessionKey: string): void {
    const transcript = this.transcripts.get(sessionKey);
    const watchers = this.watch.get(sessionKey);
    if (!transcript || !watchers || watchers.size === 0) return;
    const snapshot = this.snapshotOf(transcript);
    for (const sink of watchers) sink(snapshot);
  }
}

/**
 * The dsh runtime factory — the ONLY registration surface the service needs.
 * Adding or replacing a runtime never edits a core package (see
 * docs/design/implementation-plan.md §5).
 */
export function createDshRuntimeFactory(): RuntimeFactory {
  return {
    runtime: "dsh",
    capabilities: DSH_CAPABILITIES,
    create: () => new DshRuntimeAdapter(),
  };
}

export * from "./binding.js";
