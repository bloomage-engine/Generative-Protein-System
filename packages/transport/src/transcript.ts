import type { SessionState, StateDelta } from "./types.js";
import { foldState } from "./fold.js";

/**
 * A resumable queue of streamed state deltas for one `run()` invocation.
 *
 * The queue is a SECOND consumer of every delta: the transcript folds each
 * delta onto its canonical state when it is produced (`Transcript.emit` folds
 * FIRST, then pushes), and the wire mirror in the transport-service folds the
 * very same deltas. Deltas that carry payloads (add-message / add-part /
 * update-message) can reference the transcript's LIVE objects, which later
 * transcript folds mutate in place — so a delta left queued un-snapshotted
 * would hand the wire mirror an object already mutated by folds the mirror
 * has not seen yet (e.g. an add-message whose parts array already contains the
 * reasoning part a later event added), doubling content and emitting ops the
 * client cannot apply. Each delta is therefore deep-copied at enqueue time:
 * every consumer folds from the same queue-time snapshot sequence.
 */
export class RunFlow {
  private deltas: StateDelta[] = [];
  private waiters: (() => void)[] = [];
  private ended = false;
  /**
   * Optional runtime run id this flow tracks; deltas for other runs are
   * ignored upstream (gateway-style runtimes filter frames by it). `null`
   * means "no target claimed — accept all". Runtimes without run ids leave
   * it null.
   */
  targetRunId: string | null = null;

  push(delta: StateDelta): void {
    this.deltas.push(structuredClone(delta));
    this.wake();
  }

  /** End the flow; queued deltas are still drained before `iterate()` returns. */
  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  async *iterate(): AsyncIterable<StateDelta> {
    let i = 0;
    for (;;) {
      while (i < this.deltas.length) yield this.deltas[i++]!;
      if (this.ended) break;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/**
 * Shared shell of the per-session canonical transcript every runtime adapter
 * owns: fold-compatible `SessionState`, an optional attached in-flight
 * `RunFlow`, and the fold-and-fan-out `emit`. Runtime adapters subclass this
 * and supply their own event → `StateDelta` mapping (`apply`) and session
 * policies (history convergence, mirror restore, …); the shared pieces — one
 * fold via `foldState` in this package, the queue snapshot semantics, the
 * reconcile `snapshot` — live here so no adapter re-implements them.
 *
 * The transcript is the adapter-owned canonical transcript for one session.
 * Science Studio owns the record (docs/adr/0002): this state is the runtime-
 * agnostic session state that the transport-service streams to clients, NOT a
 * runtime transcript.
 */
export class Transcript {
  readonly sessionKey: string;
  /** Fold-compatible session state (the canonical transcript). Public because
   *  adapters' watch/persist paths read `state.status`/`state.messages`
   *  directly. */
  state: SessionState;
  /** The attached in-flight flow, if any (subclasses read it to end a run). */
  protected flow: RunFlow | null = null;

  constructor(sessionKey: string, initial: SessionState) {
    this.sessionKey = sessionKey;
    // Own a copy of the caller's state: the transport-service passes a fresh
    // per-request object, and the transcript must never alias it (later folds
    // would mutate the caller's object).
    this.state = { ...initial, messages: [...initial.messages] };
  }

  attachFlow(flow: RunFlow): void {
    this.flow = flow;
  }

  detachFlow(flow: RunFlow): void {
    if (this.flow === flow) this.flow = null;
  }

  /** True while a local `run()`'s flow is attached. */
  hasActiveFlow(): boolean {
    return this.flow !== null;
  }

  /**
   * Fold a delta onto the local canonical transcript (`state`) AND push it to
   * the attached flow. One fold (`foldState` in this package) is the single
   * source of delta semantics — the wire projection in the transport-service
   * folds the very same deltas, so the canonical transcript and the wire
   * mirror can never drift apart. The fold is unconditional (a delta arriving
   * between requests, with no flow attached, must still be reflected here);
   * the push to the client is conditional on a flow.
   */
  emit(delta: StateDelta): void {
    foldState(this.state, delta);
    this.flow?.push(delta);
  }

  /** The canonical transcript snapshot used to reconcile a client's state. */
  snapshot(): StateDelta {
    return {
      type: "reconcile",
      status: this.state.status,
      messages: this.state.messages.map((m) => structuredClone(m)),
    };
  }
}
