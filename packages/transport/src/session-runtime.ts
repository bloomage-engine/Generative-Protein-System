/**
 * `SessionRuntime` — the shared run lifecycle every runtime adapter composes
 * (docs/adr/0005).
 *
 * The module owns, per Session: the canonical transcript, the run-loop skeleton
 * (reconcile-first, probe termination, user-row echo, flow attach/drain, settle
 * awaited per policy), the settle pipeline with its error containment, the
 * standing-watch registry, and the Run projection default. An adapter supplies
 * a `SessionBehavior`: one event→delta mapping (`apply`), its launch surface
 * (`dispatch`), and only the policy hooks its runtime genuinely differs on.
 *
 * KIT tier: exported from the package root, NEVER from `./seams` (the seam is
 * `RuntimeAdapter`; this is shared implementation). React-free, and ignorant of
 * every runtime's event vocabulary, of assistant-ui, and of `process.env`.
 */
import type { Id, Run } from "@gps/record";
import type {
  AttachmentRef,
  Message,
  MessagePart,
  RecordStoreLike,
  SessionState,
  StateDelta,
  TransportCommand,
  WatchSnapshot,
} from "./types.js";
import { createTranscriptOps } from "./apply-context.js";
import { RunFlow } from "./run-flow.js";
import { userMessageParts } from "./attachments.js";

/** A Run-record identity the runtime uses to address one turn. Opaque here. */
type UserSend = Extract<TransportCommand, { type: "add-message" }>;

/** `Run` as the projection target; adapters return a `Partial<RunSpec>`. */
export type RunSpec = Run;

/** The record-store slice the kit persists Runs through. */
export type RunSink = RecordStoreLike;

/** The Run projection the settle pipeline records. */
export interface SettleDirective {
  /** The Run's status. Default `"completed"`. */
  status?: Run["status"];
  /** Opaque token accounting; carried into `parameters.usage`, never inspected. */
  usage?: unknown;
}

/** What one `apply` decided, beyond the deltas it emitted. */
export interface ApplyResult {
  /** Settle on this event: end the flow and run the settle pipeline. `true`
   *  means the common directive (status `completed`, no usage). */
  settled?: SettleDirective | true;
}

/** One tool-call lifecycle contribution, merged under ONE part per id. */
export interface ToolCallUpdate {
  messageId: Id;
  toolCallId: Id;
  /** Creation fields — used only when the part does not exist yet. */
  name?: string;
  /** The model's raw arguments, already stringified by the adapter. */
  args?: string;
  /** Result fields — merged onto the existing part. */
  result?: string;
  isError?: boolean;
}

/** The mutation surface a behavior writes through. */
export interface ApplyContext<E> {
  readonly sessionKey: string;
  /** Read-only canonical transcript; mutate it only through the primitives. */
  readonly state: SessionState;
  /** Fold a delta onto the canonical transcript AND fan it out to the in-flight
   *  flow (if any). The ONE delta sink. */
  emit(delta: StateDelta): void;
  /** Find-or-create a message keyed by `id`, emitting `add-message` when new. */
  ensureMessage(id: Id, role: Message["role"]): Message;
  /** The one `tool-call`-part-per-id merge rule (create on start, merge result). */
  mergeToolCall(update: ToolCallUpdate): void;
  /** Report the runtime's current run id (an event with no local Run). */
  reportRunId(id: Id): void;
  /** The active local Run's runtime id, or `null`. Filter foreign frames on it. */
  readonly targetRunId: Id | null;
  /** The active local Run, or `null` for an event outside one. */
  readonly run: RunControl<E> | null;
}

/** Handle onto one in-flight Run; stays valid after `run()` returns so a late
 *  settle (an aborted-but-finishing turn) still lands. */
