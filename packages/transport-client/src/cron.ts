"use client";

import { useEffect, useState } from "react";
import {
  CRON_DIR,
  SCHEDULE_PRESETS,
  cronLogPath,
  cronTaskPath,
  describeSchedule,
  isCronTaskPath,
  isValidSchedule,
  parseLogEntries,
  presetToExpression,
  taskIdFromPath,
  type CronLogEntry,
  type CronRunStatus,
  type CronTask,
  type SchedulePreset,
} from "@science-studio/cron";
import { scopedUrl, type ClientScope } from "./scope.js";

export {
  CRON_DIR,
  SCHEDULE_PRESETS,
  cronLogPath,
  cronTaskPath,
  describeSchedule,
  isCronTaskPath,
  isValidSchedule,
  parseLogEntries,
  presetToExpression,
  taskIdFromPath,
};
export type { CronLogEntry, CronRunStatus, CronTask, SchedulePreset };

export const DEFAULT_CRON_API = "/api/cron";

export interface CronTaskSummary extends CronTask {
  path: string;
  lastRun?: CronLogEntry;
}

export interface CronInvalidFile {
  path: string;
  error: string;
}

export interface CronTaskInput {
  name: string;
  schedule: string;
  prompt: string;
  sessionId?: string;
  enabled?: boolean;
}

export interface UseCronTasksOptions {
  api?: string;
  /** The active Project (cron tasks live at the Project root — main only). */
  scope: ClientScope;
  enabled: boolean;
  intervalMs?: number;
}

export interface CronTasksState {
  tasks: CronTaskSummary[];
  invalid: CronInvalidFile[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

async function requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The cron surface is PROJECT-level and `main`-only (docs/adr/0017): the task
 * files live at the Project root and the service always reads them there, so a
 * Worktree claim is dropped.
 */
function projectScope(scope: ClientScope): ClientScope {
  return { projectId: scope.projectId };
}

export async function fetchCronTasks(
  api: string,
  scope: ClientScope,
  signal?: AbortSignal,
): Promise<{ tasks: CronTaskSummary[]; invalid: CronInvalidFile[] }> {
  const res = await fetch(scopedUrl(api, "", projectScope(scope)), {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`cron ${res.status}`);
  const body = (await res.json()) as { tasks?: CronTaskSummary[]; invalid?: CronInvalidFile[] };
  return { tasks: body.tasks ?? [], invalid: body.invalid ?? [] };
}

export function useCronTasks(options: UseCronTasksOptions): CronTasksState {
  const { api = DEFAULT_CRON_API, scope, enabled, intervalMs = 2000 } = options;
  const projectId = scope.projectId;
  const [tasks, setTasks] = useState<CronTaskSummary[]>([]);
  const [invalid, setInvalid] = useState<CronInvalidFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled || projectId === null) return;
    let active = true;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const next = await fetchCronTasks(api, { projectId }, controller.signal);
        if (!active) return;
        setTasks(next.tasks);
        setInvalid(next.invalid);
        setError(null);
      } catch (err) {
        if (active && !controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [api, projectId, enabled, intervalMs, revision]);

  return { tasks, invalid, loading, error, refresh: () => setRevision((n) => n + 1) };
}

export async function fetchCronTask(api: string, scope: ClientScope, id: string): Promise<CronTask> {
  const body = await requestJson<{ task: CronTask }>(
    scopedUrl(api, "/task", projectScope(scope), { id }),
    "GET",
  );
  return body.task;
}

export async function createCronTask(
  api: string,
  scope: ClientScope,
  input: CronTaskInput,
): Promise<CronTask> {
  const body = await requestJson<{ task: CronTask }>(
    scopedUrl(api, "/task", projectScope(scope)),
    "POST",
    input,
  );
  return body.task;
}

export async function saveCronTask(api: string, scope: ClientScope, task: CronTask): Promise<CronTask> {
  const body = await requestJson<{ task: CronTask }>(
    scopedUrl(api, "/task", projectScope(scope), { id: task.id }),
    "PUT",
    task,
  );
  return body.task;
}

export async function deleteCronTask(api: string, scope: ClientScope, id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(
    scopedUrl(api, "/task/delete", projectScope(scope), { id }),
    "POST",
  );
}

export async function runCronTask(api: string, scope: ClientScope, id: string): Promise<CronRunStatus> {
  const body = await requestJson<{ status: CronRunStatus }>(
    scopedUrl(api, "/task/run", projectScope(scope), { id }),
    "POST",
  );
  return body.status;
}
