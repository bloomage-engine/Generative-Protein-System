import type { RuntimePlugin } from "@science-studio/transport";
import { createDshRuntimeFactory } from "./adapter.js";
import { dshLocalBinding } from "./binding.js";

export { DshRuntimeAdapter, createDshRuntimeFactory } from "./adapter.js";
export type { DshRuntimeAdapterOptions } from "./adapter.js";
export { DSH_CAPABILITIES, dshBinding, dshLocalBinding, parseDshBinding } from "./binding.js";
export type { DshBinding } from "./binding.js";
export { createDshTurnClient } from "./client.js";
export type { DshTurnClient, DshClientLaunchOptions } from "./client.js";
export { TranscriptMirror } from "./mirror.js";
export type { MirrorFile } from "./mirror.js";
export { FileSubagentLedger } from "./ledger.js";
export type { LedgerFile } from "./ledger.js";
export type { SubagentLedgerEntry, SubagentLedgerStore } from "./subagents.js";
export type { SubagentDescriptorInfo, SubagentFinishedInfo } from "./subagents.js";
export { applyRouteSettings } from "./route-settings.js";
export type { RouteSettingsInput } from "./route-settings.js";

/**
 * The package's plugin export. The service dynamically imports runtime modules
 * (by specifier) and collects `runtimePlugins` — no static dependency on this
 * package, so adding/replacing a runtime never edits a core package.
 */
export const runtimePlugins: RuntimePlugin[] = [
  { runtime: "dsh", factory: createDshRuntimeFactory(), localBinding: dshLocalBinding },
];
