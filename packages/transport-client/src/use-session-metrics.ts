"use client";

import { useEffect, useRef, useState } from "react";
import { fetchSessionRuns, DEFAULT_PROJECTS_API } from "./projects.js";
import { summarizeSessionRuns, type SessionMetrics } from "./session-metrics.js";

export interface UseSessionMetricsOptions {
  /** The record API base. Defaults to the same-origin `/api/projects`. */
  api?: string;
  projectId: string | null;
  sessionId: string | null;
  /** Bump to refetch (e.g. a run finished); a scope change refetches anyway. */
  revision?: number;
}

/**
 * The active Session's metrics, sourced from its persisted Runs (the record is
 * authoritative, so a reload converges). No scope → no request and `null`; a
 * failed fetch keeps the last value instead of blanking the bar; a stale
 * in-flight response is discarded so it cannot overwrite a newer scope's
 * numbers.
 */
export function useSessionMetrics(options: UseSessionMetricsOptions): SessionMetrics | null {
  const api = options.api ?? DEFAULT_PROJECTS_API;
  const { projectId, sessionId, revision = 0 } = options;
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null);
  // The value survives a re-render that happens before the new fetch settles.
  const lastRef = useRef<SessionMetrics | null>(null);

  useEffect(() => {
    if (!projectId || !sessionId) {
      lastRef.current = null;
      setMetrics(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const runs = await fetchSessionRuns(api, projectId, sessionId);
        if (!active) return;
        const next = summarizeSessionRuns(runs, sessionId);
        lastRef.current = next;
        setMetrics(next);
      } catch {
        // Transient record failure: keep the previous value, never throw.
      }
    })();
    return () => {
      active = false;
    };
  }, [api, projectId, sessionId, revision]);

  return metrics ?? lastRef.current;
}
