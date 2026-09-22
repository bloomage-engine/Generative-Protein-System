"use client";

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import type { ComputeJob } from "@science-studio/transport-client";
import { DEFAULT_HPC_API, fetchHpcJob, fetchHpcJobLogs } from "@science-studio/transport-client";
import { Button } from "@/components/ui/button";
import { hpcTabJobId } from "../file-utils";
import { JOB_STATE_CLASS } from "../jobs-view";
import { useStudioStore } from "@/store/studio-store";

/**
 * The Compute Job tab (docs/adr/0024): the ledger row's details plus a tail
 * view of its stored stdout/stderr. Everything reads the service's ledger /
 * log routes — the tab never triggers a cluster query beyond the bounded
 * `tail -c` the logs route owns.
 */
export function HpcJobRenderer({ path, name }: { path: string; name: string }) {
  const projectId = useStudioStore((s) => s.projectId);
  const closeTab = useStudioStore((s) => s.closeTab);
  const jobId = hpcTabJobId(path);
  const [job, setJob] = useState<ComputeJob | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [log, setLog] = useState<{ text: string; error?: string } | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    if (!projectId || !jobId) return;
    let active = true;
    const controller = new AbortController();
    fetchHpcJob(DEFAULT_HPC_API, projectId, jobId, controller.signal)
      .then((next) => {
        if (active) {
          setJob(next);
          setJobError(null);
        }
      })
      .catch((err: unknown) => {
        if (active) setJobError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId, jobId]);

  // Open the tab with a first tail of stdout; the buttons re-tail on demand.
  useEffect(() => {
    if (!projectId || !jobId || !job) return;
    let active = true;
    const controller = new AbortController();
    setLogLoading(true);
    fetchHpcJobLogs(DEFAULT_HPC_API, projectId, jobId, "stdout", controller.signal)
      .then((next) => {
        if (active) setLog(next);
      })
      .catch((err: unknown) => {
        if (active) setLog({ text: "", error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        if (active) setLogLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId, jobId, job]);

  const loadLog = (which: "stdout" | "stderr") => {
    if (!projectId || !jobId) return;
    setStream(which);
    setLogLoading(true);
    fetchHpcJobLogs(DEFAULT_HPC_API, projectId, jobId, which)
      .then(setLog)
      .catch((err: unknown) =>
        setLog({ text: "", error: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => setLogLoading(false));
  };

  const detail = (label: string, value?: string | number | null) =>
    value === undefined || value === null || value === "" ? null : (
      <div key={label} className="flex items-baseline gap-2">
        <span className="text-muted-foreground w-24 shrink-0 text-[10px] uppercase">{label}</span>
        <span className="min-w-0 flex-1 truncate text-xs" title={String(value)}>
          {String(value)}
        </span>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={jobId}>
          {name}
        </span>
        {job ? (
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${JOB_STATE_CLASS[job.state] ?? ""}`}>
            {job.state}
          </span>
        ) : null}
        <Button variant="ghost" size="icon-xs" className="h-6 w-6" onClick={() => closeTab(path)} aria-label="Close tab">
          <X className="size-3.5" />
        </Button>
      </header>

      {jobError ? (
        <div className="p-3 text-xs text-destructive">{jobError}</div>
      ) : !job ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <section className="grid shrink-0 gap-1 border-b border-border/70 p-3 sm:grid-cols-2">
            {detail("Endpoint", `${job.endpointId} (${job.kind})`)}
            {detail("Remote id", job.remoteJobId ? `#${job.remoteJobId}` : "")}
            {detail("Project dir", job.remoteDir)}
            {detail("Resources", job.resources ? Object.entries(job.resources).map(([k, v]) => `${k}=${v}`).join(" · ") : "")}
            {detail("Nodes", job.nodeList)}
            {detail("Exit code", job.exitCode)}
            {detail("Submitted", new Date(job.submittedAt).toLocaleString())}
            {detail("Started", job.startedAt ? new Date(job.startedAt).toLocaleString() : "")}
            {detail("Finished", job.finishedAt ? new Date(job.finishedAt).toLocaleString() : "")}
            {detail("Error", job.error)}
          </section>
          {job.script || job.command ? (
            <details className="shrink-0 border-b border-border/70 px-3 py-2 text-xs">
              <summary className="text-muted-foreground cursor-pointer select-none">Script / command</summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed">
                {job.script ?? job.command}
              </pre>
            </details>
          ) : null}
          <div className="flex shrink-0 items-center gap-1 px-3 pt-2">
            {(["stdout", "stderr"] as const).map((which) => (
              <Button
                key={which}
                type="button"
                variant={stream === which ? "secondary" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => loadLog(which)}
              >
                {which}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={logLoading}
              onClick={() => loadLog(stream)}
            >
              {logLoading ? <Loader2 className="size-3 animate-spin" /> : null}
              Refresh log
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {log?.error ? <p className="text-xs text-destructive">{log.error}</p> : null}
            {log && log.text === "" && !log.error ? (
              <p className="text-xs text-muted-foreground">(empty)</p>
            ) : null}
            {log ? (
              <pre className="whitespace-pre-wrap break-all text-[11px] leading-relaxed">{log.text}</pre>
            ) : (
              <p className="text-xs text-muted-foreground">Loading {stream}…</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
