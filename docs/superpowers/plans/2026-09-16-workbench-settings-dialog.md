# Workbench Settings Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a settings button at the far left of the workbench's bottom status bar that opens a tabbed dialog (Model / Plugins / Agent), persisted by the service and applied to the dsh runtime after a restart.

**Architecture:** A deployment settings file owned by `transport-service` (`SS_SETTINGS_PATH`, mode `0600`) is exposed as `GET/PUT /api/settings`; the composition root layers it over the launch env (`settings > env > default`) before `plugin.localBinding`, and `transport-dsh` applies the model route (Endpoint + API Key) to `<dshHome>/settings.yaml` plus the child launch env. The web app reaches it through one `service-proxy` hop. Spec: `docs/superpowers/specs/2026-09-16-workbench-settings-dialog-design.md`.

**Tech Stack:** TypeScript, Node `node:test`, Fastify, Next.js (App Router, Tailwind v4 + shadcn/ui, Radix `Tabs`/`Dialog`), Zustand, Playwright (`apps/web` e2e), `yaml@2.9.0`, the `@deepseek-ai/dsh-sdk-client@0.1.5-alpha.1` harness.

## Global Constraints

- Artifacts (commit messages, docs, code identifiers) are written in English; conversation happens in Chinese.
- No `export *`: every package re-exports explicitly.
- `transport` is React-free.
- API keys are write-only: never returned by `GET`, never logged, never in an error message.
- Settings precedence is `settings file > env > built-in default`.
- The component that calls `useTransport` must never re-render (opening the settings dialog must NOT remount `SessionView`).
- The dsh harness is pinned at `0.1.5-alpha.1`; `llm-pi-ai.providers.<route>` is a harness-version fact.
- `apps/web/test/*.mjs` are plain JS and NOT part of the root `npm test`; run them with `npm run test:e2e -w @science-studio/web` (needs a Chromium or they skip, and `npm run build -w @science-studio/transport-client` first).
- The real type gate is `npm run build` (it ends with `npm run typecheck:tests`).
- Do not add comments to code unless a task's code block includes them.
- Commit after each task with the shown message. Never commit secrets.

---

## File Structure

Create:

- `packages/transport/src/settings.ts` — the settings contract types.
- `services/transport-service/src/settings.ts` — settings file store, merge, view, env fold, body validation.
- `services/transport-service/test/settings.test.ts` — store/fold unit tests.
- `services/transport-service/test/settings-routes.test.ts` — HTTP route tests.
- `services/transport-service/test/composition-settings.test.ts` — precedence integration test.
- `packages/transport-client/src/settings.ts` — `fetchSettings` / `updateSettings`.
- `packages/transport-client/test/settings.test.ts` — helper tests.
- `apps/web/lib/desktop-bridge.ts` — the ONE `window.scienceStudioDesktop` declaration.
- `apps/web/app/api/settings/route.ts` — the proxy hop.
- `apps/web/components/studio/settings-dialog.tsx` — the dialog.
- `apps/web/test/settings-dialog.test.mjs` — the e2e guard.
- `packages/transport-dsh/src/route-settings.ts` — the harness-route merge.
- `packages/transport-dsh/test/route-settings.test.ts` — merge + binding tests.

Modify:

- `packages/transport/src/seams.ts`, `packages/transport/src/index.ts` — export the settings types.
- `packages/transport/test/seams.test.ts` — pin the new module.
- `services/transport-service/src/composition.ts` — load + fold settings; add `settingsPath` to `Backend`.
- `services/transport-service/src/server.ts` — the two routes.
- `services/transport-service/src/index.ts` — pass settings through the compat path.
- `packages/transport-client/src/index.ts` — export the helpers/types.
- `apps/web/lib/service-proxy.ts` — allow `PUT`.
- `apps/web/store/studio-store.ts` — `settingsOpen` + actions.
- `apps/web/components/studio/status-bar.tsx` — the gear, the dialog mount, the shared bridge import.
- `packages/transport-dsh/src/binding.ts`, `client.ts`, `adapter.ts`, `index.ts`, `package.json` — route fields + launch env + `yaml`.
- `apps/desktop/src/shared/config.ts`, `paths.ts`, `runtime-status.ts`, `test/config.test.ts`, `test/paths.test.ts`, `test/runtime-status.test.ts`, `src/main/index.ts`, `src/main/windows.ts`, `package.json`, `tsconfig.json`, `tsconfig.renderer.json`, `scripts/copy-renderer.mjs`, `src/preload/workbench.cts`, `test/settings-removed.test.ts`.

Delete (Phase 3):

- `apps/desktop/src/renderer/config.ts`, `apps/desktop/src/renderer/config.html`, `apps/desktop/scripts/copy-renderer.mjs`, `apps/desktop/tsconfig.renderer.json`.

---

# Phase 1 — Settings surface + provider/model apply

## Task 1: The settings contract in the seam package

**Files:**
- Create: `packages/transport/src/settings.ts`
- Modify: `packages/transport/src/seams.ts`, `packages/transport/src/index.ts`
**Interfaces:**
- Consumes: nothing.
- Produces: `ModelSettings`, `ModelSettingsPatch`, `RuntimeSettings`, `RuntimeSettingsView`, `RuntimeSettingsPatch` (type-only, from `./seams` and the package root).

> This task is pure type declarations: there is no runtime behavior to test. Its
> gate is the package build (Step 2). Behavioral tests live in Tasks 2+.

- [ ] **Step 1: Write the minimal implementation**

Create `packages/transport/src/settings.ts`:

```ts
/**
 * The deployment settings contract (docs/superpowers/specs/2026-09-16-workbench-settings-dialog-design.md).
 *
 * These are the provisioned launch facts for the ACTIVE runtime, not record
 * rows: the service persists them and folds them over the launch env before a
 * binding is built. `plugins`/`agent` are reserved sections (v1 renders empty
 * states); their shape is intentionally opaque so a future plugin inventory or
 * agent capability can land without a seam change.
 */
export interface ModelSettings {
  /** The runtime's provider route id (dsh: `llm-pi-ai.providers.<provider>`). */
  provider?: string;
  /** The model id on that route. */
  model?: string;
  /** The route's base URL. */
  endpoint?: string;
  /** The route's credential value. WRITE-ONLY: never present in a response. */
  apiKey?: string;
}

export interface RuntimeSettings {
  model: ModelSettings;
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
}

/** The `GET`/`PUT` response: `apiKey` is replaced by a configured flag. */
export interface RuntimeSettingsView {
  model: Omit<ModelSettings, "apiKey"> & { apiKeyConfigured: boolean };
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
  /** The active runtime product (`TRANSPORT_RUNTIME`). */
  runtime: string;
  /** The settings file the service read/wrote, for diagnosis. */
  settingsPath: string;
}

/** A `PUT` body's model section: absent = keep, `null` = clear, string = replace. */
export interface ModelSettingsPatch {
  provider?: string;
  model?: string;
  endpoint?: string;
  apiKey?: string | null;
}

export interface RuntimeSettingsPatch {
  model?: ModelSettingsPatch;
  plugins?: Record<string, unknown>;
  agent?: Record<string, unknown>;
}
```

Append to `packages/transport/src/seams.ts`:

```ts
export type {
  ModelSettings,
  ModelSettingsPatch,
  RuntimeSettings,
  RuntimeSettingsView,
  RuntimeSettingsPatch,
} from "./settings.js";
```

Add to `packages/transport/src/index.ts` under the contract-surface block:

```ts
export type {
  ModelSettings,
  ModelSettingsPatch,
  RuntimeSettings,
  RuntimeSettingsView,
  RuntimeSettingsPatch,
} from "./settings.js";
```

- [ ] **Step 2: Run the type gate**

Run: `npm run build -w @science-studio/transport`
Expected: PASS (the type proof for the contract).

- [ ] **Step 3: Commit**

```bash
git add packages/transport/src/settings.ts packages/transport/src/seams.ts packages/transport/src/index.ts
git commit -m "feat(transport): add the deployment settings contract"
```

## Task 2: The settings file store

**Files:**
- Create: `services/transport-service/src/settings.ts`
- Test: `services/transport-service/test/settings.test.ts`

