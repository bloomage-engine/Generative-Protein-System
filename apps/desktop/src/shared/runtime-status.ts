import type { DesktopConfig } from "./config.js";

export interface RuntimeStatus {
  dshPath: string | null;
  provider: string | null;
  model: string | null;
  ready: boolean;
}

export function runtimeStatus(input: { dshPath: string | null; config: DesktopConfig }): RuntimeStatus {
  const dshPath = input.dshPath;
  const provider = input.config.provider ?? null;
  const model = input.config.model ?? null;
  return {
    dshPath,
    provider,
    model,
    ready: dshPath !== null && provider !== null && model !== null,
  };
}