export interface RunControl<E> {
  /** The runtime run id this flow tracks; `null` accepts every frame. */
  targetRunId: Id | null;
  /** Route one runtime event through `apply`. */
  ingest(event: E): void;
  /** Fold a delta onto the canonical transcript and fan it out to this Run's
   *  flow (the launch surface's way to report a failure status). */
  emit(delta: StateDelta): void;
  /** Note run-scoped metadata for the eventual settle (status / token usage). */
  note(meta: { status?: Run["status"]; usage?: unknown }): void;
  /** End the Run and run the settle pipeline. Idempotent. */
  settle(directive?: SettleDirective | true): void;
  /** End the Run's flow WITHOUT settling (a client abort). */
  abort(): void;
}

/** One client command handed to the runtime's launch surface. */
export interface DispatchMessage {
  readonly id: Id;
  readonly content: string;
  readonly attachments?: readonly AttachmentRef[];
}

export interface DispatchRequest {
  readonly sessionKey: string;
  /** The client's user commands, in order; the kit has already echoed them. */
  readonly messages: readonly DispatchMessage[];
}

/** Adapter I/O viewed by the pre-reconcile / settle hooks. */
export interface TranscriptHandle {
  readonly sessionKey: string;
  readonly state: SessionState;
  /** Replace the canonical list (history resync / mirror restore). Out-of-band:
   *  folds but never streams. Legal only from an I/O hook, not from `apply`. */
  replaceMessages(messages: readonly Message[], status?: SessionState["status"]): void;
  /** Empty the transcript and idle it (a runtime session reset). */
  resetSession(): void;
  /** Request a watched push (honouring the coalescing window). */
  notify(): void;
}

export interface SettleContext extends TranscriptHandle {
  /** True for a local run's flow vs an event that arrived outside one. */
  readonly inRun: boolean;
  /** The settled Run's runtime id, or `null`. */
  readonly runId: Id | null;
  /** The driving client message id, or `null` for a remote settle. */
  readonly userMessageId: Id | null;
  /** The Run's input text (driving user text, or the nearest preceding row). */
  readonly input: string;
  /** The message index where this Run's output starts. */
  readonly baseline: number;
  /** The resolved directive (status defaulted at projection time). */
  readonly directive: SettleDirective;
  readonly startedAt: string;
}

/** Watch policy. Default: in-memory baseline, immediate push. */
export interface WatchPolicy {
  /** Coalesce pushes into one per trailing window; `0`/absent = immediate. */
  coalesceMs?: number;
  /** Async baseline for a Session the runtime has never run (a cold mirror). */
  readBaseline?(sessionKey: string): Promise<WatchSnapshot | null>;
}

/**
 * The runtime-specific policy the kit cannot know: one event mapping plus the
 * optional hooks a real variation justifies. Never subclassed.
 */
export interface SessionBehavior<E> {
  /** CORE. Map one runtime event into deltas through `ctx`. */
  apply(event: E, ctx: ApplyContext<E>): ApplyResult | void;

  /** REQUIRED. Hand a client batch to the runtime (openclaw `chat.send`, dsh
   *  `runTurn`). Start the work; the kit drains the flow concurrently. */
  dispatch(request: DispatchRequest, run: RunControl<E>): Promise<void> | void;

  /** I/O before the reconcile snapshot (history convergence, mirror restore). */
  prepare?(handle: TranscriptHandle): Promise<void> | void;

  /** I/O at settle, before the Run is recorded (mirror save, history poll). */
  beforePersist?(ctx: SettleContext): Promise<void> | void;

  /** Project the settled Run; `null` persists nothing. Shallow-merged over the
   *  default projection. */
  projectRun?(ctx: SettleContext): Partial<RunSpec> | null;

  /** Watch policy. */
  watch?: WatchPolicy;

  /**
   * Cancel the runtime-side turn for a Session (a REAL abort, not just ending
   * the client stream). The kit still ends the client flow itself; this hook
   * reaches the adapter's own cancel when the runtime has one (openclaw
   * `chat.abort`, dsh `agent.cancel` through the child bridge). Receives the
   * active Run's runtime id when one was reported.
   */
  cancel?(sessionKey: string, runId: string | null): Promise<void> | void;

