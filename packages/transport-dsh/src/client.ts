import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/**
 * The turn-driving surface the dsh adapter needs from the runtime. The real
 * implementation wraps `@deepseek-ai/dsh-sdk-client` (which spawns the
 * same-version `dsh --profile sdk` CLI as a child process speaking stdio
 * JSON-RPC — see docs/adr/0004); tests inject a scripted fake through
 * `DshRuntimeAdapterOptions.createClient`, mirroring the openclaw adapter's
 * `createGateway` test seam.
 *
 * A turn here means: one prompt queued on one Harness session, observed until
 * the agent is idle again. The runtime has no wire-level cancel and no
 * token-stream push: `session.event` notifications arrive per committed log
 * event (an `assistant/message` carries a whole step's content blocks), which
 * is exactly the granularity this adapter streams to the frontend.
 */
export interface DshTurnClient {
  /** Start the runtime and complete the process-wide `initialize` handshake. */
  start(): Promise<void>;
  /** Shut the runtime down (idempotent). */
  close(): Promise<void>;
  /**
   * Queue one user prompt on `sessionId` (created lazily by the runtime) and
   * stream the session's committed events to `onEvent` as they are recorded.
   * Resolves when the session is idle again; rejects only on transport loss,
   * timeout, or protocol error — a turn that ends with `turn/end reason:
   * error` is delivered as events and resolves normally.
   */
  runTurn(
    sessionId: string,
    text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void>;
  /**
   * Subscribe to this child's notifications for the WHOLE runtime (every
   * session), independent of any run. This is what keeps a background
   * subagent's status live after the parent turn has gone idle, when the
   * per-run stream has already closed. Returns an unsubscribe.
   * OPTIONAL: gate on method presence, not on a capability flag.
   */
  subscribeNotifications?(listener: (notification: HarnessNotification) => void): () => void;
}

export interface DshClientLaunchOptions {
  /** Named profile serving the SDK protocol (default `sdk`). */
  profile?: string;
  /** Ordered per-launch profile patches; each entry is passed to the child as
   * `--patch <abs path>` (`@deepseek-ai/dsh-sdk-client` `resolveDshLaunch`). */
  patches?: string[];
  /** Explicit Harness home for the child (its durable session logs live here). */
  dshHome?: string;
  /** Working directory recorded on SDK-created sessions (the agent workspace). */
  cwd?: string;
  /** Provider route for SDK-created agents (default `deepseek-official`). */
  provider?: string;
  /** Model for SDK-created agents (default `deepseek-v4-flash`). */
  model?: string;
  /** Optional positive output-token cap inherited by SDK-created agents. */
  maxTokens?: number;
  /** Extra environment for the harness child (a route credential, typically). */
  env?: NodeJS.ProcessEnv;
}

/** Real turn client over the official TypeScript SDK client. */
class SdkDshTurnClient implements DshTurnClient {
  private readonly harness: DeepSeekHarness;

  constructor(options: DshClientLaunchOptions) {
    this.harness = new DeepSeekHarness({
      profile: options.profile,
      patches: options.patches,
      dshHome: options.dshHome,
      cwd: options.cwd,
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxTokens,
      env: options.env,
      // A turn can legitimately run long (multi-step tool work). The request
      // timeout default (undefined) waits indefinitely, which is what we want.
    });
  }

  async start(): Promise<void> {
    await this.harness.start();
  }

  async close(): Promise<void> {
    await this.harness.close();
  }

  subscribeNotifications(listener: (notification: HarnessNotification) => void): () => void {
    const subscription = this.harness.client.subscribe();
    void (async () => {
      try {
        for await (const notification of subscription) listener(notification);
      } catch {
        /* the runtime closed: the adapter is being torn down too */
      }
    })();
    return () => subscription.close();
  }

  async runTurn(
    sessionId: string,
    text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    await this.harness.session(sessionId).run(text, {
      onNotification: (notification) => {
        if (notification.method !== "session.event") return;
        const params = notification.params as { sessionId?: unknown; event?: unknown };
        if (params?.sessionId !== sessionId) return;
        const event = params.event as SessionEvent | undefined;
        if (event) onEvent(event);
      },
    });
  }
}

/** The default factory: a real SDK client whose launch is configured by the adapter. */
export function createDshTurnClient(options: DshClientLaunchOptions): DshTurnClient {
  return new SdkDshTurnClient(options);
}
