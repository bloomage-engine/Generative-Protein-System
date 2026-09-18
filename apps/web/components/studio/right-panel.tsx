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
 * A drag handle that resizes the module BELOW it (sets its fixed pixel height).
 * Dragging up/lower grows/shrinks that module; the flexible Files module above
 * absorbs the difference.
 */
function ResizeHandle({ section, label }: { section: "subagents" | "cron"; label: string }) {
  const setHeight = useStudioStore((s) => s.setRightSectionHeight);
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
        const startHeight = state.rightHeights[section];

        const other = section === "subagents" ? "cron" : "subagents";
        const otherOpen = state.rightSections[other];
        const reserved =
          FILES_MIN_PX + HANDLE_PX + (otherOpen ? state.rightHeights[other] + HANDLE_PX : COLLAPSED_HEADER_PX);
        const max = Math.max(MIN_SECTION_PX, containerHeight - reserved);

        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
          /* pointer already captured */
        }

        const onMove = (moveEvent: PointerEvent) => {
          const next = clamp(startHeight + (startY - moveEvent.clientY), MIN_SECTION_PX, max);
          setHeight(section, next);
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
