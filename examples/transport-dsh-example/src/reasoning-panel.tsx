import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuiState } from "@assistant-ui/react";

/**
 * Static-variant reasoning element (assistant-ui "Reasoning" → step-panel
 * design, docs /elements/reasoning#the-step-panel-design).
 *
 * The registry `ReasoningPanel` is Tailwind/shadcn-bound, so this is a
 * hand-rolled equivalent on the example's plain CSS with the same props
 * contract: a trigger that swaps between the live "Thinking" label and a
 * resting summary, over an ordered list of titled steps.
 *
 * This example stays "static" on purpose: the wire never token-streams
 * reasoning — the openclaw adapter collapses thinking events into one
 * reasoning part whose full text is replaced in place — so the panel is
 * driven purely by the parts/status already in the message, and treats the
 * trace as finished text instead of a growing stream.
 */

export interface ReasoningStep {
  title: string;
  body: string;
}

export interface ReasoningPanelProps {
  /** Titled steps in order (the message's reasoning parts). */
  steps: ReasoningStep[];
  /** How many leading steps to show; clamps to `steps.length`. */
  visibleSteps: number;
  /** While true the trigger shows the live label and the last step pulses. */
  streaming: boolean;
  /** Controlled open state. */
  open: boolean;
  /** Called on every toggle. */
  onOpenChange: (open: boolean) => void;
  /** Trigger text once `streaming` is false. */
  restingLabel: string;
  className?: string;
}

export function ReasoningPanel({
  steps,
  visibleSteps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  className,
}: ReasoningPanelProps) {
  const shown = steps.slice(0, Math.max(0, Math.min(visibleSteps, steps.length)));

  // While streaming, the open trace is a bottom-pinned live preview: it stays
  // scrolled to the newest text until the reader scrolls up, and resumes once
  // they are back near the bottom (matches the element's Anatomy).
  const listRef = useRef<HTMLOListElement | null>(null);
  const stickToBottom = useRef(true);
  const wasStreaming = useRef(streaming);
  useLayoutEffect(() => {
    if (streaming && !wasStreaming.current) stickToBottom.current = true;
    wasStreaming.current = streaming;
  });
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && open && streaming && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  return (
    <div className={className ? `reasoning ${className}` : "reasoning"}>
      <button
        type="button"
        className="reasoning-trigger"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span
          aria-hidden
          className={streaming ? "reasoning-marker reasoning-marker--active" : "reasoning-marker"}
        />
        <span className="reasoning-label">
          {streaming ? "Thinking…" : restingLabel}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className={open ? "reasoning-chevron reasoning-chevron--open" : "reasoning-chevron"}
        >
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 6l4 4 4-4"
          />
        </svg>
      </button>
      {open && (
        <ol
          ref={listRef}
          className="reasoning-steps"
          onScroll={() => {
            const el = listRef.current;
            if (!el) return;
            const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            if (stickToBottom.current !== nearBottom) stickToBottom.current = nearBottom;
          }}
        >
          {shown.map((step, i) => {
            const active = streaming && i === shown.length - 1;
            return (
              <li key={i} className="reasoning-step">
                <span
                  aria-hidden
                  className={active ? "reasoning-marker reasoning-marker--active" : "reasoning-marker"}
                />
                <span className="reasoning-step-content">
                  <p className="reasoning-step-title">{step.title}</p>
                  <p className="reasoning-step-body">{step.body}</p>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * Maps the current message's `reasoning` parts onto the panel, following the
 * step-panel wiring in the docs: one step per part, auto-expanded while the
 * reasoning is still streaming, and the reader's first manual toggle sticks.
 */
export function AssistantReasoning() {
  const parts = useAuiState((s) => s.message.parts);
  const steps = useMemo<ReasoningStep[]>(
    () =>
      parts.flatMap((part) =>
        part.type === "reasoning"
          ? [{ title: part.unstable_summary ?? "Thinking", body: part.text }]
          : [],
      ),
    [parts],
  );
  const streaming = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    return s.message.parts.some(
      (part) => part.type === "reasoning" && part.status?.type === "running",
    );
  });
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  if (steps.length === 0) return null;

  return (
    <ReasoningPanel
      steps={steps}
      visibleSteps={steps.length}
      streaming={streaming}
      open={userOpen ?? streaming}
      onOpenChange={(open) => setUserOpen(open)}
      restingLabel="Done thinking"
    />
  );
}
