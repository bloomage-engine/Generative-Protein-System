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
  presetToExpression,
  taskIdFromPath,
  type CronLogEntry,
  type CronRunStatus,
  type CronTask,
  type SchedulePreset,
} from "@science-studio/cron";

export {
  CRON_DIR,
  SCHEDULE_PRESETS,
  cronLogPath,
  cronTaskPath,
  describeSchedule,
  isCronTaskPath,
  isValidSchedule,
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
  projectId: string | null;
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

export async function fetchCronTasks(
  api: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<{ tasks: CronTaskSummary[]; invalid: CronInvalidFile[] }> {
  const res = await fetch(`${api}?${new URLSearchParams({ projectId })}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`cron ${res.status}`);
  const body = (await res.json()) as { tasks?: CronTaskSummary[]; invalid?: CronInvalidFile[] };
  return { tasks: body.tasks ?? [], invalid: body.invalid ?? [] };
}

export function useCronTasks(options: UseCronTasksOptions): CronTasksState {
  const { api = DEFAULT_CRON_API, projectId, enabled, intervalMs = 2000 } = options;
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
        const next = await fetchCronTasks(api, projectId, controller.signal);
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

export async function fetchCronTask(api: string, projectId: string, id: string): Promise<CronTask> {
  const body = await requestJson<{ task: CronTask }>(
    `${api}/task?${new URLSearchParams({ projectId, id })}`,
    "GET",
  );
  return body.task;
}

export async function createCronTask(
  api: string,
  projectId: string,
  input: CronTaskInput,
): Promise<CronTask> {
  const body = await requestJson<{ task: CronTask }>(
    `${api}/task?${new URLSearchParams({ projectId })}`,
    "POST",
    input,
  );
  return body.task;
}

export async function saveCronTask(api: string, projectId: string, task: CronTask): Promise<CronTask> {
  const body = await requestJson<{ task: CronTask }>(
    `${api}/task?${new URLSearchParams({ projectId, id: task.id })}`,
    "PUT",
    task,
  );
  return body.task;
}

export async function deleteCronTask(api: string, projectId: string, id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`${api}/task/delete?${new URLSearchParams({ projectId, id })}`, "POST");
}

export async function runCronTask(api: string, projectId: string, id: string): Promise<CronRunStatus> {
  const body = await requestJson<{ status: CronRunStatus }>(
    `${api}/task/run?${new URLSearchParams({ projectId, id })}`,
    "POST",
  );
  return body.status;
}
