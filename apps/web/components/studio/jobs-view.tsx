"use client";

import { useState } from "react";
import { RefreshCw, Server, XCircle } from "lucide-react";
import type { ComputeJob } from "@gps/transport-client";
import { DEFAULT_HPC_API, DEFAULT_WORKTREE_ID, cancelHpcJob, isOpenComputeJobState, useHpcJobs } from "@gps/transport-client";
import { Button } from "@/components/ui/button";
import { ModuleEmptyState, SidebarSection } from "./sidebar-section";
import { useStudioStore } from "@/store/studio-store";

/** The ledger's chip palette — one shade per Compute Job State. */
export const JOB_STATE_CLASS: Record<string, string> = {
  submitted: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-zinc-500/15 text-zinc-500 dark:text-zinc-400",
  unknown: "bg-zinc-500/15 text-zinc-500 dark:text-zinc-400",
};

function elapsed(job: ComputeJob): string {
  const from = new Date(job.startedAt ?? job.submittedAt).getTime();
  const to = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * The Jobs panel (docs/adr/0024): a PROJECT-level section over the Compute Job
 * ledger. The ledger is the read model — this list never triggers a cluster
 * query; the Refresh button asks the service for one forced reconcile tick.
 * A row double-clicks into the `hpc:<jobId>` detail/log tab.
 */
export function JobsView() {
  const open = useStudioStore((s) => s.rightSections.jobs);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.jobs);
  const projectId = useStudioStore((s) => s.projectId);
  const activeWorktreeId = useStudioStore((s) => s.activeWorktreeId);
  const sessions = useStudioStore((s) => s.sessions);
  const openJob = useStudioStore((s) => s.openJob);
  const [actionError, setActionError] = useState<string | null>(null);
  const { jobs, error, refresh, isRefreshing } = useHpcJobs({
    scope: { projectId },
    enabled: open && projectId !== null,
  });

  return (
    <SidebarSection
      section="jobs"
      title="Jobs"
      icon={Server}
      open={open}
      onOpenChange={() => toggleRightSection("jobs")}
      className={open ? "shrink-0" : undefined}
      style={open ? { height } : undefined}
      actions={
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6"
          aria-label="Reconcile jobs now"
          disabled={projectId === null || isRefreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
        </Button>
      }
    >
      {projectId === null ? (
        <ModuleEmptyState icon={Server} message="No Project." hint="Pick a Project to list its Compute Jobs." />
      ) : jobs.length === 0 ? (
        <ModuleEmptyState
          icon={Server}
          message="No Compute Jobs."
          hint="Bind an endpoint in Settings → HPC; the agent submits from there."
        />
      ) : (
        <ul className="flex h-full flex-col gap-1 overflow-auto p-2" aria-label="Compute jobs">
          {jobs.map((job) => {
            const openState = isOpenComputeJobState(job.state);
            const source = job.sessionKey ? sessions.find((s) => s.id === job.sessionKey) : undefined;
            return (
              <li key={job.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onDoubleClick={() => openJob(job.id, job.name)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") openJob(job.id, job.name);
                  }}
                  className="border-border/60 hover:bg-accent/50 flex w-full flex-col gap-1 rounded-md border px-2 py-1.5 text-left"
                  title={`${job.name} (${job.id})`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${JOB_STATE_CLASS[job.state] ?? ""}`}
                    >
                      {job.state}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{job.name}</span>
                    {openState ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="h-6 w-6 shrink-0"
                        aria-label={`Cancel ${job.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (
                            window.confirm(
                              `Cancel Compute Job "${job.name}"? The cluster is told to stop it; work already produced stays on it.`,
                            )
                          ) {
                            setActionError(null);
                            cancelHpcJob(DEFAULT_HPC_API, { projectId }, job.id).catch((err: unknown) =>
                              setActionError(err instanceof Error ? err.message : String(err)),
                            );
                          }
                        }}
                      >
                        <XCircle className="size-3.5 text-muted-foreground" />
                      </Button>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
                    {job.remoteJobId ? <span className="shrink-0">#{job.remoteJobId}</span> : null}
                    <span className="truncate">{job.endpointId}</span>
                    {job.resources?.partition ? <span className="truncate">· {job.resources.partition}</span> : null}
                    <span className="shrink-0">· {elapsed(job)}</span>
                    <span className="text-muted-foreground/70 ml-auto shrink-0">
                      {new Date(job.submittedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                    {source ? (
                      <button
                        type="button"
                        className="bg-muted/60 hover:bg-muted shrink-0 truncate rounded-full px-1.5 py-0.5"
                        title={source.title ?? source.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          const store = useStudioStore.getState();
                          store.setScope({
                            projectId,
                            worktreeId: activeWorktreeId ?? DEFAULT_WORKTREE_ID,
                            sessionId: source.id,
                          });
                          store.revealLeftView("thread");
                        }}
                      >
                        {source.title ?? "session"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error || actionError ? <p className="text-destructive px-2 pb-1 text-[10px]">{actionError ?? error}</p> : null}
    </SidebarSection>
  );
}
