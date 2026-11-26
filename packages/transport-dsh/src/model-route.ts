import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

/** The provider route a freshly created dsh agent should run on. */
export interface ModelSelection {
  provider: string;
  model: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function selection(value: unknown): ModelSelection | null {
  if (!record(value)) return null;
  const provider = text(value.provider);
  const model = text(value.model);
  return provider && model ? { provider, model } : null;
}

/** First model id a hand-declared pi-ai route advertises. */
function firstModel(route: Record<string, unknown>): string | undefined {
  if (!Array.isArray(route.models)) return undefined;
  for (const entry of route.models) {
    if (typeof entry === "string") {
      const id = text(entry);
      if (id) return id;
    } else if (record(entry)) {
      const id = text(entry.id);
      if (id) return id;
    }
  }
  return undefined;
}

/**
 * Resolve the provider/model an SDK-created agent runs on WITHOUT imposing a
 * project-owned default provider.
 *
 * Order:
 * 1. an explicit binding/env pair (the Workbench Model tab or DSH_PROVIDER /
 *    DSH_MODEL),
 * 2. the harness's own `agent-default-model` settings section,
 * 3. the only configured `llm-pi-ai` route, when it advertises a model.
 *
 * The caller keeps its last-resort fallback (the built-in DeepSeek route).
 * A missing or unparsable settings file simply yields no automatic selection.
 */
export async function resolveModelSelection(options: {
  dshHome: string;
  provider?: string;
  model?: string;
}): Promise<ModelSelection | null> {
  const explicitProvider = text(options.provider);
  const explicitModel = text(options.model);
  if (explicitProvider && explicitModel) return { provider: explicitProvider, model: explicitModel };

  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = parse(await readFile(join(options.dshHome, "settings.yaml"), "utf8"));
    if (record(parsed)) settings = parsed;
  } catch {
    // No settings file, or a file whose YAML cannot be read here: no automatic
    // selection. The harness will validate whatever the caller falls back to.
  }

  const fromDefault = selection(settings["agent-default-model"]);
  if (fromDefault) return fromDefault;

  const pi = record(settings["llm-pi-ai"]) ? settings["llm-pi-ai"] : undefined;
  const providers = pi && record(pi.providers) ? pi.providers : undefined;
  if (!providers) return null;

  if (explicitProvider) {
    const route = providers[explicitProvider];
    if (record(route)) {
      const model = explicitModel ?? firstModel(route);
      if (model) return { provider: explicitProvider, model };
    }
    return null;
  }

  const routes = Object.entries(providers).filter(([, value]) => record(value));
  if (routes.length !== 1) return null;
  const [provider, route] = routes[0]!;
  const model = explicitModel ?? firstModel(route as Record<string, unknown>);
  return model ? { provider, model } : null;
}
