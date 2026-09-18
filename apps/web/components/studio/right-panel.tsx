"use client";

import { useEffect, useRef } from "react";
import { CronView } from "./cron-view";
import { SubagentsView } from "./subagents-view";
import { WorkspaceTree } from "./workspace-tree";
import { useStudioStore } from "@/store/studio-store";

const MIN_SECTION_PX = 120;
const FILES_MIN_PX = 72;
const HANDLE_PX = 4;
const COLLAPSED_HEADER_PX = 30;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * A drag handle on a module's TOP edge — between it and the module above. It
 * resizes the module it sits on the edge of, taking space from the module
 * DIRECTLY above that edge: Subagents when Subagents is the neighbour (so the
 * edge only ever trades between the two modules it separates), otherwise the
 * flexible Files filler. Dragging the Subagents/Cron edge therefore never makes
 * the top module (Files) reflow.
 */
function ResizeHandle({ section, label }: { section: "subagents" | "cron"; label: string }) {
  const setHeight = useStudioStore((s) => s.setRightSectionHeight);
  const setRightHeights = useStudioStore((s) => s.setRightHeights);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      onPointerDown={(event) => {
        event.preventDefault();
        const handle = event.currentTarget;
        const containerHeight = handle.parentElement?.clientHeight ?? 600;
        const startY = event.clientY;
        const state = useStudioStore.getState();
        const heights = state.rightHeights;
        const startHeight = heights[section];

        // The donor is the module ABOVE this edge. For the Cron edge that is
        // Subagents while it is open — a fixed module — so space is moved
        // BETWEEN the two fixed modules (their sum stays constant and Files is
        // untouched). Otherwise the donor is the flexible Files filler.
        const donor: "files" | "subagents" =
          section === "cron" && state.rightSections.subagents ? "subagents" : "files";

        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
          /* pointer already captured */
        }

        const onMove = (moveEvent: PointerEvent) => {
          const delta = startY - moveEvent.clientY;
          if (donor === "subagents") {
            // Fixed donor: redistribute the pair's constant sum so Subagents
            // gives up exactly what Cron gains (and vice versa).
            const total = heights.subagents + heights.cron;
            const next = clamp(
              startHeight + delta,
              MIN_SECTION_PX,
              Math.max(MIN_SECTION_PX, total - MIN_SECTION_PX),
            );
            setRightHeights({ subagents: total - next, cron: next });
            return;
          }
          // Flexible donor: grow/shrink this module, Files absorbs the rest.
          const other = section === "subagents" ? "cron" : "subagents";
          const otherOpen = state.rightSections[other];
          const reserved =
            FILES_MIN_PX + HANDLE_PX + (otherOpen ? heights[other] + HANDLE_PX : COLLAPSED_HEADER_PX);
          const max = Math.max(MIN_SECTION_PX, containerHeight - reserved);
          setHeight(section, clamp(startHeight + delta, MIN_SECTION_PX, max));
        };
        const onUp = () => {
          try {
            handle.releasePointerCapture(event.pointerId);
          } catch {
            /* already released */
          }
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          cleanupRef.current = null;
        };
        cleanupRef.current = onUp;
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      }}
      className="bg-border hover:bg-primary/40 h-1 shrink-0 cursor-row-resize touch-none"
    />
  );
}

/**
 * The right pane: Files (the flexible filler, grows to fill) stacked above
 * Subagents and Cron (draggable fixed pixel heights). Each module is
 * independently collapsible to its header; collapse is an instant reflow (no
 * per-frame animation), and the freed space hands back to the open modules —
 * Files absorbs it when it is open.
 */
export function RightPanel({ project }: { project: string | null }) {
  const subagentsOpen = useStudioStore((s) => s.rightSections.subagents);
  const cronOpen = useStudioStore((s) => s.rightSections.cron);

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-y-auto border-l border-border/70 bg-background">
      <WorkspaceTree project={project} />
      {subagentsOpen && <ResizeHandle section="subagents" label="Resize Subagents" />}
      <SubagentsView />
      {cronOpen && <ResizeHandle section="cron" label="Resize Cron" />}
      <CronView />
    </aside>
  );
}