**Interfaces:**
- Consumes: the Task 1 types.
- Produces:
  - `resolveSettingsPath(env?: NodeJS.ProcessEnv): string`
  - `emptySettings(): RuntimeSettings`
  - `loadSettings(path: string): Promise<RuntimeSettings>`
  - `saveSettings(path: string, settings: RuntimeSettings): Promise<void>`
  - `mergeSettings(current: RuntimeSettings, patch: RuntimeSettingsPatch): RuntimeSettings`
  - `viewOf(settings: RuntimeSettings, settingsPath: string, env: NodeJS.ProcessEnv): RuntimeSettingsView`
  - `applySettingsToEnv(env: NodeJS.ProcessEnv, settings: RuntimeSettings): NodeJS.ProcessEnv`
  - `parseSettingsPatch(body: unknown): { patch: RuntimeSettingsPatch } | { error: string }`

- [ ] **Step 1: Write the failing test**

Create `services/transport-service/test/settings.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySettingsToEnv,
  emptySettings,
  loadSettings,
  mergeSettings,
  parseSettingsPatch,
  resolveSettingsPath,
  saveSettings,
  viewOf,
} from "../src/settings.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ss-settings-"));
}

test("resolveSettingsPath prefers SS_SETTINGS_PATH, else XDG_DATA_HOME", () => {
  assert.equal(resolveSettingsPath({ SS_SETTINGS_PATH: "/tmp/x.json" }), "/tmp/x.json");
  assert.equal(
    resolveSettingsPath({ XDG_DATA_HOME: "/data" }),
    join("/data", "science-studio", "settings.json"),
  );
});

test("loadSettings returns defaults for an absent or malformed file", async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual(await loadSettings(join(dir, "nope.json")), emptySettings());
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ not json");
    assert.deepEqual(await loadSettings(bad), emptySettings());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSettings writes a 0600 file that loadSettings round-trips", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "nested", "settings.json");
    await saveSettings(path, { model: { provider: "ollama-local", apiKey: "secret" }, plugins: {}, agent: {} });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const loaded = await loadSettings(path);
    assert.equal(loaded.model.provider, "ollama-local");
    assert.equal(loaded.model.apiKey, "secret");
    assert.match(await readFile(path, "utf8"), /secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeSettings applies the absent/null/string apiKey rule", () => {
  const base = { model: { provider: "p", apiKey: "old" }, plugins: {}, agent: {} };
  assert.equal(mergeSettings(base, { model: { model: "m" } }).model.apiKey, "old");
  assert.equal(mergeSettings(base, { model: { apiKey: null } }).model.apiKey, undefined);
  assert.equal(mergeSettings(base, { model: { apiKey: "" } }).model.apiKey, "");
  assert.equal(mergeSettings(base, { model: { apiKey: "new" } }).model.apiKey, "new");
  assert.equal(mergeSettings(base, { model: { provider: "q" } }).model.provider, "q");
});

test("viewOf redacts the key and reports the configured flag", () => {
  const view = viewOf(
    { model: { provider: "p", apiKey: "secret" }, plugins: {}, agent: {} },
    "/tmp/settings.json",
    { TRANSPORT_RUNTIME: "dsh" },
  );
  assert.equal(view.model.apiKeyConfigured, true);
  assert.equal(view.runtime, "dsh");
  assert.equal(view.settingsPath, "/tmp/settings.json");
  assert.deepEqual(view.model, { provider: "p", apiKeyConfigured: true });
});

test("applySettingsToEnv layers settings over env without mutating the input", () => {
  const env = { DSH_PROVIDER: "ambient", DSH_MODEL: "ambient-model", KEEP: "1" };
  const next = applySettingsToEnv(env, {
    model: { provider: "from-file", model: "m1", endpoint: "http://x/v1", apiKey: "k" },
    plugins: {},
    agent: {},
  });
  assert.equal(next.DSH_PROVIDER, "from-file");
  assert.equal(next.DSH_MODEL, "m1");
  assert.equal(next.SS_MODEL_ENDPOINT, "http://x/v1");
  assert.equal(next.SS_MODEL_API_KEY, "k");
  assert.equal(next.KEEP, "1");
  assert.equal(env.DSH_PROVIDER, "ambient", "the input env is not mutated");
  assert.equal(applySettingsToEnv(env, emptySettings()).DSH_PROVIDER, "ambient");
});

test("parseSettingsPatch validates and normalizes", () => {
  assert.equal(parseSettingsPatch("nope").error, "settings body must be a JSON object");
  assert.equal(parseSettingsPatch({ model: 3 }).error, "model must be an object");
  assert.equal(parseSettingsPatch({ model: { provider: 3 } }).error, "model.provider must be a string");
  assert.equal(
    parseSettingsPatch({ model: { endpoint: "ftp://x" } }).error,
    "model.endpoint must be an http(s) URL",
  );
  assert.equal(parseSettingsPatch({ model: { apiKey: 3 } }).error, "model.apiKey must be a string or null");
  assert.equal(parseSettingsPatch({ plugins: [] }).error, "plugins must be an object");
  assert.equal(parseSettingsPatch({ agent: "x" }).error, "agent must be an object");
  assert.deepEqual(parseSettingsPatch({ model: { provider: "" }, plugins: { a: 1 } }), {
    patch: { model: { provider: "" }, plugins: { a: 1 } },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/transport-service`
