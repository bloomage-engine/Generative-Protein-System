import type { StateDelta } from "@science-studio/transport";
import type { DeltaSink } from "./transcript.js";

/**
 * One in-flight `run()`: an ordered delta queue an async generator drains.
 * Runtime events fold into the transcript via `transcript.emit`, which pushes
 * into the attached flow; `iterate()` yields queued deltas and returns once
 * the flow ends (the run settled, or was aborted). Mirrors the openclaw
 * adapter's RunFlow exactly.
 */
export class RunFlow implements DeltaSink {
  private deltas: StateDelta[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;

  push(delta: StateDelta): void {
    this.deltas.push(delta);
    this.wake();
  }

  /** End the flow; queued deltas are still drained before `iterate()` returns. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  async *iterate(): AsyncIterable<StateDelta> {
    for (;;) {
      while (this.deltas.length > 0) {
        const delta = this.deltas.shift();
        if (delta) yield delta;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
