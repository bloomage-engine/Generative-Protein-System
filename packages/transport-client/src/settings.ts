"use client";

import type { RuntimeSettingsPatch, RuntimeSettingsView } from "@science-studio/transport";

export const DEFAULT_SETTINGS_API = "/api/settings";

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
  return api.replace(/\/+$/, "");
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
