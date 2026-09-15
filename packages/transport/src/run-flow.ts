import type { StateDelta } from "./types.js";

/**
 * A resumable queue of streamed state deltas for one `run()` invocation.
 *
 * The queue is a SECOND consumer of every delta: the canonical transcript folds
 * each delta when it is produced (the `SessionRuntime`'s `emit` folds FIRST,
 * then pushes), and the wire mirror in the transport-service folds the very
 * same deltas. Deltas that carry payloads (add-message / add-part /
 * update-message) can reference the runtime's LIVE objects, which later folds
 * mutate in place — so a delta left queued un-snapshotted would hand the wire
 * mirror an object already mutated by folds the mirror has not seen yet (e.g.
 * an add-message whose parts array already contains the reasoning part a later
 * event added), doubling content and emitting ops the client cannot apply. Each
 * delta is therefore deep-copied at enqueue time: every consumer folds from the
 * same queue-time snapshot sequence.
 *
 * Kit-internal: not part of the package's public surface (docs/adr/0005).
 */
export class RunFlow {
  private deltas: StateDelta[] = [];
  private waiters: (() => void)[] = [];
  private ended = false;

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

  /**
   * Drain this flow, suspending between pushes. An `AsyncGenerator`, not the
   * broader `AsyncIterable`: the annotation is a promise to callers, and
   * `AsyncIterable` would claim this is re-iterable (it is single-shot) and hide
   * `next()` from a consumer that pulls one delta at a time.
   */
  async *iterate(): AsyncGenerator<StateDelta> {
    let i = 0;
    for (;;) {
      while (i < this.deltas.length) yield this.deltas[i++]!;
      if (this.ended) break;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