  /** Await the settle pipeline (persist included) before `run()` returns.
   *  Default `true`; openclaw sets `false` for fire-and-forget persistence. */
  awaitSettle?: boolean;
}

/** Injects a timer for the watch coalescing window (tests make it synchronous). */
export type Scheduler = (flush: () => void, ms: number) => () => void;

export interface SessionRuntimeDeps {
  /** Where settled Runs go. Failures are contained, never thrown into a stream. */
  recordStore?: RunSink;
  /** Coalescing timer; defaults to `setTimeout`. */
  schedule?: Scheduler;
  /** Clock for Run timestamps; defaults to `new Date().toISOString`. */
  now?: () => string;
  /** Where contained failures go; defaults to `console.warn`. */
  onError?: (error: unknown) => void;
}

type WatchSink = (snapshot: WatchSnapshot) => void;

/** A settled-or-settling unit the pipeline projects, persists and notifies. */
interface SettleTarget {
  readonly flow: RunFlow | null;
  readonly local: boolean;
  runId: Id | null;
  readonly userMessageId: Id | null;
  readonly input: string;
  baseline: number;
  readonly startedAt: string;
  readonly directive: SettleDirective;
  settled: boolean;
  pending: Promise<void> | null;
}

interface ActiveRun<E> extends SettleTarget {
  readonly flow: RunFlow;
  readonly control: RunControl<E>;
  targetRunId: Id | null;
}

const defaultSchedule: Scheduler = (flush, ms) => {
  const timer = setTimeout(flush, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

/**
 * The assistant TEXT a Run produced: every `text` part of the assistant rows at
 * or after `from`. Lossy by design — reasoning and tool output are not the
 * record's `output` (the openclaw/dsh Run semantic).
 */
export function textOutput(messages: readonly Message[], from = 0): string {
  return messages
    .slice(from)
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text))
    .join("\n");
}

/**
 * The one tool-part merge invariant: attach `text`/`isError` to the first
 * `tool-call` part with `toolCallId`, replacing it in place. Returns whether a
 * part matched; the caller decides what an unmatched result means. An existing
 * `isError` survives a non-error merge (errors are only ever added).
 */
export function mergeToolResult(
  parts: MessagePart[],
  toolCallId: Id,
  text: string,
  isError: boolean,
): boolean {
  const index = parts.findIndex((p) => p.type === "tool-call" && p.id === toolCallId);
  if (index === -1) return false;
  const part = parts[index] as Extract<MessagePart, { type: "tool-call" }>;
  parts[index] = { ...part, result: text, ...(isError ? { isError: true } : {}) };
  return true;
}

/**
 * One Session's canonical state and run lifecycle. The adapter holds one per
 * session key and delegates `run`/`subscribe`/`abort` to it.
 */
export class SessionRuntime<E> {
  readonly sessionKey: string;
  private readonly behavior: SessionBehavior<E>;
  private readonly recordStore: RunSink | undefined;
  private readonly schedule: Scheduler;
  private readonly now: () => string;
  private readonly onError: (error: unknown) => void;

  /** The canonical transcript (Generative Protein System's owned session state). */
  state: SessionState = { sessionId: "", projectId: "", agentId: "", status: "idle", messages: [] };
  /** The transcript primitives — the SAME ones `createApplyContext` hands a test. */
  private readonly ops = createTranscriptOps(this.state);

  private active: ActiveRun<E> | null = null;
  private readonly sinks = new Set<WatchSink>();
  private notifyCancel: (() => void) | null = null;
  /** True once a real Session was bound (a run) — distinguishes "empty" from
   *  "unknown" for the watch baseline. */
  private bootstrapped = false;
  /** The newest run id an event reported, for an ambient (remote) settle. */
  private lastReportedRunId: Id | null = null;

