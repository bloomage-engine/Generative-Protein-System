"use client";

import { useMemo } from "react";
import { useAuiState } from "@assistant-ui/react";

/**
 * Reasoning-trace mapping shared by reasoning UIs: from the current message's
 * assistant-ui content parts, derive one titled step per `reasoning` part plus
 * whether the reasoning is still streaming. The panel skin (registry vs plain
 * CSS, single-collapsible vs step-panel) stays per app; the part → trace
 * mapping lives here so every app reads the same fields (`unstable_summary`,
 * per-part `status`) and the same fallbacks.
 */

/** One titled reasoning step. */
export interface ReasoningStep {
  title: string;
  body: string;
}

/** The content-part slice a reasoning trace reads. */
export interface ReasoningTracePart {
  type: string;
  text?: string;
  unstable_summary?: string;
  status?: { type?: string };
}

export interface ReasoningTrace {
  /** One step per reasoning part, in order. */
  steps: ReasoningStep[];
  /** True while the message is running AND a reasoning part is streaming. */
  streaming: boolean;
}

/**
 * Pure trace mapping. `status` is the message's status (`{ type: "running" }`
 * while a turn is in flight); a step's title falls back to "Thinking" when the
 * part carries no summary.
 */
export function buildReasoningTrace(
  parts: readonly ReasoningTracePart[],
  status: { type?: string } | undefined,
): ReasoningTrace {
  const steps: ReasoningStep[] = [];
  let streaming = false;
  if (status?.type === "running") {
    for (const part of parts) {
      if (part.type === "reasoning" && part.status?.type === "running") {
        streaming = true;
        break;
      }
    }
  }
  for (const part of parts) {
    if (part.type === "reasoning") {
      steps.push({ title: part.unstable_summary ?? "Thinking", body: part.text ?? "" });
    }
  }
  return { steps, streaming };
}

/** The reasoning trace of the message currently in context. */
export function useMessageReasoningTrace(): ReasoningTrace {
  const parts = useAuiState((s) => s.message.parts);
  const status = useAuiState((s) => s.message.status);
  return useMemo(
    () => buildReasoningTrace(parts as readonly ReasoningTracePart[], status),
    [parts, status],
  );
}