Expected: FAIL — cannot resolve `../src/settings.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `services/transport-service/src/settings.ts`:

```ts
/**
 * The deployment settings file: where the workbench's Model / Plugins / Agent
 * dialog persists. Deployment configuration, NOT record rows — the record stays
 * authoritative for Project/Session identity (docs/adr/0002, 0007).
 *
 * The key is stored plaintext (a single-user local install has no secret
 * store) but is write-only over HTTP and never logged.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ModelSettings,
  RuntimeSettings,
  RuntimeSettingsPatch,
  RuntimeSettingsView,
} from "@science-studio/transport";

export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SS_SETTINGS_PATH) return env.SS_SETTINGS_PATH;
  const base = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "science-studio", "settings.json");
}

export function emptySettings(): RuntimeSettings {
  return { model: {}, plugins: {}, agent: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadSettings(path: string): Promise<RuntimeSettings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isPlainObject(parsed)) throw new Error("settings must be a JSON object");
    return {
      model: isPlainObject(parsed.model) ? (parsed.model as ModelSettings) : {},
      plugins: isPlainObject(parsed.plugins) ? parsed.plugins : {},
      agent: isPlainObject(parsed.agent) ? parsed.agent : {},
    };
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      console.warn(`[transport-service] settings unreadable at ${path}`, err);
    }
    return emptySettings();
  }
}

export async function saveSettings(path: string, settings: RuntimeSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export function mergeSettings(current: RuntimeSettings, patch: RuntimeSettingsPatch): RuntimeSettings {
  const model: ModelSettings = { ...current.model };
  if (patch.model) {
    if (patch.model.provider !== undefined) model.provider = patch.model.provider;
    if (patch.model.model !== undefined) model.model = patch.model.model;
    if (patch.model.endpoint !== undefined) model.endpoint = patch.model.endpoint;
    if ("apiKey" in patch.model) {
      if (patch.model.apiKey === null) delete model.apiKey;
      else if (patch.model.apiKey !== undefined) model.apiKey = patch.model.apiKey;
    }
  }
  return {
    model,
    plugins: patch.plugins ? { ...current.plugins, ...patch.plugins } : current.plugins,
    agent: patch.agent ? { ...current.agent, ...patch.agent } : current.agent,
  };
}

export function viewOf(
  settings: RuntimeSettings,
  settingsPath: string,
  env: NodeJS.ProcessEnv,
): RuntimeSettingsView {
  const { apiKey, ...model } = settings.model;
  return {
    model: { ...model, apiKeyConfigured: Boolean(apiKey) },
    plugins: settings.plugins,
    agent: settings.agent,
    runtime: env.TRANSPORT_RUNTIME ?? "openclaw",
    settingsPath,
  };
}

export function applySettingsToEnv(
  env: NodeJS.ProcessEnv,
  settings: RuntimeSettings,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const { provider, model, endpoint, apiKey } = settings.model;
  if (provider) next.DSH_PROVIDER = provider;
  if (model) next.DSH_MODEL = model;
  if (endpoint) next.SS_MODEL_ENDPOINT = endpoint;
  if (apiKey) next.SS_MODEL_API_KEY = apiKey;
  return next;
}

export function parseSettingsPatch(
  body: unknown,
): { patch: RuntimeSettingsPatch } | { error: string } {
  if (!isPlainObject(body)) return { error: "settings body must be a JSON object" };
  const patch: RuntimeSettingsPatch = {};
  if ("model" in body) {
    const raw = body.model;
    if (!isPlainObject(raw)) return { error: "model must be an object" };
    const model: NonNullable<RuntimeSettingsPatch["model"]> = {};
    for (const key of ["provider", "model", "endpoint"] as const) {
      if (key in raw) {
        const value = raw[key];
        if (typeof value !== "string") return { error: `model.${key} must be a string` };
        model[key] = value;
      }
    }
    if (model.endpoint !== undefined && model.endpoint !== "" && !/^https?:\/\//.test(model.endpoint)) {
      return { error: "model.endpoint must be an http(s) URL" };
    }
    if ("apiKey" in raw) {
      const value = raw.apiKey;
      if (value !== null && typeof value !== "string") {
        return { error: "model.apiKey must be a string or null" };
      }
      model.apiKey = value;
    }
    patch.model = model;
  }
  if ("plugins" in body) {
    if (!isPlainObject(body.plugins)) return { error: "plugins must be an object" };
    patch.plugins = body.plugins;
  }
  if ("agent" in body) {
    if (!isPlainObject(body.agent)) return { error: "agent must be an object" };
    patch.agent = body.agent;
  }
  return { patch };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @science-studio/transport-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/transport-service/src/settings.ts services/transport-service/test/settings.test.ts
git commit -m "feat(service): add the deployment settings file store"
```

## Task 3: The settings HTTP routes

**Files:**
- Modify: `services/transport-service/src/server.ts`, `services/transport-service/src/composition.ts`
- Test: `services/transport-service/test/settings-routes.test.ts`

**Interfaces:**
- Consumes: Task 2's exports; `Backend` gains `settingsPath?: string`.
- Produces: `GET /api/settings` → `RuntimeSettingsView`; `PUT /api/settings` → `RuntimeSettingsView` or `400 { error }`.

- [ ] **Step 1: Write the failing test**

Create `services/transport-service/test/settings-routes.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInMemoryRecordStore } from "@science-studio/record";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type RuntimeAdapter,
} from "@science-studio/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

function fakeAdapter(): RuntimeAdapter {
  return { runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} };
}

function backend(settingsPath: string): Backend {
  return {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: fakeAdapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records: createInMemoryRecordStore(),
    settingsPath,
  };
}

async function withServer(
  settingsPath: string,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = await createTransportService({ backend: backend(settingsPath) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

const json = { "content-type": "application/json" };

test("PUT /api/settings merges and GET redacts the key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-settings-routes-"));
  try {
    await withServer(join(dir, "settings.json"), async (base) => {
      const put = await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({
          model: { provider: "ollama-local", model: "qwen3.8:latest", endpoint: "http://h/v1", apiKey: "k" },
        }),
      });
      assert.equal(put.status, 200);
      const view = (await put.json()) as { model: Record<string, unknown> };
      assert.equal(view.model.provider, "ollama-local");
      assert.equal(view.model.apiKeyConfigured, true);
      assert.ok(!("apiKey" in view.model));

      const get = await fetch(`${base}/api/settings`);
      const fetched = (await get.json()) as { model: Record<string, unknown> };
      assert.equal(fetched.model.endpoint, "http://h/v1");
      assert.ok(!("apiKey" in fetched.model));

      await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ model: { provider: "other" } }),
      });
      const kept = (await (await fetch(`${base}/api/settings`)).json()) as { model: { apiKeyConfigured: boolean } };
      assert.equal(kept.model.apiKeyConfigured, true, "an omitted key is kept");

      await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ model: { apiKey: null } }),
      });
      const cleared = (await (await fetch(`${base}/api/settings`)).json()) as { model: { apiKeyConfigured: boolean } };
      assert.equal(cleared.model.apiKeyConfigured, false, "null clears the key");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PUT /api/settings rejects a bad body with 400", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-settings-routes-bad-"));
  try {
    await withServer(join(dir, "settings.json"), async (base) => {
      const res = await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ model: { endpoint: "ftp://nope" } }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "model.endpoint must be an http(s) URL" });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/transport-service`
Expected: FAIL — `GET /api/settings` returns 404.

- [ ] **Step 3: Add `settingsPath` to `Backend`**

In `services/transport-service/src/composition.ts`, inside `interface Backend` (after `capabilities`), add:

```ts
  /** The deployment settings file the `/api/settings` routes read and write. */
  settingsPath?: string;
```

- [ ] **Step 4: Add the routes**

In `services/transport-service/src/server.ts`, add the import:

```ts
import {
  loadSettings,
  mergeSettings,
  parseSettingsPatch,
  resolveSettingsPath,
  saveSettings,
  viewOf,
} from "./settings.js";
```

After `const defaultProjectId = ...` add:

```ts
  const settingsPath = backend.settingsPath ?? resolveSettingsPath(process.env);
```

Before the `// -- Project / Session / Run record surface` comment, add:

```ts
  // -- Deployment settings ---------------------------------------------------
  app.get("/api/settings", async () =>
    viewOf(await loadSettings(settingsPath), settingsPath, process.env),
  );

  app.put("/api/settings", async (request, reply) => {
    const parsed = parseSettingsPatch(request.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const next = mergeSettings(await loadSettings(settingsPath), parsed.patch);
    await saveSettings(settingsPath, next);
    return viewOf(next, settingsPath, process.env);
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w @science-studio/transport-service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/transport-service/src/server.ts services/transport-service/src/composition.ts services/transport-service/test/settings-routes.test.ts
git commit -m "feat(service): expose GET/PUT /api/settings"
```

## Task 4: Fold settings into the runtime env

**Files:**
- Modify: `services/transport-service/src/composition.ts`, `services/transport-service/src/index.ts`
- Test: `services/transport-service/test/composition-settings.test.ts`

**Interfaces:**
- Consumes: `loadSettings`, `applySettingsToEnv`, `resolveSettingsPath`; `Backend.settingsPath`.
- Produces: `createBackend(env, plugins)` builds the binding from an env where the settings file wins.

- [ ] **Step 1: Write the failing test**

Create `services/transport-service/test/composition-settings.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAdapter, RuntimePlugin } from "@science-studio/transport";
import { createBackend } from "../src/index.js";

function fakeAdapter(): RuntimeAdapter {
  return { runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} };
}

test("the settings file wins over the ambient launch env in the binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-composition-settings-"));
  const settingsPath = join(dir, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({
      model: { provider: "from-file", model: "file-model", endpoint: "http://file/v1", apiKey: "file-key" },
      plugins: {},
      agent: {},
    }),
  );
  let seen: NodeJS.ProcessEnv | null = null;
  const plugin: RuntimePlugin = {
    runtime: "fake",
    factory: {
      runtime: "fake",
      capabilities: {
        commandCatalog: false,
        remoteSettleWatch: false,
        tokenStreaming: false,
        approvals: false,
        hostedSandbox: false,
        perSessionCwd: false,
      },
      create: (): RuntimeAdapter => fakeAdapter(),
    },
    localBinding: (env) => {
      seen = { ...env };
      return { runtime: "fake", config: {} };
    },
  };
  try {
    const backend = await createBackend(
      {
        TRANSPORT_RUNTIME: "fake",
        RECORD_STORE: "memory",
        SS_SETTINGS_PATH: settingsPath,
        DSH_PROVIDER: "ambient",
        DSH_MODEL: "ambient-model",
      },
      [plugin],
    );
    assert.ok(seen, "localBinding was called");
    assert.equal(seen!.DSH_PROVIDER, "from-file");
    assert.equal(seen!.DSH_MODEL, "file-model");
    assert.equal(seen!.SS_MODEL_ENDPOINT, "http://file/v1");
    assert.equal(seen!.SS_MODEL_API_KEY, "file-key");
    assert.equal(backend.settingsPath, settingsPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/transport-service`
Expected: FAIL — `backend.settingsPath` is undefined and the binding saw the ambient env.

- [ ] **Step 3: Write the minimal implementation**

In `services/transport-service/src/composition.ts`, add:

```ts
import { applySettingsToEnv, loadSettings, resolveSettingsPath } from "./settings.js";
```

In `localBackend`, replace `const binding = plugin.localBinding(env);` with:

