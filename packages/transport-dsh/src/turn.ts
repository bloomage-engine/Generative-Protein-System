import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import type { TurnEndReason } from "@deepseek-ai/dsh-session";
import type { RunStatus } from "@science-studio/record";
import { RunFlow, type Message } from "@science-studio/transport";

/**
 * One in-flight local dsh turn. One `run()` prompt = one Harness turn = one
 * persisted `Run` (docs/adr/0004): the adapter queues the prompt and streams
 * the turn's committed events into the canonical transcript, then — on
 * settle — records a `Run` whose `output` is the assistant text that landed
 * AFTER this turn's driving user row (the `baseline` slice).
 *
 * The Turn owns the run-scoped bookkeeping that previously lived as an
 * ad-hoc `RunDriver` closure inside `adapter.run()`: the delta flow to drain,
 * the transcript slice that belongs to this prompt, and the terminal metadata
 * (reason / usage) the persist step needs. `end()` is idempotent so both the
 * settle path and `abort()` may end the flow exactly once.
 */
export interface TurnOptions {
  /** The client message id this turn drives (the persisted Run's id today). */
  userMessageId: string;
  /** The prompt text sent to the harness. */
  input: string;
  startedAt: string;
}

export class Turn {
  /** The delta queue the run generator drains. */
  readonly flow = new RunFlow();
  readonly userMessageId: string;
  readonly input: string;
  readonly startedAt: string;
  /** The `turn/end` reason, when the terminal event reported one. */
  reason?: TurnEndReason;
  /** Token accounting riding an `assistant/message`, when the adapter
   *  reported it. */
  usage?: TokenUsage;
  private ended = false;
  private _baseline = 0;

  constructor(options: TurnOptions) {
    this.userMessageId = options.userMessageId;
    this.input = options.input;
    this.startedAt = options.startedAt;
  }

  /** The message index where this turn's assistant rows start. */
  get baseline(): number {
    return this._baseline;
  }

  /** Record the transcript length once the driving user row (and any echoed
   *  extras) have landed — assistant rows appended from here on belong to this
   *  turn. Called by the adapter after those rows were folded, so the slice is
   *  measured, never derived. */
  setBaseline(length: number): void {
    this._baseline = length;
  }

  /** Fold the driving metadata (reason/usage) a committed event reported. */
  note(meta: { reason?: TurnEndReason; usage?: TokenUsage }): void {
    if (meta.reason) this.reason = meta.reason;
    if (meta.usage) this.usage = meta.usage;
  }

  /** End the turn (idempotent): the flow drains remaining deltas, then the
   *  run generator returns. Safe to call from both settle and `abort()`. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.flow.end();
  }

  /** True once `end()` ran (the harness turn settled or was aborted). */
  isEnded(): boolean {
    return this.ended;
  }
}

/**
 * The Run `output` projection: the assistant TEXT that landed after this
 * turn's baseline. Lossy by design (reasoning and tool output are excluded
 * from the record's output) — a deliberate Run-record semantic.
 */
export function runOutput(messages: readonly Message[], baseline: number): string {
  return messages
    .slice(baseline)
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text))
    .join("\n");
}

/** Map a turn's terminal reason onto the record's `Run` status. A turn that
 *  never reported a reason (e.g. the harness died mid-turn) is an error Run. */
export function runStatus(reason: TurnEndReason | undefined): RunStatus {
  if (!reason) return "error";
  return reason.kind === "completed" ? "completed" : reason.kind === "error" ? "error" : "aborted";
}
