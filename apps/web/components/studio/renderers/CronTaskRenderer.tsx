"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, Trash2 } from "lucide-react";
import {
  DEFAULT_CRON_API,
  SCHEDULE_PRESETS,
  cronLogPath,
  deleteCronTask,
  describeSchedule,
  fetchCronTask,
  parseLogEntries,
  presetToExpression,
  runCronTask,
  saveCronTask,
  taskIdFromPath,
  useWorkspaceFile,
  type CronRunStatus,
  type CronTask,
  type SchedulePreset,
} from "@science-studio/transport-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useStudioStore } from "@/store/studio-store";

const STATUS_CLASS: Record<CronRunStatus, string> = {
  success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "skipped-busy": "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  error: "bg-destructive/15 text-destructive",
};

/**
 * Cron is Project-`main`-only: the service scheduler and the `/api/cron*`
 * routes read `.science-studio/cron/` from the Project root, never a linked
 * checkout. This mirrors the reserved `DEFAULT_WORKTREE_ID` in the record /
 * transport-client packages, declared here on purpose so this renderer's read
 * decision is self-evident (the same browser-safe duplication lives in
 * `apps/web/lib/scope-memory.ts`). The run-log read below therefore pins `main`
 * explicitly: the workspace provider would otherwise fall back to the ACTIVE
 * worktree, so opening a `main` cron task while scoped to a linked worktree
 * showed an empty/404 log (docs/adr/0025).
 */
const DEFAULT_WORKTREE_ID = "main";

export function CronTaskRenderer({ path }: { path: string }) {
  const id = taskIdFromPath(path) ?? "";
  const projectId = useStudioStore((s) => s.projectId);
  const sessions = useStudioStore((s) => s.sessions);
  const openFile = useStudioStore((s) => s.openFile);
  const closeTab = useStudioStore((s) => s.closeTab);

  const [task, setTask] = useState<CronTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [preset, setPreset] = useState<SchedulePreset | "custom">("custom");

  const log = useWorkspaceFile(id === "" ? null : cronLogPath(id), {
    project: projectId,
    worktree: DEFAULT_WORKTREE_ID,
  });
  const runs = log.text ? parseLogEntries(log.text) : [];

  useEffect(() => {
    if (projectId === null || id === "") {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    fetchCronTask(DEFAULT_CRON_API, projectId, id)
      .then((next) => {
        if (active) setTask(next);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, id]);

  const patch = (next: Partial<CronTask>) => setTask((prev) => (prev ? { ...prev, ...next } : prev));

  const onSave = async () => {
    if (projectId === null || task === null) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await saveCronTask(DEFAULT_CRON_API, projectId, task);
      setTask(saved);
      setStatus("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRun = async () => {
    if (projectId === null || task === null) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setStatus((await runCronTask(DEFAULT_CRON_API, projectId, task.id)) === "success" ? "Ran successfully" : "Run did not complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (projectId === null || task === null) return;
    if (!window.confirm(`Delete “${task.name}”?`)) return;
    setBusy(true);
    try {
      await deleteCronTask(DEFAULT_CRON_API, projectId, task.id);
      closeTab(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center p-4">
        <Loader2 className="text-muted-foreground size-4 animate-spin" />
      </div>
    );
  }
  if (task === null) {
    return <p className="text-destructive p-3 text-xs">{error ?? "Task not found."}</p>;
  }

  return (
    <div className="flex flex-col gap-3 overflow-auto p-3 text-xs">
      <label className="flex flex-col gap-1">
        Name
        <Input value={task.name} onChange={(event) => patch({ name: event.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        Schedule
        <select
          aria-label="Schedule preset"
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={preset}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "custom") {
              setPreset("custom");
              return;
            }
            const next = value as SchedulePreset;
            setPreset(next);
            patch({ schedule: presetToExpression(next) });
          }}
        >
          <option value="custom">Custom</option>
          {SCHEDULE_PRESETS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <Input
          value={task.schedule}
          onChange={(event) => {
            setPreset("custom");
            patch({ schedule: event.target.value });
          }}
        />
        <span className="text-muted-foreground text-[10px]">{describeSchedule(task.schedule)}</span>
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={task.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />
        Enabled
      </label>
      <label className="flex flex-col gap-1">
        Target session
        <select
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={task.sessionId ?? ""}
          onChange={(event) => patch({ sessionId: event.target.value || undefined })}
        >
          <option value="">Most recent session</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title ?? session.id}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Prompt
        <Textarea value={task.prompt} onChange={(event) => patch({ prompt: event.target.value })} rows={8} />
      </label>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void onSave()} disabled={busy}>
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={() => void onRun()} disabled={busy}>
          <Play className="size-3.5" />
          Run now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openFile(cronLogPath(task.id), `${task.id}.log.md`)}
        >
          Open log
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive ml-auto" onClick={() => void onDelete()} disabled={busy}>
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      </div>
      {status ? <p className="text-muted-foreground">{status}</p> : null}
      {error ? <p className="text-destructive">{error}</p> : null}
      <div className="flex flex-col gap-1 border-t pt-2">
        <div className="text-muted-foreground font-medium">Recent runs</div>
        {log.isLoading ? (
          <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
        ) : runs.length === 0 ? (
          <p className="text-muted-foreground text-[10px]">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Recent cron runs">
            {runs.slice(0, 5).map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="flex items-start gap-2">
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[entry.status]}`}
                >
                  {entry.status}
                </span>
                <span className="text-muted-foreground shrink-0 text-[10px]">
                  {new Date(entry.at).toLocaleString()}
                </span>
                {entry.message ? (
                  <span
                    className="text-muted-foreground truncate text-[10px] opacity-70"
                    title={entry.message}
                  >
                    {entry.message}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
