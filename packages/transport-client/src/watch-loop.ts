/**
 * Reconnect loop for the standing watch connection.
 *
 * Extracted from the `useTransportWatch` effect so the retry cadence is a pure,
 * testable unit. The effect owns the connection attempt (`connect` runs one
 * full frame loop: fetch + read until the stream drops/errors) and this helper
 * owns the "try again later" pacing.
 */

export const WATCH_RECONNECT_DELAY_MS = 2000;

export type WatchReconnectOptions = {
  /**
   * One connection attempt. Resolves when the connection ends — dropped,
   * errored, or the stream finished. Must not throw (callers swallow).
   */
  connect: () => Promise<void>;
  /** True once the consumer unmounted / no longer wants reconnects. */
  isClosed: () => boolean;
  /** Delay between the end of an attempt and the next one. */
  retryDelayMs?: number;
};

export type WatchReconnectHandle = {
  /** Stop the loop for good: no further attempt is scheduled. */
  cancel: () => void;
};

/**
 * Runs `connect` and, when it settles, schedules the next attempt after
 * `retryDelayMs` — until `isClosed()` or `cancel()`.
 */
export function watchReconnect(options: WatchReconnectOptions): WatchReconnectHandle {
  const { connect, isClosed, retryDelayMs = WATCH_RECONNECT_DELAY_MS } = options;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let cancelled = false;

  const closed = (): boolean => cancelled || isClosed();

  async function attempt(): Promise<void> {
    while (!closed()) {
      await connect();
      if (closed()) break;
      // Wait out the backoff BEFORE the next attempt. Scheduling the next run
      // with a timer while continuing to loop would reconnect instantly (no
      // backoff) and spawn a fresh concurrent chain per iteration.
      await new Promise<void>((resolve) => {
        wake = resolve;
        reconnectTimer = setTimeout(resolve, retryDelayMs);
      });
    }
  }

  void attempt();

  return {
    cancel: () => {
      cancelled = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      // Wake a paused attempt() so it observes `cancelled` and exits instead of
      // staying suspended on the backoff timer forever.
      wake?.();
    },
  };
}
