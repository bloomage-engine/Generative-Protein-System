"use client";

import { Bot, History } from "lucide-react";
import { useSubagents, useSubagentsWindow } from "@gps/transport-client";
import type { SubagentRun } from "@gps/transport";
import { isRecent, windowMsFromHours } from "./subagents-window";
import { Button } from "@/components/ui/button";
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

/**
 * A label is a display name only when it reads like one. Anything that is
 * itself an id (a UUID, or a long opaque token with no whitespace) falls back
 * to an ordinal — the raw id stays in the tooltip and on the wire.
 */
function looksLikeId(value: string): boolean {
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) return true;
  return value.replace(/\s+/g, "").length > 24;
}

function displayName(run: SubagentRun, index: number): string {
  const label = run.label?.trim();
  if (label !== undefined && label.length > 0 && !looksLikeId(label)) return label;
  return `Subagent ${String.fromCharCode(65 + (index % 26))}`;
}

function SubagentRow({ run, index, open }: { run: SubagentRun; index: number; open: (run: SubagentRun) => void }) {
  return (
    <li
      className="border-border/60 hover:bg-accent/40 flex cursor-default flex-col gap-1 rounded-md border px-2 py-1.5"
      title={`${displayName(run, index)} — ${run.label ?? run.id}${run.label ? "" : " (id)"}`}
      onDoubleClick={() => open(run)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">{displayName(run, index)}</span>
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

/**
 * The Subagents module: the active Session's live dsh subagent runs
 * (running by default), with the finished history behind the History toggle —
 * both durable across service restarts (docs/adr/0016 addendum). A row is
 * double-clicked to open the child's own session record in a tab.
 */
export function SubagentsView() {
  const open = useStudioStore((s) => s.rightSections.subagents);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.subagents);
  const projectId = useStudioStore((s) => s.projectId);
  const activeWorktreeId = useStudioStore((s) => s.activeWorktreeId);
  const activeSessionId = useStudioStore((s) => s.activeSessionId);
  const showHistory = useStudioStore((s) => s.subagentsShowHistory);
  const setShowHistory = useStudioStore((s) => s.setSubagentsShowHistory);
  const openSubagent = useStudioStore((s) => s.openSubagent);

  const enabled = open && projectId !== null && activeSessionId !== null;
  // The ledger lives under the Session's OWN checkout, so the poll must carry
  // the active Worktree or a linked-worktree Session reads `main`'s empty list
  // (docs/adr/0025).
  const { subagents } = useSubagents({
    scope: { projectId, worktreeId: activeWorktreeId },
    threadId: activeSessionId,
    enabled,
  });
  // Gated on the module being open so a collapsed view never hits /api/settings.
  const { windowHours } = useSubagentsWindow({ enabled: open });

  const windowMs = windowMsFromHours(windowHours);
  const visible = showHistory ? subagents : subagents.filter((run) => isRecent(run, windowMs, Date.now()));
  const hidden = subagents.length - visible.length;

  const openTranscript = (run: SubagentRun): void => {
    // The tab records the Session it was opened in, so a later same-Project
    // Session switch re-fetches the record under the RIGHT session.
    openSubagent(run.id, run.label?.trim() || "Subagent", activeSessionId);
  };

  return (
    <SidebarSection
      section="subagents"
      title="Subagents"
      icon={Bot}
      open={open}
      onOpenChange={() => toggleRightSection("subagents")}
      className={open ? "shrink-0" : undefined}
      style={open ? { height } : undefined}
      actions={
        hidden > 0 || showHistory ? (
          <Button
            variant={showHistory ? "ghost" : "outline"}
            size="sm"
            className="h-7 gap-1 px-2 text-xs font-medium"
            aria-label={showHistory ? "Show recent only" : "Show past subagent runs"}
            aria-pressed={showHistory}
            onClick={() => setShowHistory(!showHistory)}
          >
            <History className="size-3.5" />
            {showHistory ? "Hide older" : `Show ${hidden} older`}
          </Button>
        ) : null
      }
    >
      {visible.length === 0 ? (
        hidden > 0 ? (
          <ModuleEmptyState
            icon={Bot}
            message={`No subagents in the last ${windowHours}h.`}
            hint={`Use the "Show ${hidden} older" button above to reveal them.`}
          />
        ) : (
          <ModuleEmptyState icon={Bot} message="No subagents yet." hint="Subagent runs will appear here." />
        )
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2" aria-label="Subagent runs">
            {visible.map((run, index) => (
              <SubagentRow key={run.id} run={run} index={index} open={openTranscript} />
            ))}
          </ul>
          {hidden > 0 && (
            <div className="border-border/60 border-t px-2 py-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-full justify-start gap-1 text-xs"
                aria-label="Show all older subagent runs"
                onClick={() => setShowHistory(true)}
              >
                <History className="size-3.5" />
                Show {hidden} older run{hidden === 1 ? "" : "s"}
              </Button>
            </div>
          )}
        </div>
      )}
    </SidebarSection>
  );
}
