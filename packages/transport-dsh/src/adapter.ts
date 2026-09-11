import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionRuntime,
  type RecordStoreLike,
  type RuntimeAdapter,
  type RuntimeFactory,
  type RuntimeInitOptions,
  type SessionBehavior,
  type SessionState,
  type StateDelta,
  type TransportCommand,
  type WatchSnapshot,
} from "@science-studio/transport";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { createDshTurnClient, type DshClientLaunchOptions, type DshTurnClient } from "./client.js";
import { DSH_CAPABILITIES, parseDshBinding, type DshBinding } from "./binding.js";
import { TranscriptMirror } from "./mirror.js";
import { createDshBehavior } from "./behavior.js";

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
 *   `approve()` is absent and `listCommands` is omitted.
 * - Cold start restores each session's canonical transcript from Science
 *   Studio's OWN mirror file (not dsh's internal session log — see
 *   docs/adr/0004).
 *
 * The run lifecycle lives in the shared kit `SessionRuntime` (docs/adr/0005);
 * this adapter holds one runtime per session and supplies the dsh behavior.
 */
export class DshRuntimeAdapter implements RuntimeAdapter {
  runtime = "dsh";
  private readonly createClient: (options: DshClientLaunchOptions) => DshTurnClient;
  private readonly transcriptDir: string;
  private client: DshTurnClient | null = null;
  private recordStore: RecordStoreLike | null = null;
  private mirror: TranscriptMirror | null = null;
  private ready: Promise<void> | null = null;
  /** This adapter's parsed launch surface (private to the dsh binding). */
  private binding: DshBinding = {};
  /** One shared run lifecycle per Session (docs/adr/0005). */
  private runtimes = new Map<string, SessionRuntime<SessionEvent>>();
  private behavior: SessionBehavior<SessionEvent> | null = null;
  /**
   * Science Studio session key → the harness session id this child process
   * actually created for it. Filled only when the requested id was NOT
   * creatable (see behavior.ts); lets later turns continue the SAME fresh
   * harness conversation for the life of this child.
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
    this.behavior = createDshBehavior({
      client: this.client,
      mirror: this.mirror,
      harnessSessions: this.harnessSessions,
      provider,
      model,
      workspace: opts.workspace ?? null,
    });
  }

  async *run(session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta> {
    await this.ensureStarted();
    yield* this.runtimeFor(session.sessionId).run(session, commands);
  }

  /**
   * Abort in-flight runs. There is no wire-level cancel on the SDK protocol (a
   * timed-out request keeps running server-side), so aborting stops the client
   * stream but the harness finishes the turn in the background; the transcript
   * keeps folding its events and the Run is still persisted when it settles
   * (docs/adr/0004 — failed or interrupted turns are recorded).
   */
  abort(reason?: string): void {
    for (const runtime of this.runtimes.values()) runtime.abort(reason);
  }

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
   * change after a watcher attached (a run settling here or on another client),
   * so the sink gets a baseline and then one push per settled run.
   */
  subscribe(sessionKey: string, sink: (snapshot: WatchSnapshot) => void): () => void {
    return this.runtimeFor(sessionKey).subscribe(sink);
  }

  // No `approve()`: the SDK runtime has no approval surface (docs/adr/0004), so
  // the optional method is simply absent and `capabilities.approvals` is false.

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

  private runtimeFor(sessionKey: string): SessionRuntime<SessionEvent> {
    if (!this.behavior) throw new Error("dsh adapter not initialized");
    let runtime = this.runtimes.get(sessionKey);
    if (!runtime) {
      runtime = new SessionRuntime<SessionEvent>(sessionKey, this.behavior, {
        ...(this.recordStore ? { recordStore: this.recordStore } : {}),
      });
      this.runtimes.set(sessionKey, runtime);
    }
    return runtime;
  }
}

/**
 * The dsh runtime factory — the ONLY registration surface the service needs.
 * Adding or replacing a runtime never edits a core package: the service
 * registers factories from configuration (docs/design/implementation-plan.md §5).
 */
export function createDshRuntimeFactory(): RuntimeFactory {
  return {
    runtime: "dsh",
    capabilities: DSH_CAPABILITIES,
    create: () => new DshRuntimeAdapter(),
  };
}