```ts
  const settingsPath = env.SS_SETTINGS_PATH ?? resolveSettingsPath(env);
  const settings = await loadSettings(settingsPath);
  const runtimeEnv = applySettingsToEnv(env, settings);
  const binding = plugin.localBinding(runtimeEnv);
```

Change `env: { ...env }` in the `adapter.init(...)` call to `env: { ...runtimeEnv }`.

Add `settingsPath,` to the returned object (next to `capabilities`).

In `services/transport-service/src/index.ts`, add:

```ts
import { applySettingsToEnv, loadSettings, resolveSettingsPath } from "./settings.js";
```

In `backendFromAdapters`, after the `const workspace = localWorkspace(...)` line, add:

```ts
  const settingsPath = env.SS_SETTINGS_PATH ?? resolveSettingsPath(env);
  const runtimeEnv = applySettingsToEnv(env, await loadSettings(settingsPath));
```

Change `plugin.localBinding(env)` → `plugin.localBinding(runtimeEnv)`, and
`adapter.init({ ..., env: { ...env } })` → `env: { ...runtimeEnv }`. Add
`settingsPath,` to the compat `Backend` return.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @science-studio/transport-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/transport-service/src/composition.ts services/transport-service/src/index.ts services/transport-service/test/composition-settings.test.ts
git commit -m "feat(service): layer saved settings over the launch env"
```

## Task 5: transport-client settings helpers

**Files:**
- Create: `packages/transport-client/src/settings.ts`
- Modify: `packages/transport-client/src/index.ts`
- Test: `packages/transport-client/test/settings.test.ts`

**Interfaces:**
- Produces: `DEFAULT_SETTINGS_API`, `SettingsRequestError`, `fetchSettings(api?)`, `updateSettings(api, patch)`.

- [ ] **Step 1: Write the failing test**

Create `packages/transport-client/test/settings.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSettings, updateSettings } from "../src/settings.js";

interface Call {
  url: string;
  method: string;
  body?: string;
}

async function withFetch(
  status: number,
  body: unknown,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const VIEW = {
  model: { provider: "ollama-local", apiKeyConfigured: true },
  plugins: {},
  agent: {},
  runtime: "dsh",
  settingsPath: "/tmp/settings.json",
};

test("fetchSettings GETs the view", async () => {
  await withFetch(200, VIEW, async (calls) => {
    const view = await fetchSettings("/api/settings");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.url, "/api/settings");
    assert.equal(view.model.provider, "ollama-local");
    assert.equal(view.model.apiKeyConfigured, true);
  });
});

test("updateSettings PUTs the patch as JSON", async () => {
  await withFetch(200, VIEW, async (calls) => {
    await updateSettings("/api/settings", { model: { provider: "p", apiKey: null } });
    assert.equal(calls[0]!.method, "PUT");
    assert.equal(calls[0]!.body, JSON.stringify({ model: { provider: "p", apiKey: null } }));
  });
});

