"use client";

import { CronView } from "./cron-view";
import { SubagentsView } from "./subagents-view";
import { WorkspaceTree } from "./workspace-tree";
import { useStudioStore } from "@/store/studio-store";

const MIN_SECTION_PX = 120;
const MAX_FRACTION = 0.6;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * A drag handle that resizes the module BELOW it by growing/shrinking the
 * pane's bottom edge. Dragging up grows the lower module; Files (`flex-1`)
 * absorbs the difference.
 */
function ResizeHandle({ section, label }: { section: "subagents" | "cron"; label: string }) {
  const setHeight = useStudioStore((s) => s.setRightSectionHeight);

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
        const startHeight = useStudioStore.getState().rightHeights[section];
        handle.setPointerCapture(event.pointerId);

        const onMove = (moveEvent: PointerEvent) => {
          const next = clamp(
            startHeight + (startY - moveEvent.clientY),
            MIN_SECTION_PX,
            Math.round(containerHeight * MAX_FRACTION),
          );
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
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      }}
      className="bg-border hover:bg-primary/40 h-1 shrink-0 cursor-row-resize"
    />
  );
}

/** The right pane: Files (flexible) stacked above Subagents and Cron. */
export function RightPanel({ project }: { project: string | null }) {
  const subagentsOpen = useStudioStore((s) => s.rightSections.subagents);
  const cronOpen = useStudioStore((s) => s.rightSections.cron);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border/70 bg-background">
      <WorkspaceTree project={project} />
      {subagentsOpen && <ResizeHandle section="subagents" label="Resize Subagents" />}
      <SubagentsView />
      {cronOpen && <ResizeHandle section="cron" label="Resize Cron" />}
      <CronView />
    </aside>
  );
}
