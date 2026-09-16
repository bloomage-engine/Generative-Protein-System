/**
 * Apply the Model tab's Endpoint / API Key to the harness's OWN route.
 *
 * For the pinned harness a provider ROUTE (`llm-pi-ai.providers.<id>`) carries
 * its `baseURL` and the NAME of its credential env (`apiKeyEnv`); there is no
 * launch-env override for the base URL. So this merges the endpoint into
 * `<dshHome>/settings.yaml` (a comment-preserving leaf patch — the harness
 * hot-watches the file) and returns the env the child must inherit for its
 * credential.
 *
 * Best-effort by contract: a caller catches failures and lets `init` continue
 * on whatever route was already configured.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";

export interface RouteSettingsInput {
  /** The harness home (its `settings.yaml` lives here). */
  home: string;
  /** The provider route id. */
  provider: string;
  /** The model id, used only when a route is created. */
  model?: string;
  /** The route's base URL. */
  endpoint?: string;
  /** The route's credential value. */
  apiKey?: string;
}

function credentialEnvName(provider: string): string {
  const sanitized = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${sanitized || "PROVIDER"}_API_KEY`;
}

export async function applyRouteSettings(
  input: RouteSettingsInput,
): Promise<{ env: Record<string, string> } | null> {
  if (!input.endpoint && !input.apiKey) return null;
  const file = join(input.home, "settings.yaml");
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
  const doc = parseDocument(text);
  const routePath = ["llm-pi-ai", "providers", input.provider];

  // An endpoint-only call must not invent a credential name: the route may get
  // its key from an ambient env var whose NAME this function cannot know. Only a
  // supplied key resolves (and, if new, writes) `apiKeyEnv`.
  const routeMissing = doc.getIn(routePath) === undefined;
  const changesEndpoint =
    input.endpoint !== undefined && (routeMissing || input.endpoint !== doc.getIn([...routePath, "baseURL"]));
  if (!changesEndpoint && !input.apiKey) return null;

  if (input.endpoint !== undefined) doc.setIn([...routePath, "baseURL"], input.endpoint);
  if (doc.getIn([...routePath, "api"]) === undefined) {
    doc.setIn([...routePath, "api"], "openai-completions");
  }
  if (doc.getIn([...routePath, "models"]) === undefined && input.model) {
    doc.setIn([...routePath, "models"], [{ id: input.model }]);
  }

  let credentialName: string | undefined;
  if (input.apiKey) {
    const existingKeyEnv = doc.getIn([...routePath, "apiKeyEnv"]);
    credentialName =
      typeof existingKeyEnv === "string" && existingKeyEnv !== ""
        ? existingKeyEnv
        : credentialEnvName(input.provider);
    if (credentialName !== existingKeyEnv) doc.setIn([...routePath, "apiKeyEnv"], credentialName);
  }

  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, doc.toString(), { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);

  return { env: input.apiKey && credentialName ? { [credentialName]: input.apiKey } : {} };
}
