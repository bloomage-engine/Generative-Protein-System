"use client";

import { useEffect, useState } from "react";
import type { SubagentRun, SubagentTranscript } from "@science-studio/transport";

/** The same-origin transport base (the web proxy path). */
export const DEFAULT_TRANSPORT_API = "/api/transport";

export interface SubagentScope {
  projectId: string | null;
  threadId: string | null;
}

/** The Project adapter's live subagent list. Throws on a non-2xx response. */
export async function fetchSubagents(
  api: string,
  scope: SubagentScope,
  signal?: AbortSignal,
): Promise<SubagentRun[]> {
  const query = new URLSearchParams();
  if (scope.projectId) query.set("projectId", scope.projectId);
  if (scope.threadId) query.set("threadId", scope.threadId);
  const res = await fetch(`${api}/subagents?${query.toString()}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`subagents ${res.status}`);
  const body = (await res.json()) as { subagents?: SubagentRun[] };
  return body.subagents ?? [];
}

export interface UseSubagentsOptions {
  /** Transport base; defaults to the same-origin `/api/transport`. */
  api?: string;
  projectId: string | null;
  threadId: string | null;
  /** False makes NO request (module collapsed, or no active session). */
  enabled: boolean;
  /** Poll cadence in ms (default 1500). */
  intervalMs?: number;
}

/**
 * Polls the live subagent list while enabled. A failed poll keeps the last good
 * list instead of blanking the panel; an in-flight request is aborted on
 * unmount or a scope change so a stale response cannot overwrite a newer scope.
 */
export function useSubagents(options: UseSubagentsOptions): { subagents: SubagentRun[] } {
  const { api = DEFAULT_TRANSPORT_API, projectId, threadId, enabled, intervalMs = 1500 } = options;
  const [subagents, setSubagents] = useState<SubagentRun[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const next = await fetchSubagents(api, { projectId, threadId }, controller.signal);
        if (active) setSubagents(next);
      } catch {
        // Transient failure (or abort): keep the previous list.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [api, projectId, threadId, enabled, intervalMs]);

  return { subagents };
}

/**
 * One delegated session's readable record. Throws on a non-2xx response —
 * the hook below turns that into its `error` state (the UI's friendly
 * "record unavailable").
 */
export async function fetchSubagentTranscript(
  api: string,
  project: string | null,
  childId: string,
  threadId?: string | null,
  signal?: AbortSignal,
): Promise<SubagentTranscript> {
  const query = new URLSearchParams();
  if (project) query.set("projectId", project);
  if (threadId) query.set("threadId", threadId);
  const res = await fetch(`${api}/subagents/${encodeURIComponent(childId)}/transcript?${query.toString()}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`subagent transcript ${res.status}`);
  const body = (await res.json()) as { transcript?: SubagentTranscript };
  if (body.transcript === undefined) throw new Error("subagent transcript body missing");
  return body.transcript;
}

export interface UseSubagentTranscriptOptions {
  /** Transport base; defaults to the same-origin `/api/transport`. */
  api?: string;
  project: string | null;
  threadId?: string | null;
  childId: string;
  /** False (or no project) makes NO request. */
  enabled: boolean;
}

/**
 * Fetch ONE child session's record. A failed fetch (404 / offline) lands in
 * the `error` state — the panel renders a friendly "not available"; the
 * request is aborted on unmount or a scope change.
 */
export function useSubagentTranscript(options: UseSubagentTranscriptOptions): {
  transcript: SubagentTranscript | null;
  isLoading: boolean;
  error: string | null;
} {
  const { api = DEFAULT_TRANSPORT_API, project, threadId, childId, enabled } = options;
  const [transcript, setTranscript] = useState<SubagentTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled || project === null) return;
    let active = true;
    const controller = new AbortController();
    setIsLoading(true);
    fetchSubagentTranscript(api, project, childId, threadId, controller.signal)
      .then((next) => {
        if (active) {
          setTranscript(next);
          setError(null);
        }
      })
      .catch(() => {
        if (active) {
          setTranscript(null);
          setError("unavailable");
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, project, threadId, childId, enabled]);

  return { transcript, isLoading, error };
}
