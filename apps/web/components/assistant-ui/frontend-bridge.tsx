"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  useAssistantToolUI,
  useAuiState,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MolqlError, MOLQL_TOOL_NAME } from "@science-studio/molql-viewer/directive";
import { executeAction } from "@/lib/frontend-actions/registry";
// Side-effect import: registers the `molql` action handler.
import "@/lib/frontend-actions/molql";

/**
 * Tool calls already dispatched in this page session. Keeps a re-render from
 * applying the same instruction twice.
 */
const dispatched = new Set<string>();

/** Per-tool-call outcome, so the chip can show whether the viewer applied it. */
type DispatchStatus = "applied" | "failed";
const results = new Map<string, DispatchStatus>();
const listeners = new Set<() => void>();

function setResult(id: string, status: DispatchStatus): void {
  results.set(id, status);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A primitive signature of every COMPLETED `molql` tool call in the thread:
 * `JSON.stringify([[toolCallId, result], ...])`.
 *
 * `useAuiState` compares the selector result with `Object.is`, so the selector
 * must return a primitive — an array would change identity every store update
 * and re-render forever.
 */
function molqlSignature(messages: readonly unknown[]): string {
  const completed: Array<[string, unknown]> = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const m = message as { role?: string; content?: unknown };
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; toolName?: string; toolCallId?: string; result?: unknown };
      if (p.type !== "tool-call" || p.toolName !== MOLQL_TOOL_NAME) continue;
      if (p.result === undefined || typeof p.toolCallId !== "string") continue;
      completed.push([p.toolCallId, p.result]);
    }
  }
  return completed.length ? JSON.stringify(completed) : "";
}

function parseSignature(signature: string): Array<[string, unknown]> {
  if (!signature) return [];
  try {
    const parsed = JSON.parse(signature) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<[string, unknown]>) : [];
  } catch {
    return [];
  }
}

/**
 * "No viewer / no structure / not ready yet" is expected when a selection
 * arrives before the user has a structure open — show the chip status without
 * treating it as an error. Anything else is a real bug worth logging.
 */
function isExpectedFailure(err: unknown): boolean {
  return (
    err instanceof MolqlError &&
    (err.code === "NO_VIEWER" || err.code === "NO_STRUCTURE" || err.code === "NOT_READY")
  );
}

/**
 * The presentational chip for one `molql` tool call. It performs NO side effect:
 * the tool UI lives inside a collapsed `ToolGroup`, so it only mounts once the
 * user expands the group — dispatching from here would delay the selection.
 */
function MolqlToolUI({ toolCallId, args }: ToolCallMessagePartProps) {
  const status = useSyncExternalStore(
    subscribe,
    () => results.get(toolCallId) ?? null,
    () => null,
  );
  const expression =
    args && typeof args === "object" && typeof (args as { molql?: unknown }).molql === "string"
      ? ((args as { molql: string }).molql)
      : null;

  return (
    <div
      data-slot="molql-tool-call"
      className="text-muted-foreground my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-xs"
    >
      <span className="text-foreground font-medium">MolQL</span>
      {expression && <span className="min-w-0 truncate">{expression}</span>}
      <span>
        {status === "applied"
          ? "applied"
          : status === "failed"
            ? "not applied — open a structure file first"
            : "selection"}
      </span>
    </div>
  );
}

/**
 * The agent→UI bridge.
 *
 * Renders nothing. It observes the thread ALWAYS (regardless of whether the tool
 * group is expanded) and dispatches each `molql` call produced by a LIVE run
 * exactly once, so a selection reaches the viewer without expanding the tool
 * call — and a page/session load does NOT replay old selections from history
 * (which would fail with no viewer open).
 */
export function FrontendBridge() {
  // Keep the chip renderer registered for `molql` tool-call parts.
  useAssistantToolUI({ toolName: MOLQL_TOOL_NAME, render: MolqlToolUI });

  const isRunning = useAuiState((s) => s.thread.isRunning);
  const signature = useAuiState((s) => molqlSignature(s.thread.messages));
  const wasRunning = useRef(false);

  useEffect(() => {
    // Apply only during a run, plus the single observation where the run just
    // ended (the tool result can land on the same tick as the settle).
    const live = isRunning || wasRunning.current;
    wasRunning.current = isRunning;
    if (!live) return;

    for (const [toolCallId, result] of parseSignature(signature)) {
      if (dispatched.has(toolCallId)) continue;
      dispatched.add(toolCallId);
      void executeAction(MOLQL_TOOL_NAME, result)
        .then(() => setResult(toolCallId, "applied"))
        .catch((err: unknown) => {
          setResult(toolCallId, "failed");
          if (!isExpectedFailure(err)) {
            console.error(`[frontend-actions] "${MOLQL_TOOL_NAME}" failed:`, err);
          }
        });
    }
  }, [signature, isRunning]);

  return null;
}