test("a failed request throws with the upstream error text", async () => {
  await withFetch(400, { error: "model.endpoint must be an http(s) URL" }, async () => {
    await assert.rejects(
      () => updateSettings("/api/settings", { model: { endpoint: "ftp://x" } }),
      /model\.endpoint must be an http\(s\) URL/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w @science-studio/transport && npm run test -w @science-studio/transport-client`
Expected: FAIL — cannot resolve `../src/settings.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/transport-client/src/settings.ts`:

```ts
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
```

Append to `packages/transport-client/src/index.ts`:

```ts
export {
  DEFAULT_SETTINGS_API,
  SettingsRequestError,
  fetchSettings,
  updateSettings,
} from "./settings.js";
export type {
  ModelSettings,
  ModelSettingsPatch,
  RuntimeSettings,
  RuntimeSettingsView,
  RuntimeSettingsPatch,
} from "@science-studio/transport";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build -w @science-studio/transport-client && npm run test -w @science-studio/transport-client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-client/src/settings.ts packages/transport-client/src/index.ts packages/transport-client/test/settings.test.ts
git commit -m "feat(transport-client): add settings fetch/update helpers"
```

## Task 6: The web proxy hop

**Files:**
- Modify: `apps/web/lib/service-proxy.ts`
- Create: `apps/web/app/api/settings/route.ts`

**Interfaces:**
- Produces: same-origin `GET/PUT /api/settings` on port 3000.

- [ ] **Step 1: Widen the hop method**

In `apps/web/lib/service-proxy.ts`, change:

```ts
  method?: "GET" | "POST";
```

to:

```ts
  method?: "GET" | "POST" | "PUT";
```

- [ ] **Step 2: Add the route**

Create `apps/web/app/api/settings/route.ts`:

```ts
/**
 * Proxy for the deployment settings routes (`/api/settings`).
 *
 * Same-origin for the browser, caller's `Authorization` forwarded upstream. A
 * plain JSON in / JSON out hop with no stream to preserve; it relays through the
 * one proxy policy.
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return proxyToService(request, { path: "/api/settings", method: "GET" });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const body = await request.text();
  return proxyToService(request, {
    path: "/api/settings",
    method: "PUT",
    headers: { accept: "application/json", "content-type": "application/json" },
    body,
  });
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck -w @science-studio/web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/service-proxy.ts apps/web/app/api/settings/route.ts
git commit -m "feat(web): proxy /api/settings through the shared service hop"
```

## Task 7: Dialog open state in the store

**Files:**
- Modify: `apps/web/store/studio-store.ts`

**Interfaces:**
- Produces: `settingsOpen: boolean`, `openSettings(): void`, `closeSettings(): void`.

- [ ] **Step 1: Add the state**

Add to the `State` type (near `rightPanel`):

```ts
  /** The deployment settings dialog. Chrome state: never keyed into SessionView. */
  settingsOpen: boolean;
```

Add to the actions block:

```ts
  openSettings: () => void;
  closeSettings: () => void;
```

Add near `rightPanel: true`:

```ts
  settingsOpen: false,
```

Add near `toggleRight`:

```ts
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck -w @science-studio/web`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/store/studio-store.ts
git commit -m "feat(web): add settings dialog chrome state"
```

## Task 8: The shared desktop bridge, the dialog, and the gear

**Files:**
- Create: `apps/web/lib/desktop-bridge.ts`, `apps/web/components/studio/settings-dialog.tsx`
- Modify: `apps/web/components/studio/status-bar.tsx`

**Interfaces:**
- Consumes: `fetchSettings`, `updateSettings`, `DEFAULT_SETTINGS_API`; `settingsOpen`/`closeSettings`; the `Dialog`, `Tabs`, `Input`, `Button` primitives.
- Produces: `desktopBridge()`, `DesktopBridge`; `SettingsDialog()`; a gear button named `Settings`.

- [ ] **Step 1: Create the shared bridge module**

Create `apps/web/lib/desktop-bridge.ts`:

```ts
"use client";

/**
 * The ONE `window.scienceStudioDesktop` declaration. Two components (the status
 * bar's runtime chip and the settings dialog) read it, and two global
 * augmentations of the same `Window` property with different shapes is a TS
 * error — so the shape and the cast live here.
 */
export interface DesktopBridge {
  runtimeStatus?: () => Promise<{ dshPath: string | null; ready: boolean }>;
  restartHost?: () => Promise<{ webPort: number; apiPort: number } | null>;
}

declare global {
  interface Window {
    scienceStudioDesktop?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.scienceStudioDesktop;
}
```

- [ ] **Step 2: Write the dialog**

Create `apps/web/components/studio/settings-dialog.tsx`:

```tsx
"use client";

import * as React from "react";
import { Loader2, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEFAULT_SETTINGS_API,
  fetchSettings,
  updateSettings,
  type RuntimeSettingsPatch,
  type RuntimeSettingsView,
} from "@science-studio/transport-client";
import { useStudioStore } from "@/store/studio-store";
import { desktopBridge } from "@/lib/desktop-bridge";

const SETTINGS_API = process.env.NEXT_PUBLIC_SETTINGS_URL ?? DEFAULT_SETTINGS_API;

type Status = "idle" | "loading" | "saving" | "saved" | "error";

export function SettingsDialog() {
  const open = useStudioStore((s) => s.settingsOpen);
  const closeSettings = useStudioStore((s) => s.closeSettings);
  const [view, setView] = React.useState<RuntimeSettingsView | null>(null);
  const [provider, setProvider] = React.useState("");
  const [model, setModel] = React.useState("");
  const [endpoint, setEndpoint] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [clearKey, setClearKey] = React.useState(false);
  const [status, setStatus] = React.useState<Status>("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    setStatus("loading");
    setError(null);
    fetchSettings(SETTINGS_API)
      .then((next) => {
        if (!active) return;
        setView(next);
        setProvider(next.model.provider ?? "");
        setModel(next.model.model ?? "");
        setEndpoint(next.model.endpoint ?? "");
        setApiKey("");
        setClearKey(false);
        setStatus("idle");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [open]);

  const save = async (): Promise<void> => {
    setStatus("saving");
    setError(null);
    const patch: RuntimeSettingsPatch = {
      model: {
        provider: provider.trim(),
        model: model.trim(),
        endpoint: endpoint.trim(),
        ...(clearKey ? { apiKey: null } : apiKey !== "" ? { apiKey } : {}),
      },
    };
    try {
      const next = await updateSettings(SETTINGS_API, patch);
      setView(next);
      setApiKey("");
      setClearKey(false);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  const canRestart = Boolean(desktopBridge()?.restartHost);
  const keyState = clearKey
    ? "will clear on save"
    : view?.model.apiKeyConfigured
      ? "configured"
      : "not configured";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeSettings())}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="size-4" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Deployment configuration. Saving persists it; a service restart applies it.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="model" orientation="vertical" className="min-h-[20rem]">
          <TabsList className="h-fit w-40 shrink-0">
            <TabsTrigger value="model">Model</TabsTrigger>
            <TabsTrigger value="plugins">Plugins</TabsTrigger>
            <TabsTrigger value="agent">Agent</TabsTrigger>
          </TabsList>
          <TabsContent value="model" className="space-y-6">
            {status === "loading" ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </p>
            ) : (
              <>
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Model</h3>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Provider</span>
                    <Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="e.g. ollama-local" />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Model</span>
                    <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. qwen3.8:latest" />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Endpoint</span>
                    <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://host/v1" />
                  </label>
                </section>
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Model API</h3>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">API key · {keyState}</span>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setClearKey(false);
                      }}
                      placeholder={view?.model.apiKeyConfigured ? "•••• (leave blank to keep)" : "not set"}
                    />
                  </label>
                  {view?.model.apiKeyConfigured ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setApiKey("");
                        setClearKey(true);
                      }}
                    >
                      Clear key
                    </Button>
                  ) : null}
                </section>
                <div className="flex items-center gap-3">
                  <Button type="button" onClick={() => void save()} disabled={status === "saving"}>
                    {status === "saving" ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save
                  </Button>
                  {canRestart ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void desktopBridge()?.restartHost?.()}
                    >
                      Restart service
                    </Button>
                  ) : null}
                  {status === "saved" ? (
                    <span className="text-xs text-muted-foreground">Saved — restart the service to apply.</span>
                  ) : null}
                  {error ? <span className="text-xs text-destructive">{error}</span> : null}
                </div>
              </>
            )}
          </TabsContent>
          <TabsContent value="plugins">
            <EmptySection title="Plugins" body="Plugin configuration is coming soon." />
          </TabsContent>
          <TabsContent value="agent">
            <EmptySection title="Agent" body="Agent configuration is coming soon." />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function EmptySection({ title, body }: { title: string; body: string }) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted-foreground">{body}</p>
    </section>
  );
}
```

- [ ] **Step 3: Wire the gear and use the shared bridge in status-bar**

In `apps/web/components/studio/status-bar.tsx`:

1. Add imports:

```ts
import { Settings } from "lucide-react";
import { SettingsDialog } from "./settings-dialog";
import { desktopBridge } from "@/lib/desktop-bridge";
```

(merge `Settings` into the existing `lucide-react` import).

2. Delete the local `interface DesktopBridge { runtimeStatus?... }` and the
   `declare global { interface Window { scienceStudioDesktop?: DesktopBridge } }`
   block.

3. In `RuntimeChip`'s effect, change `const bridge = window.scienceStudioDesktop;`
   to `const bridge = desktopBridge();`.

4. In the footer's left section:

```tsx
      <div className="flex flex-1 items-center justify-start">
        <SettingsButton />
        <WorkspaceChip />
        <RuntimeChip />
      </div>
```

5. Mount `<SettingsDialog />` as the last child of the footer, before
   `</footer>`.

6. Add at the bottom of the file:

```tsx
function SettingsButton() {
  const openSettings = useStudioStore((s) => s.openSettings);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-5 gap-1.5 px-1.5"
      aria-label="Settings"
      onClick={() => openSettings()}
    >
      <Settings className="size-3.5" />
    </Button>
  );
}
```

- [ ] **Step 4: Verify**

Run: `npm run build -w @science-studio/transport-client && npm run typecheck -w @science-studio/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/desktop-bridge.ts apps/web/components/studio/settings-dialog.tsx apps/web/components/studio/status-bar.tsx
git commit -m "feat(web): add the settings dialog and status-bar gear"
```

## Task 9: The settings-dialog e2e guard

**Files:**
- Create: `apps/web/test/settings-dialog.test.mjs`

**Interfaces:**
- Consumes: `harness.mjs`.
- Produces: a regression that the gear opens the dialog, tabs switch, Save PUTs the patch, and the transcript survives.

- [ ] **Step 1: Write the test**

Create `apps/web/test/settings-dialog.test.mjs`:

```js
/**
 * The settings dialog: the status-bar gear opens it, the left tab list switches
 * panels, and Save persists through `/api/settings`. Opening the dialog must not
 * remount the runtime owner (it lives in the StatusBar, not in `SessionView`),
 * which the transcript marker check covers.
 *
 * Prereq: `npm run build -w @science-studio/transport-client`. Needs a Chromium
 * (SKIPs without one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MARKER,
  findChromium,
  freePort,
  killTree,
  newWorkbenchPage,
  mockRecordSurface,
  mockWorkbenchSurfaces,
  startWebServer,
  waitForServer,
  warmWorkbench,
} from "./harness.mjs";

const VIEW = {
  model: { provider: "ollama-local", model: "qwen3.8:latest", endpoint: "http://h/v1", apiKeyConfigured: true },
  plugins: {},
  agent: {},
  runtime: "dsh",
  settingsPath: "/tmp/settings.json",
};

test(
  "the gear opens the settings dialog and Save persists",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip("no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one");
      return;
    }

    const port = await freePort();
    const server = startWebServer(port);
    let browser;
    try {
      await waitForServer(`http://localhost:${port}`, 120_000);
      await warmWorkbench(`http://localhost:${port}`);

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath });
      const page = await newWorkbenchPage(browser);

      await mockWorkbenchSurfaces(page);
      await mockRecordSurface(page);
      const puts = [];
      await page.route("**/api/settings", async (route) => {
        const request = route.request();
        if (request.method() === "PUT") puts.push(request.postDataJSON());
        return route.fulfill({ json: VIEW });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("dialog").waitFor({ timeout: 10_000 });
      await page.getByRole("tab", { name: "Plugins" }).click();
      await page.getByText("Plugin configuration is coming soon.").waitFor({ timeout: 5_000 });
      await page.getByRole("tab", { name: "Model" }).click();

      await page.getByLabel("Provider").fill("from-ui");
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByText(/Saved — restart the service/).waitFor({ timeout: 10_000 });

      assert.equal(puts.length, 1);
      assert.equal(puts[0].model.provider, "from-ui");
      assert.ok(!("apiKey" in puts[0].model), "an untouched key is not sent");

      await page.getByRole("button", { name: "Close" }).click();
      assert.equal(await page.getByText(HISTORY_MARKER).count(), 1, "the transcript survived the dialog");
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);
```

- [ ] **Step 2: Run the test**

Run: `npm run build -w @science-studio/transport-client`
Run: `npm run test:e2e -w @science-studio/web`
Expected: PASS, or SKIP when no Chromium is present.

- [ ] **Step 3: Commit**

```bash
git add apps/web/test/settings-dialog.test.mjs
git commit -m "test(web): guard the settings dialog flow"
```

---

# Phase 2 — Apply the dsh model route (Endpoint + API Key)

## Task 10: Carry endpoint/apiKey into the dsh binding

**Files:**
- Modify: `packages/transport-dsh/src/binding.ts`
- Test: `packages/transport-dsh/test/route-settings.test.ts`

**Interfaces:**
- Consumes: the service-owned env names `SS_MODEL_ENDPOINT` / `SS_MODEL_API_KEY` (Task 2).
- Produces: `DshBinding.endpoint?`, `DshBinding.apiKey?`; `dshLocalBinding` maps them.

- [ ] **Step 1: Write the failing test**

Create `packages/transport-dsh/test/route-settings.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dshLocalBinding, parseDshBinding } from "../src/binding.js";

test("dshLocalBinding maps the service-owned endpoint/apiKey env names", () => {
  const binding = dshLocalBinding({
    DSH_PROVIDER: "ollama-local",
    DSH_MODEL: "qwen3.8:latest",
    SS_MODEL_ENDPOINT: "http://10.0.0.1:11434/v1",
    SS_MODEL_API_KEY: "secret",
  });
  const parsed = parseDshBinding(binding);
  assert.equal(parsed.provider, "ollama-local");
  assert.equal(parsed.model, "qwen3.8:latest");
  assert.equal(parsed.endpoint, "http://10.0.0.1:11434/v1");
  assert.equal(parsed.apiKey, "secret");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/transport-dsh`
Expected: FAIL — `parsed.endpoint` is undefined.

- [ ] **Step 3: Write the minimal implementation**

In `packages/transport-dsh/src/binding.ts`, add to `DshBinding` (after `model`):

```ts
  /** The provider route's base URL (service settings; harness-route override). */
  endpoint?: string;
  /** The route's credential VALUE. Held only for this launch, never persisted. */
  apiKey?: string;
```

In `parseDshBinding`'s returned object (after `model`):

```ts
    endpoint: bindingOptionalString(binding, "endpoint"),
    apiKey: bindingOptionalString(binding, "apiKey"),
```

In `dshLocalBinding` (after the `model` copy):

```ts
  copy("endpoint", "SS_MODEL_ENDPOINT");
  copy("apiKey", "SS_MODEL_API_KEY");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @science-studio/transport-dsh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-dsh/src/binding.ts packages/transport-dsh/test/route-settings.test.ts
git commit -m "feat(dsh): carry endpoint/apiKey into the adapter binding"
```

## Task 11: The harness-route settings merge

**Files:**
- Create: `packages/transport-dsh/src/route-settings.ts`
- Modify: `packages/transport-dsh/src/index.ts`, `packages/transport-dsh/package.json`
- Test: `packages/transport-dsh/test/route-settings.test.ts`

**Interfaces:**
- Produces: `applyRouteSettings(input: { home: string; provider: string; model?: string; endpoint?: string; apiKey?: string }): Promise<{ env: Record<string, string> } | null>`; `RouteSettingsInput`.

- [ ] **Step 1: Add the YAML dependency**

In `packages/transport-dsh/package.json`, add to `dependencies`:

```json
    "yaml": "^2.9.0",
```

Run: `npm install`
Expected: `package-lock.json` updated with `yaml@2.9.0` linked into the workspace.

- [ ] **Step 2: Write the failing test**

Append to `packages/transport-dsh/test/route-settings.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { applyRouteSettings } from "../src/route-settings.js";

const ROUTE_FIXTURE = `# my harness settings
llm-pi-ai:
  providers:
    ollama-local:
      api: openai-completions
      # the LAN endpoint
      baseURL: http://old:11434/v1
      models:
        - id: qwen3.8:latest
      apiKeyEnv: OLLAMA_LOCAL_API_KEY
other:
  keep: me
`;

test("applyRouteSettings updates baseURL and preserves the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-route-settings-"));
  try {
    const file = join(dir, "settings.yaml");
    await writeFile(file, ROUTE_FIXTURE);
    const result = await applyRouteSettings({
      home: dir,
      provider: "ollama-local",
      model: "qwen3.8:latest",
      endpoint: "http://new:11434/v1",
      apiKey: "secret",
    });
    assert.deepEqual(result, { env: { OLLAMA_LOCAL_API_KEY: "secret" } });
    const text = await readFile(file, "utf8");
    assert.match(text, /baseURL: http:\/\/new:11434\/v1/);
    assert.match(text, /# my harness settings/, "unrelated content survives");
    assert.match(text, /# the LAN endpoint/, "the route's comment survives");
    assert.match(text, /other:\n  keep: me/);
    assert.doesNotMatch(text, /^\s*(items|range):/m, "no leaked yaml node internals");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyRouteSettings creates a route when the file is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-route-settings-new-"));
  try {
    const result = await applyRouteSettings({
      home: dir,
      provider: "acme",
      model: "m1",
      endpoint: "http://acme/v1",
      apiKey: "k",
    });
    assert.deepEqual(result, { env: { ACME_API_KEY: "k" } });
    const doc = parseYaml(await readFile(join(dir, "settings.yaml"), "utf8")) as {
      "llm-pi-ai": { providers: Record<string, { baseURL: string; apiKeyEnv: string }> };
    };
    assert.equal(doc["llm-pi-ai"].providers.acme.baseURL, "http://acme/v1");
    assert.equal(doc["llm-pi-ai"].providers.acme.apiKeyEnv, "ACME_API_KEY");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyRouteSettings is a no-op without an endpoint or key", async () => {
  assert.equal(await applyRouteSettings({ home: "/nope", provider: "p" }), null);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @science-studio/transport-dsh`
Expected: FAIL — cannot resolve `../src/route-settings.js`.

- [ ] **Step 4: Write the minimal implementation**

Create `packages/transport-dsh/src/route-settings.ts`:

```ts
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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

  if (input.endpoint) doc.setIn([...routePath, "baseURL"], input.endpoint);
  if (doc.getIn([...routePath, "api"]) === undefined) {
    doc.setIn([...routePath, "api"], "openai-completions");
  }
  if (doc.getIn([...routePath, "models"]) === undefined && input.model) {
    doc.setIn([...routePath, "models"], [{ id: input.model }]);
  }
  const existingKeyEnv = doc.getIn([...routePath, "apiKeyEnv"]);
  const credentialName =
    typeof existingKeyEnv === "string" && existingKeyEnv !== ""
      ? existingKeyEnv
      : credentialEnvName(input.provider);
  if (credentialName !== existingKeyEnv) doc.setIn([...routePath, "apiKeyEnv"], credentialName);

  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, doc.toString(), "utf8");
  await rename(tmp, file);

  return input.apiKey ? { env: { [credentialName]: input.apiKey } } : { env: {} };
}
```

Add to `packages/transport-dsh/src/index.ts`:

```ts
export { applyRouteSettings } from "./route-settings.js";
export type { RouteSettingsInput } from "./route-settings.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w @science-studio/transport-dsh`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/transport-dsh/src/route-settings.ts packages/transport-dsh/src/index.ts packages/transport-dsh/package.json package-lock.json packages/transport-dsh/test/route-settings.test.ts
git commit -m "feat(dsh): apply the model route to the harness settings"
```

## Task 12: Launch env option + apply the route during init

**Files:**
- Modify: `packages/transport-dsh/src/client.ts`, `packages/transport-dsh/src/adapter.ts`
- Test: `packages/transport-dsh/test/adapter.test.ts`

**Interfaces:**
- Consumes: `applyRouteSettings` (Task 11); `DshBinding.endpoint/apiKey` (Task 10); `createClient` (existing test seam).
- Produces: `DshClientLaunchOptions.env?: NodeJS.ProcessEnv`; `init` merges the credential env into the client launch, best-effort.

- [ ] **Step 1: Write the failing test**

Add to `packages/transport-dsh/test/adapter.test.ts` (the file already imports
`mkdtemp`, `rm`, `tmpdir`, `join`, `DshRuntimeAdapter`, `DshTurnClient`):

```ts
test("a saved route credential reaches the launch client env", async () => {
  const home = await mkdtemp(join(tmpdir(), "ss-route-env-"));
  try {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const adapter = new DshRuntimeAdapter({
      createClient: (options): DshTurnClient => {
        seenEnv = options.env;
        return { start: async () => {}, close: async () => {}, runTurn: async () => {} };
      },
      transcriptDir: join(tmpdir(), "science-studio-route-env-test"),
    });
    await adapter.init({
      binding: {
        runtime: "dsh",
        config: {
          home,
          provider: "ollama-local",
          model: "qwen3.8:latest",
          endpoint: "http://h/v1",
          apiKey: "secret-key",
        },
      },
      recordStore: { addRun: async () => {} },
    });
    assert.equal(seenEnv?.OLLAMA_LOCAL_API_KEY, "secret-key");
    assert.equal(seenEnv?.PATH, process.env.PATH, "the child env keeps the parent environment");
    const settings = (await import("node:fs/promises")).readFile(join(home, "settings.yaml"), "utf8");
    assert.match(await settings, /baseURL: http:\/\/h\/v1/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failing route write does not fail init", async () => {
  const adapter = new DshRuntimeAdapter({
    createClient: (): DshTurnClient => ({ start: async () => {}, close: async () => {}, runTurn: async () => {} }),
    transcriptDir: join(tmpdir(), "science-studio-route-fail-test"),
  });
  await adapter.init({
    binding: {
      runtime: "dsh",
      config: { home: "/proc/definitely-not-writable", provider: "p", endpoint: "http://x/v1", apiKey: "k" },
    },
    recordStore: { addRun: async () => {} },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/transport-dsh`
Expected: FAIL — `seenEnv?.OLLAMA_LOCAL_API_KEY` is undefined.

- [ ] **Step 3: Add the launch env option**

In `packages/transport-dsh/src/client.ts`, add to `DshClientLaunchOptions` (after `maxTokens`):

```ts
  /** Extra environment for the harness child (a route credential, typically). */
  env?: NodeJS.ProcessEnv;
```

In the `SdkDshTurnClient` constructor's option object, after `maxTokens: options.maxTokens,`, add:

```ts
      env: options.env,
```

- [ ] **Step 4: Apply the route in the adapter**

In `packages/transport-dsh/src/adapter.ts`:

1. Add the import:

```ts
import { applyRouteSettings } from "./route-settings.js";
```

2. Merge `homedir` into the existing `node:os` import:

```ts
import { homedir, tmpdir } from "node:os";
```

3. In `initialize`, immediately before `this.client = this.createClient({ ... })`, add:

```ts
    let routeEnv: NodeJS.ProcessEnv | undefined;
    if (binding.endpoint || binding.apiKey) {
      try {
        const route = await applyRouteSettings({
          home: dshHome ?? join(homedir(), ".dsh"),
          provider,
          ...(model === undefined ? {} : { model }),
          ...(binding.endpoint === undefined ? {} : { endpoint: binding.endpoint }),
          ...(binding.apiKey === undefined ? {} : { apiKey: binding.apiKey }),
        });
        if (route) routeEnv = { ...route.env };
      } catch (err) {
        console.warn("[dsh] route settings unavailable", err);
      }
    }
```

4. Inside the `createClient({ ... })` argument, after `maxTokens,`, add:

```ts
      ...(routeEnv === undefined ? {} : { env: { ...process.env, ...routeEnv } }),
```

> The SDK's `resolveDshLaunch` reads `options.env ?? process.env` and spawns with
> exactly that object — so passing `env` REPLACES the child's environment rather
> than overlaying it. Merge over `process.env` (as above) or the harness child
> would lose `PATH`/`HOME`/proxies whenever a route is configured.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build -w @science-studio/transport-dsh && npm run test -w @science-studio/transport-dsh`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/transport-dsh/src/client.ts packages/transport-dsh/src/adapter.ts packages/transport-dsh/test/adapter.test.ts
git commit -m "feat(dsh): apply saved route settings during init"
```

---

# Phase 3 — Desktop unification

## Task 13: Narrow `config.env`, add the settings path, simplify the runtime status

**Files:**
- Modify: `apps/desktop/src/shared/config.ts`, `apps/desktop/src/shared/paths.ts`, `apps/desktop/src/shared/runtime-status.ts`, `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/test/config.test.ts`, `apps/desktop/test/paths.test.ts`, `apps/desktop/test/runtime-status.test.ts`

**Interfaces:**
- Produces: `DesktopConfig` without provider/model; `DesktopPaths.settingsPath`; `RuntimeStatus = { dshPath: string | null; ready: boolean }`; `buildChildEnv` sets `SS_SETTINGS_PATH`.

- [ ] **Step 1: Update the failing test**

Replace `apps/desktop/test/config.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv, parseConfigEnv, serializeConfigEnv } from "../src/shared/config.js";
import { resolveDesktopPaths } from "../src/shared/paths.js";

test("parseConfigEnv reads KEY=VALUE, ignoring blanks and comments", () => {
  const config = parseConfigEnv("# route\nOLLAMA_LOCAL_API_KEY=secret\n\nEXTRA=1\n");
  assert.deepEqual(config, { vars: { OLLAMA_LOCAL_API_KEY: "secret", EXTRA: "1" } });
});

test("serializeConfigEnv round-trips through parseConfigEnv", () => {
  const config = { vars: { DEEPSEEK_API_KEY: "k", A: "b" } };
  assert.deepEqual(parseConfigEnv(serializeConfigEnv(config)), config);
});

test("an empty config round-trips through parseConfigEnv", () => {
  assert.deepEqual(parseConfigEnv(serializeConfigEnv({})), {});
});

test("buildChildEnv pins dsh and the app's directories", () => {
  const paths = resolveDesktopPaths({ userDataDir: "/ud", homeDir: "/home/me" });
  const env = buildChildEnv({
    base: { PATH: "/bin", SS_ENTERPRISE_MODULE: "x" },
    config: { vars: { OLLAMA_LOCAL_API_KEY: "k" } },
    paths,
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.TRANSPORT_RUNTIME, "dsh");
  assert.equal(env.DSH_PROVIDER, undefined);
  assert.equal(env.DSH_MODEL, undefined);
  assert.equal(env.OLLAMA_LOCAL_API_KEY, "k");
  assert.equal(env.SS_SETTINGS_PATH, "/ud/settings.json");
  assert.equal(env.DSH_DEFAULT_SESSION, "science-studio");
  assert.equal(env.DSH_HOME, "/ud/dsh");
  assert.equal(env.DSH_TRANSCRIPT_DIR, "/ud/transcripts");
  assert.equal(env.PROJECT_ROOT, "/home/me/Documents/Science Studio/projects");
  assert.equal(env.RECORD_STORE_PATH, "/ud/record.jsonl");
  assert.equal(env.SS_ENTERPRISE_MODULE, undefined);
});
```

Add to `apps/desktop/test/paths.test.ts`, inside the first test:

```ts
  assert.equal(p.settingsPath, "/ud/settings.json");
```

Replace `apps/desktop/test/runtime-status.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeStatus } from "../src/shared/runtime-status.js";

test("reports ready when dsh is present", () => {
  assert.deepEqual(runtimeStatus({ dshPath: "/opt/bin/dsh" }), {
    dshPath: "/opt/bin/dsh",
    ready: true,
  });
});

test("is not ready when dsh is missing", () => {
  assert.deepEqual(runtimeStatus({ dshPath: null }), { dshPath: null, ready: false });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @science-studio/desktop`
Expected: FAIL — the old `config.test.ts` asserts provider/model, and `RuntimeStatus` still has them.

- [ ] **Step 3: Write the minimal implementation**

In `apps/desktop/src/shared/paths.ts`, add `settingsPath: string;` to `DesktopPaths` and `settingsPath: join(input.userDataDir, "settings.json"),` to the returned object.

In `apps/desktop/src/shared/config.ts`, replace the file's body with:

```ts
import type { DesktopPaths } from "./paths.js";

export interface DesktopConfig {
  vars?: Record<string, string>;
}

export function parseConfigEnv(text: string): DesktopConfig {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return Object.keys(vars).length > 0 ? { vars } : {};
}

export function serializeConfigEnv(config: DesktopConfig): string {
  const lines = Object.keys(config.vars ?? {})
    .sort()
    .map((key) => `${key}=${config.vars![key]}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function buildChildEnv(input: {
  base: NodeJS.ProcessEnv;
  config: DesktopConfig;
  paths: DesktopPaths;
}): NodeJS.ProcessEnv {
  const { base, config, paths } = input;
  const env: NodeJS.ProcessEnv = { ...base, ...(config.vars ?? {}) };
  delete env.SS_ENTERPRISE_MODULE;
  env.NODE_ENV = "production";
  env.TRANSPORT_RUNTIME = "dsh";
  env.PROJECT_ROOT = paths.projectRoot;
  env.RECORD_STORE_PATH = paths.recordStorePath;
  env.DSH_HOME = paths.dshHome;
  env.DSH_TRANSCRIPT_DIR = paths.transcriptDir;
  env.DSH_DEFAULT_SESSION = "science-studio";
  env.SS_SETTINGS_PATH = paths.settingsPath;
  return env;
}
```

In `apps/desktop/src/shared/runtime-status.ts`, replace the file's body with:

```ts
export interface RuntimeStatus {
  dshPath: string | null;
  ready: boolean;
}

export function runtimeStatus(input: { dshPath: string | null }): RuntimeStatus {
  return { dshPath: input.dshPath, ready: input.dshPath !== null };
}
```

In `apps/desktop/src/main/index.ts`, update the `desktop:runtimeStatus` handler:

```ts
  ipcMain.handle("desktop:runtimeStatus", async () =>
    runtimeStatus({ dshPath: detectDsh({ pathEnv: pathEnv() }) }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @science-studio/desktop && npm run typecheck -w @science-studio/desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/config.ts apps/desktop/src/shared/paths.ts apps/desktop/src/shared/runtime-status.ts apps/desktop/src/main/index.ts apps/desktop/test/config.test.ts apps/desktop/test/paths.test.ts apps/desktop/test/runtime-status.test.ts
git commit -m "refactor(desktop): narrow config.env to paths, add SS_SETTINGS_PATH"
```

## Task 14: Retire the standalone Settings window

**Files:**
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/windows.ts`, `apps/desktop/package.json`, `apps/desktop/tsconfig.json`
- Delete: `apps/desktop/src/renderer/config.ts`, `apps/desktop/src/renderer/config.html`, `apps/desktop/scripts/copy-renderer.mjs`, `apps/desktop/tsconfig.renderer.json`
- Test: `apps/desktop/test/settings-removed.test.ts`

**Interfaces:**
- Produces: no config window and no `desktop:getConfig`/`desktop:setConfig`; the app always opens the workbench; the menu's Settings item opens the workbench.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/settings-removed.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rendererDir = fileURLToPath(new URL("../src/renderer/", import.meta.url));

test("the standalone config window is retired", async () => {
  await assert.rejects(() => access(`${rendererDir}config.ts`));
  await assert.rejects(() => access(`${rendererDir}config.html`));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/desktop`
Expected: FAIL — the files still exist.

- [ ] **Step 3: Remove the window and its wiring**

- Delete `apps/desktop/src/renderer/config.ts`, `apps/desktop/src/renderer/config.html`, `apps/desktop/scripts/copy-renderer.mjs`, `apps/desktop/tsconfig.renderer.json`.
- In `apps/desktop/src/main/windows.ts`, delete `createConfigWindow` and the now-unused `join`/`dirname`/`fileURLToPath` imports if nothing else uses them (keep `createWorkbenchWindow`).
- In `apps/desktop/src/main/index.ts`:
  - remove `createConfigWindow` from the `windows.js` import;
  - remove the `let settings` variable, `openSettings`, and the `desktop:getConfig` / `desktop:setConfig` / `desktop:detectDsh` handlers (keep `desktop:runtimeStatus`, `desktop:openWorkbench`, `desktop:openPath`, `desktop:restartHost`);
  - remove the `writeConfig` helper and drop `serializeConfigEnv` from the `config.js` import (keep `buildChildEnv`, `parseConfigEnv`);
  - in `installMenu`, change the `Settings…` item's click to `() => { void openWorkbench(); }`;
  - replace the `whenReady` config/dsh branch with:

```ts
    await openWorkbench();
```

- In `apps/desktop/package.json`, change `build` from `tsc -b && tsc -p tsconfig.renderer.json && node scripts/copy-renderer.mjs` to `tsc -b`.
- In `apps/desktop/tsconfig.json`, remove the `"exclude": ["src/renderer"]` entry (the directory is gone).

- [ ] **Step 4: Run test + type gate**

Run: `npm run test -w @science-studio/desktop && npm run typecheck -w @science-studio/desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/desktop
git commit -m "refactor(desktop): retire the standalone Settings window"
```

## Task 15: Read the route from the service; expose restart

**Files:**
- Modify: `apps/desktop/src/preload/workbench.cts`, `apps/web/components/studio/status-bar.tsx`

**Interfaces:**
- Consumes: `desktopBridge()` (Task 8), `fetchSettings` (Task 5), `desktop:restartHost` (existing IPC).
- Produces: `restartHost` on the workbench bridge; `RuntimeChip` reads the route from the service.

- [ ] **Step 1: Expose restart in the workbench preload**

Replace `apps/desktop/src/preload/workbench.cts`'s `api` with:

```ts
const api = {
  runtimeStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke("desktop:runtimeStatus"),
  restartHost: (): Promise<{ webPort: number; apiPort: number } | null> =>
    ipcRenderer.invoke("desktop:restartHost"),
};
```

- [ ] **Step 2: Read the route from the settings service**

In `apps/web/components/studio/status-bar.tsx`, add `fetchSettings` to the
`@science-studio/transport-client` import, and replace the whole `RuntimeChip`
function with:

```tsx
function RuntimeChip() {
  const [status, setStatus] = React.useState<{ dshPath: string | null; ready: boolean } | null>(null);
  const [route, setRoute] = React.useState<string | null>(null);
  const [present, setPresent] = React.useState(false);

  React.useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.runtimeStatus) return;
    setPresent(true);
    let active = true;
    void bridge
      .runtimeStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    let active = true;
    void fetchSettings()
      .then((view) => {
        if (!active) return;
        setRoute(`${view.model.provider ?? "not set"} / ${view.model.model ?? "not set"}`);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!present) return null;
  const ready = status?.ready === true;
  const label = status === null ? "runtime: …" : ready ? "runtime: ready" : "runtime: dsh missing";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-5 gap-1.5 px-1.5">
          <Cpu className={ready ? "size-3.5 text-emerald-500" : "size-3.5 opacity-50"} />
          <span className="max-w-[14rem] truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="text-sm font-semibold">Runtime</div>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">dsh</dt>
            <dd className="break-all">{status?.dshPath ?? "missing"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">route</dt>
            <dd className="break-all">{route ?? "…"}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          {ready
            ? "The desktop app found dsh. Configure the model route in Settings."
            : "Install dsh, then configure the model route in Settings."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck -w @science-studio/desktop`
Run: `npm run build -w @science-studio/transport-client && npm run typecheck -w @science-studio/web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload/workbench.cts apps/web/components/studio/status-bar.tsx
git commit -m "feat(desktop): expose restart and read the route from the service"
```

---

## Final gate

- [ ] **Step 1: Full build + typecheck**

Run: `npm run build`
Expected: PASS (record → transport → workspace → contract-tests → transport-client → transport-openclaw → transport-dsh → transport-service, then `typecheck:tests`).

- [ ] **Step 2: All package suites**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Web e2e**

Run: `npm run build -w @science-studio/transport-client && npm run test:e2e -w @science-studio/web`
Expected: PASS (or SKIP where no Chromium).

- [ ] **Step 4: Desktop suite**

Run: `npm run test -w @science-studio/desktop`
Expected: PASS.

## Self-review notes (resolved inline)

- **Spec coverage:** seam types (T1), store (T2), API (T3), precedence (T4),
  client (T5), proxy (T6), store state (T7), shared bridge + UI (T8), e2e (T9),
  dsh binding route (T10), settings.yaml merge (T11), launch env + adapter apply
  (T12), desktop config/status (T13), settings window retirement (T14),
  RuntimeChip + restart (T15). Plugins/Agent empty states are in T8. Write-only
  key is pinned by T2/T3/T5/T8.
- **Type consistency:** `ModelSettingsPatch` exists because
  `Partial<ModelSettings> & { apiKey?: string | null }` would intersect `null`
  away; T1 defines it, T2 uses it, T5 re-exports it. `SS_MODEL_ENDPOINT` /
  `SS_MODEL_API_KEY` are written in T2 and read in T10. `DshClientLaunchOptions.env`
  is defined and consumed in T12 (one deliverable, so no red task).
- **Existing-file corrections:** `apps/desktop/test/config.test.ts` already
  exists — T13 rewrites it instead of creating it; `runtime-status.ts` and its
  test are updated because the route left `config.env`.
