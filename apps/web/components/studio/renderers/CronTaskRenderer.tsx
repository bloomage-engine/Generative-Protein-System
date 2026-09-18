"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, Trash2 } from "lucide-react";
import {
  DEFAULT_CRON_API,
  cronLogPath,
  deleteCronTask,
  describeSchedule,
  fetchCronTask,
  runCronTask,
  saveCronTask,
  taskIdFromPath,
  type CronTask,
} from "@science-studio/transport-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useStudioStore } from "@/store/studio-store";

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
        <Input value={task.schedule} onChange={(event) => patch({ schedule: event.target.value })} />
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
    </div>
  );
}