  constructor(sessionKey: string, behavior: SessionBehavior<E>, deps: SessionRuntimeDeps = {}) {
    this.sessionKey = sessionKey;
    this.behavior = behavior;
    this.recordStore = deps.recordStore;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.onError = deps.onError ?? ((error) => console.warn("[session-runtime] contained failure", error));
  }

  /** True once a real Session was bound by a `run()` — distinguishes a known
   *  (possibly empty) transcript from an unknown one for the watch baseline and
   *  for an adapter routing runtime events. */
  get initialized(): boolean {
    return this.bootstrapped;
  }

  /**
   * Drive one client batch: reconcile-first, then the run-loop skeleton. Yields
   * `StateDelta`s exactly like `RuntimeAdapter.run`. A zero-command batch is a
   * mount probe that yields the reconcile snapshot and terminates.
   */
  async *run(session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta> {
    this.state.sessionId = session.sessionId;
    this.state.projectId = session.projectId;
    this.state.agentId = session.agentId;
    this.bootstrapped = true;

    try {
      await this.behavior.prepare?.(this.transcriptHandle());
    } catch (error) {
      // Pre-reconcile I/O is best-effort: a run never blocks on history/mirror.
      this.onError(error);
    }

    yield this.reconcileDelta();

    const sends = commands.filter((c): c is UserSend => c.type === "add-message");
    if (sends.length === 0) {
      // Probe: terminate so the client's stream settles instead of hanging.
      const flow = new RunFlow();
      flow.end();
      yield* flow.iterate();
      return;
    }

    const flow = new RunFlow();
    const run = this.createActiveRun(flow, sends);
    this.active = run;
    try {
      for (const send of sends) {
        this.ops.emit(flow, {
          type: "add-message",
          message: {
            id: send.message.id,
            role: "user",
            parts: userMessageParts(send.message.content, send.message.attachments),
          },
        });
      }
      this.ops.emit(flow, { type: "session-status", status: "running" });
      // Measured, never derived: assistant rows appended from here on belong to
      // this Run's output slice.
      run.baseline = this.state.messages.length;
      run.runId = run.userMessageId;

      const request: DispatchRequest = {
        sessionKey: this.sessionKey,
        messages: sends.map((send) => ({
          id: send.message.id,
          content: send.message.content,
          ...(send.message.attachments ? { attachments: send.message.attachments } : {}),
        })),
      };
      try {
        const started = this.behavior.dispatch(request, run.control);
        void Promise.resolve(started).catch((error) => {
          this.onError(error);
          this.failRun(run);
        });
      } catch (error) {
        this.onError(error);
        this.failRun(run);
      }

      yield* flow.iterate();
      if (this.behavior.awaitSettle !== false && run.pending) await run.pending;
    } finally {
      if (this.active === run) this.active = null;
    }
  }

  /**
   * Route one runtime event (a gateway frame, a harness event) through `apply`.
   * Synchronous and never throws into the event source. A terminal event with no
   * local Run is an ambient (remote) settle.
   */
  ingest(event: E): void {
    const run = this.active;
    let result: ApplyResult | void;
    try {
      result = this.behavior.apply(event, this.applyContext(run));
    } catch (error) {
      this.onError(error);
      return;
    }
    if (!result?.settled) return;
    if (run) this.settleRun(run, result.settled);
    else this.settleAmbient(result.settled);
  }

  /**
   * Standing watch for this Session: baseline on attach (in-memory once the
   * Session is known, else the adapter's async baseline, else the next settle),
   * then one pushed snapshot per settle, coalesced per the watch policy.
   */
  subscribe(sink: WatchSink): () => void {
    this.sinks.add(sink);
    if (this.bootstrapped) {
      sink(this.snapshotOf());
    } else if (this.behavior.watch?.readBaseline) {
      void this.behavior
        .watch.readBaseline(this.sessionKey)
        .then((snapshot) => {
          if (snapshot && this.sinks.has(sink)) sink(snapshot);
        })
        .catch((error) => this.onError(error));
    }
    return () => {
      this.sinks.delete(sink);
      if (this.sinks.size === 0 && this.notifyCancel) {
        this.notifyCancel();
        this.notifyCancel = null;
      }
    };
  }

  /** End the active flow without settling (a client abort). Whether a later
   *  settle still records a Run is the adapter's policy. */
  abort(_reason?: string): void {
    // A real, runtime-side cancel first (best-effort; a throw must not break
    // the flow teardown), then end the client stream.
    try {
      void this.behavior.cancel?.(this.sessionKey, this.active?.targetRunId ?? null);
    } catch (error) {
      this.onError(error);
    }
    this.active?.flow.end();
    // Guarantee watchers converge OUT of `running`. The client's stop click must
    // never wedge the thread, and a runtime whose cancel is unavailable or slow
    // would otherwise leave the canonical status `running` — every later watch
    // push would then re-inflate the client it just set to idle. A real cancel
    // still settles the turn later and converges the same way.
    if (this.state.status === "running") {
      this.ops.emit(null, { type: "session-status", status: "idle" });
      this.notify();
    }
  }

  /** Push the canonical transcript to watchers (honouring the coalescing window). */
  notify(): void {
    const ms = this.behavior.watch?.coalesceMs ?? 0;
    if (ms <= 0) {
      this.flush();
      return;
    }
    if (this.notifyCancel) return;
    this.notifyCancel = this.schedule(() => {
      this.notifyCancel = null;
      this.flush();
    }, ms);
  }

  // -- Internals --------------------------------------------------------------

  private reconcileDelta(): StateDelta {
    return {
      type: "reconcile",
      status: this.state.status,
      messages: this.state.messages.map((m) => structuredClone(m)),
    };
  }

  private applyContext(run: ActiveRun<E> | null): ApplyContext<E> {
    const flow = run?.flow ?? null;
    return {
      sessionKey: this.sessionKey,
      state: this.state,
      emit: (delta) => this.ops.emit(flow, delta),
      ensureMessage: (id, role) => this.ops.ensureMessage(flow, id, role),
      mergeToolCall: (update) => this.ops.mergeToolCall(flow, update),
      reportRunId: (id) => {
        this.lastReportedRunId = id;
        // Adopt it for the active Run too: a gateway terminal frame is the only
        // place its run id is named when `chat.send` had not resolved yet.
        if (run) run.runId = id;
      },
      get targetRunId() {
        return run?.targetRunId ?? null;
      },
      run: run?.control ?? null,
    };
  }

  private createActiveRun(flow: RunFlow, sends: readonly UserSend[]): ActiveRun<E> {
    const first = sends[0]!;
    const run: ActiveRun<E> = {
      flow,
      control: undefined as unknown as RunControl<E>,
      local: true,
      targetRunId: null,
      runId: first.message.id,
      userMessageId: first.message.id,
      input: first.message.content,
      baseline: 0,
      startedAt: this.now(),
      directive: {},
      settled: false,
      pending: null,
    };
    const control: RunControl<E> = {
      get targetRunId() {
        return run.targetRunId;
      },
      set targetRunId(value: Id | null) {
        run.targetRunId = value;
      },
      ingest: (event) => this.ingest(event),
      emit: (delta) => this.ops.emit(run.flow, delta),
      note: (meta) => {
        if (meta.status) run.directive.status = meta.status;
        if (meta.usage !== undefined) run.directive.usage = meta.usage;
      },
      settle: (directive) => this.settleRun(run, directive),
      abort: () => run.flow.end(),
    };
    (run as { control: RunControl<E> }).control = control;
    return run;
  }

  private failRun(run: ActiveRun<E>): void {
    this.settleRun(run, { status: "error" });
  }

  /** End a local run's flow and start its settle pipeline. Idempotent. */
  private settleRun(run: ActiveRun<E>, directive?: SettleDirective | true): void {
    if (run.settled) return;
    if (directive && directive !== true) {
      if (directive.status) run.directive.status = directive.status;
      if (directive.usage !== undefined) run.directive.usage = directive.usage;
    }
    run.flow.end();
    run.pending = this.beginSettle(run);
  }

  /** A terminal event that arrived with no local Run (a remote settle). */
  private settleAmbient(directive: SettleDirective | true): void {
    const resolved: SettleDirective = directive === true ? {} : directive;
    const runId = this.lastReportedRunId;
    const index = runId ? this.state.messages.findIndex((m) => m.id === runId) : -1;
    const baseline = index >= 0 ? index : 0;
    const target: SettleTarget = {
      flow: null,
      local: false,
      runId,
      userMessageId: null,
      input: index >= 0 ? this.nearestUserText(index) : "",
      baseline,
      startedAt: this.now(),
      directive: resolved,
      settled: false,
      pending: null,
    };
    this.beginSettle(target);
  }

  private nearestUserText(before: number): string {
    for (let i = before - 1; i >= 0; i--) {
      const message = this.state.messages[i]!;
      if (message.role !== "user") continue;
      return message.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
    }
    return "";
  }

  private beginSettle(target: SettleTarget): Promise<void> {
    if (target.settled) return target.pending ?? Promise.resolve();
    target.settled = true;
    const pending = this.runSettlePipeline(target);
    target.pending = pending;
    return pending;
  }

  private async runSettlePipeline(target: SettleTarget): Promise<void> {
    const ctx = this.settleContext(target);
    try {
      await this.behavior.beforePersist?.(ctx);
    } catch (error) {
      this.onError(error);
    }
    let run: RunSpec | null = null;
    try {
      const override = this.behavior.projectRun?.(ctx);
      const base = this.defaultRunSpec(ctx);
      if (override === null) run = null;
      else if (base) run = override === undefined ? base : { ...base, ...override };
    } catch (error) {
      this.onError(error);
      run = null;
    }
    if (run && this.recordStore) {
      try {
        await this.recordStore.addRun(run);
      } catch (error) {
        // Persist failure must never escape into the run stream.
        this.onError(error);
      }
    }
    this.notify();
  }

  /** Run projection SKELETON: fills every record field; hooks override fields. */
  private defaultRunSpec(ctx: SettleContext): RunSpec | null {
    const id = ctx.runId ?? ctx.userMessageId;
    if (id === null) return null;
    return {
      id,
      sessionId: ctx.sessionKey,
      projectId: ctx.state.projectId,
      status: ctx.directive.status ?? "completed",
      agentId: ctx.state.agentId,
      parameters: ctx.directive.usage !== undefined ? { usage: ctx.directive.usage } : {},
      input: ctx.input,
      output: textOutput(ctx.state.messages, ctx.baseline),
      startedAt: ctx.startedAt,
      finishedAt: this.now(),
    };
  }

  private transcriptHandle(): TranscriptHandle {
    return {
      sessionKey: this.sessionKey,
      state: this.state,
      replaceMessages: (messages, status) => {
        this.state.messages = structuredClone(messages) as Message[];
        if (status) this.state.status = status;
      },
      resetSession: () => {
        this.state.messages = [];
        this.state.status = "idle";
      },
      notify: () => this.notify(),
    };
  }

  private settleContext(target: SettleTarget): SettleContext {
    return {
      ...this.transcriptHandle(),
      inRun: target.local,
      runId: target.runId,
      userMessageId: target.userMessageId,
      input: target.input,
      baseline: target.baseline,
      directive: target.directive,
      startedAt: target.startedAt,
    };
  }

  private snapshotOf(): WatchSnapshot {
    const messages: Record<string, Message> = {};
    for (const message of this.state.messages) messages[message.id] = structuredClone(message);
    return { status: this.state.status, messages };
  }

  private flush(): void {
    if (this.sinks.size === 0) return;
    const snapshot = this.snapshotOf();
    for (const sink of this.sinks) {
      try {
        sink(snapshot);
      } catch (error) {
        // One bad sink must not break the rest.
        this.onError(error);
      }
    }
  }
}
