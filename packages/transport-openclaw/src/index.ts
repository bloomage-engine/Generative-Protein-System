/**
 * OpenClaw runtime adapter (backend transport-service).
 *
 * Connects to an OpenClaw gateway as an operator client, drives `chat.send`,
 * and streams state deltas back. Persists a `Run` to the record store when a
 * research turn completes. NOTES:
 * - The gateway `sessionKey` is taken from `SessionState.sessionId` (the record's
 *   Session id, 1:1); a gateway-namespace mapping per Project is not needed yet.
 * - The run lifecycle lives in the shared kit `SessionRuntime` (docs/adr/0005);
 *   this adapter holds one runtime per session and supplies the openclaw
 *   behavior (`behavior.ts`) plus the gateway-facing command catalog.
 */
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
  WatchSnapshot,
} from "@science-studio/transport";
import { SessionRuntime } from "@science-studio/transport";
import type { SessionBehavior } from "@science-studio/transport";
import type { EventFrame } from "@openclaw/gateway-client/browser";
import { mapCommandEntries, type GatewayCommandEntry } from "./commands.js";
import { createBackendGateway, type BackendGateway, type BackendGatewayOptions } from "./connection.js";
import { OPENCLAW_CAPABILITIES, openClawLocalBinding, parseGatewayBinding, type GatewayBinding } from "./binding.js";
import { createOpenClawBehavior } from "./behavior.js";

const CLIENT_VERSION = "0.0.0";

/** Freshness window for the cached command catalog (`listCommands`). */
const COMMAND_CATALOG_TTL_MS = 60_000;

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
  /** Canonical session for thread ids the gateway does not namespace. */
  private defaultSession: string | undefined;
  /** One shared run lifecycle per Session (docs/adr/0005). */
  private runtimes = new Map<string, SessionRuntime<EventFrame>>();
  private behavior: SessionBehavior<EventFrame> | null = null;
  private ready: Promise<void> | null = null;
  /** Cached command catalog (see `listCommands`). */
  private commandCatalog: { fetchedAt: number; descriptors: CommandDescriptor[] } | null = null;
  private commandCatalogInflight: Promise<CommandDescriptor[]> | null = null;

  constructor(options: OpenClawRuntimeAdapterOptions = {}) {
    this.createGateway = options.createGateway ?? createBackendGateway;
  }

  async init(opts: RuntimeInitOptions): Promise<void> {
    this.recordStore = opts.recordStore;
    const gateway = parseGatewayBinding(opts.binding);
    this.defaultSession = gateway.defaultSession;
    const connection = this.createGateway({
      url: gateway.url,
      token: gateway.token,
      version: CLIENT_VERSION,
    });
    this.gateway = connection;
    this.behavior = createOpenClawBehavior({ gateway: connection, workspace: opts.workspace ?? null });

    connection.onEvent((frame) => {
      const sessionKey = (frame.payload as Record<string, unknown> | null)?.sessionKey;
      if (typeof sessionKey !== "string") return;
      // No run lifecycle for this session yet → nothing to fold (a plain watch
      // attach must not seed a transcript).
      const runtime = this.runtimes.get(sessionKey);
      if (!runtime || !runtime.initialized) return;
      runtime.ingest(frame);
    });

    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("gateway not ready within 15s (check URL/token)")),
        15_000,
      );
      timer.unref?.();
      connection.onReady(() => {
        clearTimeout(timer);
        resolve();
      });
      connection.start();
    });
    await this.ready;
  }

  async *run(session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta> {
    if (!this.gateway) throw new Error("adapter not initialized");
    await this.ready;
    yield* this.runtimeFor(session.sessionId).run(session, commands);
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
   * Standing watch seam: baseline on attach, then one coalesced push per settle
   * (local or remote). See `SessionRuntime.subscribe`.
   */
  subscribe(sessionKey: string, sink: (snapshot: WatchSnapshot) => void): () => void {
    return this.runtimeFor(sessionKey).subscribe(sink);
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

  /**
   * Runtime-level abort. The gateway exposes no client-side cancel wired here
   * yet (a `chat.abort` follow-up); the run stream is not force-ended.
   */
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

  private runtimeFor(sessionKey: string): SessionRuntime<EventFrame> {
    if (!this.behavior) throw new Error("adapter not initialized");
    let runtime = this.runtimes.get(sessionKey);
    if (!runtime) {
      runtime = new SessionRuntime<EventFrame>(sessionKey, this.behavior, {
        ...(this.recordStore ? { recordStore: this.recordStore } : {}),
      });
      this.runtimes.set(sessionKey, runtime);
    }
    return runtime;
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
