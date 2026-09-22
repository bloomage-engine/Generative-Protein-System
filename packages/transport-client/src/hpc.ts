"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComputeJob } from "@science-studio/record";
import type { HpcEndpointSettings } from "@science-studio/transport";
export { isOpenComputeJobState } from "@science-studio/hpc";

/** The same-origin HPC proxy base (the web hop). */
export const DEFAULT_HPC_API = "/api/hpc";

export class HpcRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HpcRequestError";
  }
}

function base(api: string): string {
  return api.replace(/\/+$/, "");
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(input, { ...init, headers });
  if (!res.ok) {
    let message = `hpc request failed: ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new HpcRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

function scoped(path: string, projectId: string | null): string {
  const query = new URLSearchParams();
  if (projectId) query.set("projectId", projectId);
  const merged = query.toString();
  return merged ? `${path}${path.includes("?") ? "&" : "?"}${merged}` : path;
}

// -- The deployment endpoints (the settings `hpc` section view) --------------

export async function fetchHpcEndpoints(
  api: string = DEFAULT_HPC_API,
  signal?: AbortSignal,
): Promise<HpcEndpointSettings[]> {
  const body = await request<{ endpoints: HpcEndpointSettings[] }>(`${base(api)}/endpoints`, { signal });
  return body.endpoints ?? [];
}

export interface HpcProbeResult {
  ok: boolean;
  os?: string;
  scheduler?: string;
  errors: string[];
}

export function probeHpcEndpoint(api: string, id: string): Promise<HpcProbeResult> {
  return request<HpcProbeResult>(`${base(api)}/endpoints/${encodeURIComponent(id)}/probe`, { method: "POST" });
}

// -- The Project HPC Binding --------------------------------------------------

export interface HpcBindingView {
  bound: boolean;
  raw?: string;
  binding?: {
    endpoint: string;
    partition?: string;
    workDir?: string;
    defaultTime?: string;
    notes: string;
  };
  error?: string;
}

export function fetchHpcBinding(
  api: string = DEFAULT_HPC_API,
  projectId: string | null = null,
  signal?: AbortSignal,
): Promise<HpcBindingView> {
  return request<HpcBindingView>(scoped(`${base(api)}/binding`, projectId), { signal });
}

export function saveHpcBinding(
  binding: { endpoint: string; partition?: string; workDir?: string; defaultTime?: string; notes?: string },
  api: string = DEFAULT_HPC_API,
  projectId: string | null = null,
): Promise<{ binding: unknown }> {
  return request(scoped(`${base(api)}/binding`, projectId), { method: "PUT", body: JSON.stringify(binding) });
}

// -- The Compute Job ledger ---------------------------------------------------

export async function listHpcJobs(
  api: string = DEFAULT_HPC_API,
  projectId: string | null = null,
  signal?: AbortSignal,
): Promise<ComputeJob[]> {
  const body = await request<{ jobs: ComputeJob[] }>(scoped(`${base(api)}/jobs`, projectId), { signal });
  return body.jobs ?? [];
}

export function fetchHpcJob(
  api: string = DEFAULT_HPC_API,
  projectId: string | null,
  jobId: string,
  signal?: AbortSignal,
): Promise<ComputeJob> {
  return request<{ job: ComputeJob }>(
    scoped(`${base(api)}/jobs/${encodeURIComponent(jobId)}`, projectId),
    { signal },
  ).then((body) => body.job);
}

export function refreshHpcJobs(
  api: string = DEFAULT_HPC_API,
  projectId: string | null,
): Promise<ComputeJob[]> {
  return request<{ jobs: ComputeJob[] }>(scoped(`${base(api)}/jobs/refresh`, projectId), { method: "POST" }).then(
    (body) => body.jobs ?? [],
  );
}

export function cancelHpcJob(
  api: string = DEFAULT_HPC_API,
  projectId: string | null,
  jobId: string,
): Promise<ComputeJob> {
  return request<{ job: ComputeJob }>(
    scoped(`${base(api)}/jobs/${encodeURIComponent(jobId)}/cancel`, projectId),
    { method: "POST" },
  ).then((body) => body.job);
}

export function fetchHpcJobLogs(
  api: string = DEFAULT_HPC_API,
  projectId: string | null,
  jobId: string,
  stream: "stdout" | "stderr",
  signal?: AbortSignal,
): Promise<{ text: string; error?: string }> {
  return request<{ text: string; error?: string }>(
    scoped(`${base(api)}/jobs/${encodeURIComponent(jobId)}/logs?stream=${stream}`, projectId),
    { signal },
  );
}

export interface UseHpcJobsOptions {
  /** HPC base; defaults to the same-origin `/api/hpc`. */
  api?: string;
  projectId: string | null;
  /** False makes NO request (module collapsed). */
  enabled: boolean;
  /** Poll cadence in ms (default 5000 — the ledger is reconciled every 15 s). */
  intervalMs?: number;
}

/**
 * Polls the Project's Compute Job ledger while enabled. The ledger is the read
 * model (docs/adr/0024) — this NEVER triggers a cluster query. A failed poll
 * keeps the last good list (docs/adr/0021); the in-flight request is aborted
 * on unmount or a scope change so no orphaned stream can pile up (the
 * connection-pool lesson of docs/adr/0009). `refresh` drives the service's
 * force-tick route and returns the fresh list.
 */
export function useHpcJobs(options: UseHpcJobsOptions): {
  jobs: ComputeJob[];
  error: string | null;
  refresh: () => Promise<void>;
  isRefreshing: boolean;
} {
  const { api = DEFAULT_HPC_API, projectId, enabled, intervalMs = 5000 } = options;
  const [jobs, setJobs] = useState<ComputeJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  useEffect(() => {
    if (!enabled || !projectId) return;
    let active = true;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const next = await listHpcJobs(api, projectId, controller.signal);
        if (active) {
          setJobs(next);
          setError(null);
        }
      } catch (err) {
        if (active && (err as Error)?.name !== "AbortError") setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [api, projectId, enabled, intervalMs]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const requested = projectId;
    setIsRefreshing(true);
    try {
      const next = await refreshHpcJobs(api, requested);
      // A scope switch while the forced tick runs: the poll loop owns the new
      // Project's list — a stale answer must not overwrite it (docs/adr/0009).
      if (projectRef.current !== requested) return;
      setJobs(next);
      setError(null);
    } catch (err) {
      if (projectRef.current === requested) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (projectRef.current === requested) setIsRefreshing(false);
    }
  }, [api, projectId]);

  return { jobs, error, refresh, isRefreshing };
}
