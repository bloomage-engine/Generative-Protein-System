import type { CommandDescriptor } from "@gps/transport";

/**
 * Runtime command mapping for the openclaw gateway (docs/adr/0003).
 *
 * The gateway exposes its own command catalog via `commands.list`; the adapter
 * curates that catalog into the seam's runtime-agnostic `CommandDescriptor`s.
 * Curation is a v1 product-scope allowlist — session/run controls and
 * discovery commands that are meaningful and safe in the research web UI —
 * while the gateway's catalog still gates availability: a command only appears
 * when the gateway actually reports it (config switches, authorization, model
 * state). Channel-only, management, media, skill and plugin commands are
 * intentionally left out of the app UI.
 */
export const OPENCLAW_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  // Model & run controls (session-scoped, no required arguments).
  "model",
  "think",
  "fast",
  "reasoning",
  "verbose",
  "trace",
  "elevated",
  // Discovery / status.
  "status",
  "tools",
  "help",
  "whoami",
  "context",
]);

/**
 * Minimal structural view of a gateway `commands.list` entry (`CommandEntry`
 * in @openclaw/gateway-protocol). Kept local & structural so the mapping stays
 * testable against fixtures and resilient to catalog field drift.
 */
export type GatewayCommandEntry = {
  name: string;
  nativeName?: string;
  textAliases?: string[];
  description: string;
  category?:
    | "session"
    | "options"
    | "status"
    | "management"
    | "media"
    | "tools"
    | "docks";
  source: "native" | "skill" | "plugin";
  scope: "text" | "native" | "both";
  acceptsArgs: boolean;
  args?: Array<{
    name: string;
    description: string;
    type: string;
    required?: boolean;
    choices?: Array<{ value: string; label: string }>;
    dynamic?: boolean;
  }>;
};

function hasRequiredArgs(entry: GatewayCommandEntry): boolean {
  return (entry.args ?? []).some((a) => a.required === true);
}

/** Curate gateway `commands.list` entries into seam command descriptors. */
export function mapCommandEntries(
  entries: readonly GatewayCommandEntry[],
): CommandDescriptor[] {
  const out: CommandDescriptor[] = [];
  for (const entry of entries) {
    if (!OPENCLAW_COMMAND_ALLOWLIST.has(entry.name)) continue;
    // Skills and plugins are research-tool surfaces, not app commands; native-
    // only commands have no text form to invoke over chat.
    if (entry.source !== "native") continue;
    if (entry.scope === "native") continue;
    // v1 menu runs no-argument commands only (no argument-collection UX).
    if (hasRequiredArgs(entry)) continue;
    out.push({
      id: entry.name,
      label: entry.name,
      description: entry.description,
      ...(entry.category !== undefined ? { category: entry.category } : {}),
      // The canonical text invocation; the gateway interprets the message.
      invocationText: `/${entry.name}`,
    });
  }
  return out;
}
