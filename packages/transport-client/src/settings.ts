"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  RuntimeSettingsPatch,
  RuntimeSettingsView,
  SubagentSettings,
} from "@gps/transport";
import { scopedUrl } from "./scope.js";

export const DEFAULT_SETTINGS_API = "/api/settings";

/**
 * The effective subagent-list "recent window" hours. Pure: maps a (possibly
 * absent) subagents slice to the hours number the panel should use — default
 * 24 when absent, not a number, or out of range; clamped to 1..720.
 */
export function subagentWindowFromView(view: { subagents?: SubagentSettings }): number {
  const n = view?.subagents?.visibleWindowHours;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 24;
  return Math.max(1, Math.min(720, Math.trunc(n)));
}

export interface UseSubagentsWindowOptions {
  /** The settings API base; defaults to the same-origin `/api/settings`. */
  api?: string;
  /** False makes NO request (a collapsed module, or a test). */
  enabled?: boolean;
}

/**
 * Reads the settings view once and exposes its subagent recent-window as a
 * stable hours number. A fetch failure or an absent value leaves the panel at
 * the 24h default — the feature never wedges on the settings hop.
 */
export function useSubagentsWindow(options: UseSubagentsWindowOptions = {}): {
  windowHours: number;
} {
  const { api = DEFAULT_SETTINGS_API, enabled = true } = options;
  const [windowHours, setWindowHours] = useState(24);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    fetchSettings(api)
      .then((view) => {
        if (active) setWindowHours(subagentWindowFromView(view));
      })
      .catch(() => {
        if (active) setWindowHours(24);
      });
    return () => {
      active = false;
    };
  }, [api, enabled]);
  return useMemo(() => ({ windowHours }), [windowHours]);
}

export class SettingsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SettingsRequestError";
  }
}

function base(api: string): string {
  // The settings routes carry no Project/Worktree claim; this trims the base.
  return scopedUrl(api, "", { projectId: null });
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(input, { ...init, headers });
  if (!res.ok) {
    let message = `settings request failed: ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new SettingsRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

export async function fetchSettings(api: string = DEFAULT_SETTINGS_API): Promise<RuntimeSettingsView> {
  return request<RuntimeSettingsView>(base(api));
}

export async function updateSettings(
  api: string,
  patch: RuntimeSettingsPatch,
): Promise<RuntimeSettingsView> {
  return request<RuntimeSettingsView>(base(api), { method: "PUT", body: JSON.stringify(patch) });
}
