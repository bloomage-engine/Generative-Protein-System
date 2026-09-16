import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SessionRuntime,
  isCommandText,
  type CommandDescriptor,
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
import {
  DSH_COMMAND_DESCRIPTORS,
  DSH_HARNESS_FALLBACK_DESCRIPTORS,
  mergeCommandDescriptors,
  type DshHarnessCommands,
  type HarnessCommandOutcome,
} from "./commands.js";
import {
  bridgeSocketPath,
  createCommandBridge,
  writeBridgePatch,
  writeProjectPatch,
  type DshCommandBridge,
} from "./bridge.js";
import { TranscriptMirror } from "./mirror.js";
import { createDshBehavior } from "./behavior.js";
import { applyRouteSettings } from "./route-settings.js";

const DEFAULT_PROVIDER = "deepseek-official";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_PROFILE = "sdk";

/** Freshness window for the cached HARNESS command catalog (`listCommands`). */
const COMMAND_CATALOG_TTL_MS = 60_000;

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
  /**
   * The child-side bridge plugin this adapter's launch patch mounts. Defaults to
   * this package's own build output (`dist/bridge-plugin.js`), so the child
   * loads the plugin from the SAME release as the adapter that wrote the patch.
   */
  bridgePluginPath?: string;
  /**
   * The child-side project plugin this adapter's launch patch mounts — the
   * research scaffold and the Project Brief (docs/adr/0012). Defaults to this
   * package's own build output, so the child runs the SAME release as the
   * adapter that wrote the patch.
   */
  projectPluginPath?: string;
  /** Where the socket and its launch patch live (default under the temp dir). */
  bridgeDir?: string;
  /** Test seam: inject the bridge client (defaults to the real socket client). */
  createBridge?: (endpoint: string) => DshCommandBridge;
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
 * - The SDK has no approval/ask-user surface and no command PLANE: `approve()`
 *   is absent, and `listCommands()` merges the small catalog THIS adapter
 *   answers itself (`/status`, `/new` — see commands.ts and docs/adr/0010) with
 *   the harness's OWN registry, which the child-side bridge plugin exposes over
 *   a private socket mounted by a per-launch profile patch (docs/adr/0011).
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
   * Science Studio session key → the harness session id this child generation
   * created for it. Ids are generation-scoped (a previous harness process can
   * never hand its session over — docs/adr/0004), so this map is what keeps
   * every turn of THIS child on the same harness conversation.
   */
  private harnessSessions = new Map<string, string>();
  private provider = DEFAULT_PROVIDER;
  private model = DEFAULT_MODEL;
  private readonly bridgePluginPath: string;
  private readonly projectPluginPath: string;
  private readonly bridgeDir: string;
  private readonly createBridge: (endpoint: string) => DshCommandBridge;
  /** This child generation's command bridge, or `null` when it could not be set up. */
  private bridge: DshCommandBridge | null = null;
  /** Cached HARNESS catalog (see `listHarnessCommands`). */
  private harnessCatalog: { fetchedAt: number; descriptors: CommandDescriptor[] } | null = null;
  private harnessCatalogInflight: Promise<CommandDescriptor[]> | null = null;
  /**
   * Settles when `init` RETURNED — success or failure. The composition builds a
   * Project's Environment lazily and starts `init` in the BACKGROUND
   * (docs/adr/0008), so the request that first names a Project can beat it;
   * every entry point that needs the behavior waits here instead of failing.
   */
  private readonly initialized: Promise<void>;
  private markInitialized!: () => void;
  /** Why {@link init} failed, re-thrown to the requests that waited for it. */
  private initFailure: unknown = null;

  constructor(options: DshRuntimeAdapterOptions = {}) {
    this.createClient = options.createClient ?? createDshTurnClient;
    this.transcriptDir = options.transcriptDir ?? "";
    this.bridgePluginPath =
      options.bridgePluginPath ?? fileURLToPath(new URL("./bridge-plugin.js", import.meta.url));
    this.projectPluginPath =
      options.projectPluginPath ?? fileURLToPath(new URL("./project-plugin.js", import.meta.url));
    this.bridgeDir = options.bridgeDir ?? join(tmpdir(), "science-studio", "dsh-bridge");
    this.createBridge = options.createBridge ?? createCommandBridge;
    this.initialized = new Promise<void>((resolve) => {
      this.markInitialized = resolve;
    });
  }

  /**
   * The harness's own commands as the behavior sees them: the bridge, cached,
   * with readiness. `list()` never starts a child; `execute()` does, because a
   * user-issued command is a deliberate request to use the runtime — and a
   * session with no agent yet is handed back as `cold` so the behavior can
   * drive the line as that session's first prompt (docs/adr/0011).
   */
  private readonly harnessCommands: DshHarnessCommands = {
    list: () => this.listHarnessCommands(),
    execute: (sessionId, line) => this.executeHarnessCommand(sessionId, line),
  };

  async init(opts: RuntimeInitOptions): Promise<void> {
    try {
      await this.initialize(opts);
    } catch (err) {
      // A failed init is remembered: the requests that waited for it get the
      // real reason instead of "not initialized".
      this.initFailure = err;
      throw err;
    } finally {
      this.markInitialized();
    }
  }

  /** The body of {@link init}; the wrapper settles every waiter either way. */
  private async initialize(opts: RuntimeInitOptions): Promise<void> {
    this.recordStore = opts.recordStore;
    const binding = parseDshBinding(opts.binding);
    this.binding = binding;

    // The binding is the launch surface; process.env is a single-user fallback
    // for keys the binding leaves unset.
    const env = (key: string): string | undefined => process.env[key];
    const profile = binding.profile ?? env("DSH_PROFILE") ?? DEFAULT_PROFILE;
    const dshHome = binding.home ?? env("DSH_HOME");
    // The agent's working directory MUST be the active Project's workspace —
    // the SAME place the Files browser lists (composition's
    // `localWorkspace` → `FsWorkspace` rooted at `<PROJECT_ROOT>/<projectId>`).
    // Deriving it from the workspace seam (`toAgentPath("")`) is what keeps
    // "where the agent writes" == "where the browser lists" per Project.
    // `binding.workspace`/`DSH_WORKSPACE` is a standalone override for callers
    // who pass no workspace (the dsh example app), and `process.cwd()` the
    // last resort. Using the raw env var here was the foot-gun: it pointed at
    // the Project PARENT, so the agent wrote into `<PROJECT_ROOT>` while the
    // browser listed the (empty) `<PROJECT_ROOT>/<projectId>` subdir.
    //
    // A `NullWorkspace` (no `PROJECT_ROOT` configured) has no agent view — it
    // answers `""` — and an empty answer is NOT a launchable cwd, so it falls
    // through to the standalone chain rather than winning it.
    const agentCwd = opts.workspace?.toAgentPath("");
    const cwd =
      (agentCwd ? agentCwd : undefined) ??
      binding.workspace ??
      env("DSH_WORKSPACE") ??
      process.cwd();
    const provider = binding.provider ?? env("DSH_PROVIDER") ?? DEFAULT_PROVIDER;
    const model = binding.model ?? env("DSH_MODEL") ?? DEFAULT_MODEL;
    const maxTokens = binding.maxTokens;
    const dir =
      this.transcriptDir ||
      binding.transcriptDir ||
      env("DSH_TRANSCRIPT_DIR") ||
      join(tmpdir(), "science-studio", "transcripts");

    // The command bridge is a launch-artifact PAIR: a socket path and the
    // profile patch that mounts the plugin listening on it. Both are
    // best-effort — if either fails (an unwritable temp dir, a socket path the
    // platform rejects) the child simply has no bridge, the adapter publishes
    // only its own two commands, and everything else behaves exactly as before.
    const patches: string[] = [];
    try {
      const socket = bridgeSocketPath(this.bridgeDir);
      patches.push(await writeBridgePatch({ dir: this.bridgeDir, pluginPath: this.bridgePluginPath, socket }));
      this.bridge = this.createBridge(socket);
    } catch (err) {
      this.bridge = null;
      console.warn("[dsh] command bridge unavailable", err);
    }
    // The Project plugin rides a SECOND launch patch, best-effort like the
    // bridge: it lays down the research layout and keeps the Project Brief,
    // and without a record-owned Project there is nothing to manage.
    if (opts.project) {
      try {
        patches.push(
          await writeProjectPatch({
            dir: this.bridgeDir,
            pluginPath: this.projectPluginPath,
            config: { project: opts.project, root: cwd },
          }),
        );
      } catch (err) {
        console.warn("[dsh] project plugin unavailable", err);
      }
    }

    let routeEnv: NodeJS.ProcessEnv | undefined;
    if (binding.endpoint || binding.apiKey) {
      try {
        const route = await applyRouteSettings({
          home: dshHome ?? join(homedir(), ".dsh"),
          provider,
          ...(model === undefined ? {} : { model }),
          ...(binding.endpoint === undefined ? {} : { endpoint: binding.endpoint }),
          ...(binding.apiKey === undefined ? {} : { apiKey: binding.apiKey }),
        });
        if (route) routeEnv = { ...route.env };
      } catch (err) {
        console.warn("[dsh] route settings unavailable", err);
      }
    }

    this.client = this.createClient({
      profile,
      dshHome,
      cwd,
      provider,
      model,
      maxTokens,
      ...(routeEnv === undefined ? {} : { env: { ...process.env, ...routeEnv } }),
      ...(patches.length > 0 ? { patches } : {}),
    });
    this.mirror = new TranscriptMirror(dir);
    this.provider = provider;
    this.model = model;
    this.behavior = createDshBehavior({
      client: this.client,
      mirror: this.mirror,
      harnessSessions: this.harnessSessions,
      profile,
      provider,
      model,
      cwd,
      workspace: opts.workspace ?? null,
      harnessCommands: this.harnessCommands,
      commandCatalog: () => this.listCommands(),
    });
  }

  /**
   * The runtime's command catalog for the frontend slash menu (docs/adr/0003).
   * Two layers under one menu: the adapter's own commands — answered from its
   * own state, available before the harness child has ever started, so the menu
   * and `/status` work even where the harness could not launch (docs/adr/0010) —
   * followed by the harness's own registry, read from the child's bridge once
   * that child is warm (docs/adr/0011). A local name wins a collision.
   *
   * The harness layer is the LIVE catalog when it answers with anything, and a
   * curated list of the pinned profile's own commands otherwise
   * ({@link DSH_HARNESS_FALLBACK_DESCRIPTORS}): the registry is agent-scoped, so
   * a cold runtime has no way to enumerate it at all — without the fallback the
   * menu would look wrong until the user had already sent a message, and again
   * after every service restart.
   *
   * The behavior is handed THIS method as its `commandCatalog`, so the menu and
   * the unknown-command reply can never disagree.
   */
  async listCommands(): Promise<CommandDescriptor[]> {
    // A menu request can beat the background `init` (docs/adr/0008). It waits
    // for it either way: a FAILED init is not an error here, it simply leaves no
    // bridge — which is the cold curation this layer already serves.
    await this.initialized;
    const live = await this.listHarnessCommands();
    const harness = live.length > 0 ? live : DSH_HARNESS_FALLBACK_DESCRIPTORS;
    return mergeCommandDescriptors(harness, DSH_COMMAND_DESCRIPTORS);
  }

  async *run(session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta> {
    // The composition starts this Project's `init` in the background and returns
    // its Environment at once (docs/adr/0008), so the first request can beat it;
    // waiting is what makes that request work instead of failing.
    await this.awaitInit();
    // A batch that drives no model turn — the mount probe, or commands only —
    // is served entirely by this process (reconcile, mirror restore, and the
    // adapter's own replies), so it must not pay for a harness child: `/status`
    // answers even where the harness could not start at all.
    if (commands.some((c) => c.type === "add-message" && !isCommandText(c.message.content))) {
      await this.ensureStarted();
    }
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
    // Ready adapters attach synchronously, as the kit documents (the baseline is
    // pushed on subscribe). A watcher that arrives while the background `init`
    // is still running (docs/adr/0008) binds as soon as the behavior exists
    // instead of throwing away the watch.
    if (this.behavior) return this.runtimeFor(sessionKey).subscribe(sink);
    let off: (() => void) | null = null;
    let cancelled = false;
    void this.initialized.then(() => {
      if (cancelled || this.initFailure !== null) return;
      try {
        off = this.runtimeFor(sessionKey).subscribe(sink);
      } catch (err) {
        console.error("[dsh] watch attach failed", err);
      }
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }

  // No `approve()`: the SDK runtime has no approval surface (docs/adr/0004), so
  // the optional method is simply absent and `capabilities.approvals` is false.

  /** Wait for the background `init`, re-throwing the reason it failed. */
  private async awaitInit(): Promise<void> {
    await this.initialized;
    if (this.initFailure !== null) throw this.initFailure;
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

  /**
   * The harness's catalog for this Project's child, TTL-cached with one inflight
   * refresh and stale-on-failure — the openclaw adapter's catalog policy.
   *
   * A CATALOG request must never boot a child: with none ever started for this
   * Project there is no registry to read, so the answer is `[]` immediately.
   * Once a child is being (or has been) started, the request waits for that same
   * readiness rather than reporting an empty catalog for a warming runtime.
   */
  private async listHarnessCommands(): Promise<CommandDescriptor[]> {
    if (this.ready === null || this.bridge === null) return this.harnessCatalog?.descriptors ?? [];
    if (this.harnessCatalog && Date.now() - this.harnessCatalog.fetchedAt < COMMAND_CATALOG_TTL_MS) {
      return this.harnessCatalog.descriptors;
    }
    if (!this.harnessCatalogInflight) this.harnessCatalogInflight = this.refreshHarnessCatalog();
    return this.harnessCatalogInflight;
  }

  private async refreshHarnessCatalog(): Promise<CommandDescriptor[]> {
    try {
      await this.ready;
      const entries = await this.bridge!.list();
      const descriptors: CommandDescriptor[] = entries.map((entry) => ({
        id: entry.name,
        label: `/${entry.name}`,
        description: entry.description,
        invocationText: `/${entry.name}`,
      }));
      this.harnessCatalog = { fetchedAt: Date.now(), descriptors };
      return descriptors;
    } catch (err) {
      console.warn("[dsh] harness command catalog failed; serving stale/empty", err);
      if (this.harnessCatalog) {
        // Serve the stale catalog, and defer the next attempt so a child that
        // lost its bridge doesn't re-hit it on every request.
        this.harnessCatalog = { fetchedAt: Date.now(), descriptors: this.harnessCatalog.descriptors };
        return this.harnessCatalog.descriptors;
      }
      return [];
    } finally {
      this.harnessCatalogInflight = null;
    }
  }

  /**
   * Resolve one harness command for one Science Studio session. Never throws:
   * every failure is an {@link HarnessCommandOutcome} the behavior turns into a
   * reply row, so a bridge problem can never break the run stream.
   *
   * The child IS started here (unlike the catalog read): a user-issued command
   * is a deliberate request to use the runtime. A session this child generation
   * has no agent for (it has not prompted yet, or `/new` dropped its
   * conversation) is the `cold` handoff, not an answer: the behavior drives the
   * line as that session's FIRST prompt — the only thing that creates an agent
   * — and the child's bridge plugin runs it through the registry instead of the
   * model (docs/adr/0011). Without a bridge there is no interception to keep
   * that line away from the model, so the harness is `unavailable` there.
   */
  private async executeHarnessCommand(
    sessionId: string | null,
    line: string,
  ): Promise<HarnessCommandOutcome> {
    if (!this.bridge) return { status: "unavailable", message: "the command bridge is not available" };
    try {
      await this.ensureStarted();
    } catch (err) {
      return { status: "unavailable", message: err instanceof Error ? err.message : String(err) };
    }
    if (sessionId === null) return { status: "cold" };
    try {
      return await this.bridge.execute(sessionId, line);
    } catch (err) {
      return { status: "unavailable", message: err instanceof Error ? err.message : String(err) };
    }
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
