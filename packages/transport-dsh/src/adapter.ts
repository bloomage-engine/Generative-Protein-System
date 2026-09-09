import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RecordStoreLike,
  type RuntimeAdapter,
  type RuntimeInitOptions,
  type SessionState,
  type StateDelta,
  type TransportCommand,
  type WatchSnapshot,
} from "@science-studio/transport";
import type { Run, RunStatus } from "@science-studio/record";
import type { TurnEndReason } from "@deepseek-ai/dsh-session";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import { createDshTurnClient, type DshClientLaunchOptions, type DshTurnClient } from "./client.js";
import { RunFlow } from "./flow.js";
import { TranscriptMirror } from "./mirror.js";
import { DshTranscript } from "./transcript.js";

const DEFAULT_PROVIDER = "deepseek-official";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_PROFILE = "sdk";

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

/** One in-flight local run: which transcript slice belongs to this prompt. */
interface RunDriver {
  flow: RunFlow;
  userMessageId: string;
  input: string;
  /** Message count when the prompt was queued; assistant rows from here on belong to this turn. */
  baseline: number;
  startedAt: string;
  reason?: TurnEndReason;
  usage?: TokenUsage;
  done: boolean;
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
  private transcripts = new Map<string, DshTranscript>();
  private mirror: TranscriptMirror | null = null;
  private ready: Promise<void> | null = null;
  private activeFlows = new Map<string, RunFlow>();
  private provider = DEFAULT_PROVIDER;
  private model = DEFAULT_MODEL;

  constructor(options: DshRuntimeAdapterOptions = {}) {
    this.createClient = options.createClient ?? createDshTurnClient;
    this.transcriptDir = options.transcriptDir ?? "";
  }

  async init(opts: RuntimeInitOptions): Promise<void> {
    this.recordStore = opts.recordStore;
    const env = (key: string): string | undefined => opts.config?.[key] ?? process.env[key];
    const profile = env("DSH_PROFILE") ?? DEFAULT_PROFILE;
    const dshHome = env("DSH_HOME");
    const cwd = env("DSH_WORKSPACE") ?? process.cwd();
    const provider = env("DSH_PROVIDER") ?? DEFAULT_PROVIDER;
    const model = env("DSH_MODEL") ?? DEFAULT_MODEL;
    const maxTokensRaw = env("DSH_MAX_TOKENS");
    const maxTokens = maxTokensRaw && /^\d+$/.test(maxTokensRaw) ? Number(maxTokensRaw) : undefined;
    const dir =
      this.transcriptDir || env("DSH_TRANSCRIPT_DIR") || join(tmpdir(), "science-studio", "transcripts");

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

    const flow = new RunFlow();
    transcript.attachFlow(flow);
    this.activeFlows.set(sessionKey, flow);
    try {
      const sends = commands.filter((c) => c.type === "add-message");
      if (sends.length === 0) {
        // Nothing to drive (mount/history probe): terminate so the client's
        // stream settles instead of hanging on an open SSE connection.
        flow.end();
      } else {
        const first = sends[0]!;
        const rest = sends.slice(1);
        const userMsg = {
          id: first.message.id,
          role: "user" as const,
          parts: [{ type: "text" as const, text: first.message.content }],
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
              parts: [{ type: "text", text: extra.message.content }],
            },
          });
        }

        const driver: RunDriver = {
          flow,
          userMessageId: first.message.id,
          input: first.message.content,
          // Snapshot the transcript length AFTER the driving user row (and any
          // echoed extras) landed; assistant rows appended from here on belong
          // to this turn.
          baseline: transcript.state.messages.length,
          startedAt: new Date().toISOString(),
          done: false,
        };
        const settle = (): void => {
          if (driver.done) return;
          driver.done = true;
          flow.end();
          void this.settleRun(sessionKey, transcript, driver);
        };
        void this.client!
          .runTurn(sessionKey, first.message.content, (event) => {
            const meta = transcript.apply(event);
            if (meta.reason) driver.reason = meta.reason;
            if (meta.usage) driver.usage = meta.usage;
          })
          .then(() => settle())
          .catch((err: unknown) => {
            console.error("[dsh] turn failed", err);
            transcript.emit({ type: "session-status", status: "error" });
            settle();
          });
      }
      yield* flow.iterate();
    } finally {
      transcript.detachFlow(flow);
      this.activeFlows.delete(sessionKey);
    }
  }

  /** Persist the Run for one settled turn and refresh the transcript mirror. */
  private async settleRun(
    sessionKey: string,
    transcript: DshTranscript,
    driver: RunDriver,
  ): Promise<void> {
    const state = transcript.state;
    const output = state.messages
      .slice(driver.baseline)
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text))
      .join("\n");
    const status: RunStatus = driver.reason
      ? driver.reason.kind === "completed"
        ? "completed"
        : driver.reason.kind === "error"
          ? "error"
          : "aborted"
      : "error";
    if (this.recordStore) {
      const run: Run = {
        id: driver.userMessageId,
        taskId: sessionKey,
        sessionId: sessionKey,
        status,
        agentId: state.agentId,
        parameters: {
          provider: this.provider,
          model: this.model,
          ...(driver.usage ? { usage: driver.usage } : {}),
        },
        input: driver.input,
        output,
        startedAt: driver.startedAt,
        finishedAt: new Date().toISOString(),
      };
      try {
        await this.recordStore.addRun(run);
      } catch (err) {
        console.warn("[dsh] failed to persist run", err);
      }
    }
    await this.mirror?.save(sessionKey, state.status, state.messages);
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

  /** The SDK runtime has no approval surface — nothing to approve. */
  approve(_approvalId: string, _decision: "approve" | "reject"): void {
    // Intentionally empty: dsh's approval machinery is not part of the SDK
    // profile (docs/adr/0004), so no approval-required delta can originate here.
  }

  /**
   * Standing watch: dsh sessions have a single writer (this adapter), so there
   * are no remote settles to coalesce. Push the current canonical snapshot once
   * on attach (baseline) and stay silent; consumers that adopt it converge on
   * first paint, and the request/response probe handles reload history.
   */
  subscribe(sessionKey: string, sink: (snapshot: WatchSnapshot) => void): () => void {
    const transcript = this.transcripts.get(sessionKey);
    if (transcript) {
      sink({
        status: transcript.state.status,
        messages: Object.fromEntries(transcript.state.messages.map((m) => [m.id, structuredClone(m)])),
      });
    }
    return () => {};
  }
}
