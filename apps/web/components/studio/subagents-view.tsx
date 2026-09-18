"use client";

import { Bot } from "lucide-react";
import { useSubagents } from "@science-studio/transport-client";
import type { SubagentRun } from "@science-studio/transport";
import { ModuleEmptyState, SidebarSection } from "./sidebar-section";
import { useStudioStore } from "@/store/studio-store";

const STATUS_LABEL: Record<SubagentRun["status"], string> = {
  running: "Running",
  completed: "Completed",
  aborted: "Aborted",
  error: "Error",
};

const STATUS_CLASS: Record<SubagentRun["status"], string> = {
  running: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  aborted: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  error: "bg-destructive/15 text-destructive",
};

/** How long a run has been (or was) active, in a compact form. */
function elapsed(run: SubagentRun): string {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A short, human-scannable child id when no label was reported. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function SubagentRow({ run }: { run: SubagentRun }) {
  return (
    <li className="border-border/60 flex flex-col gap-1 rounded-md border px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium" title={run.label ?? run.id}>
          {run.label ?? shortId(run.id)}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[run.status]}`}
        >
          {STATUS_LABEL[run.status]}
        </span>
      </div>
      <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
        {run.provider ? <span>{run.provider}</span> : null}
        {run.stopReason ? <span>{run.stopReason}</span> : null}
        <span className="ml-auto tabular-nums">{elapsed(run)}</span>
      </div>
    </li>
  );
}

/** The Subagents module: the active Session's live dsh subagent runs. */
export function SubagentsView() {
  const open = useStudioStore((s) => s.rightSections.subagents);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.subagents);
  const projectId = useStudioStore((s) => s.projectId);
  const activeSessionId = useStudioStore((s) => s.activeSessionId);

  const enabled = open && projectId !== null && activeSessionId !== null;
  const { subagents } = useSubagents({ projectId, threadId: activeSessionId, enabled });

  return (
    <SidebarSection
      section="subagents"
      title="Subagents"
      icon={Bot}
      open={open}
      onOpenChange={() => toggleRightSection("subagents")}
      className={open ? "shrink-0" : undefined}
      style={open ? { height } : undefined}
    >
      {subagents.length === 0 ? (
        <ModuleEmptyState
          icon={Bot}
          message="No subagents yet."
          hint="Subagent runs will appear here."
        />
      ) : (
        <ul
          className="flex h-full flex-col gap-1 overflow-auto p-2"
          aria-label="Subagent runs"
        >
          {subagents.map((run) => (
            <SubagentRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </SidebarSection>
  );
}
