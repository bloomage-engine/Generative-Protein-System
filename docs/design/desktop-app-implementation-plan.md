# Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Science Studio as a distributable Electron desktop app that launches the Next workbench and the transport-service itself, on loopback ephemeral ports, against a user-configured `dsh` model route.

**Architecture:** A new `apps/desktop` workspace. Electron's main process owns only the window, menus, and lifecycle; a forked Node child (the "desktop host") starts the Fastify transport-service in-process and spawns the Next standalone server as a grandchild, then reports both ports back over IPC. The renderer is the existing Next app, unmodified. A small Electron-rendered config window writes `<userData>/config.env`, which the main process turns into the `DSH_*`/`PROJECT_ROOT`/`RECORD_STORE_PATH` env the host inherits. Packaging bundles the host with esbuild and ships the Next standalone tree via `electron-builder` `extraResources`. See `docs/adr/0013-desktop-app-is-electron-with-embedded-servers.md`.

**Tech Stack:** Electron 38+, `electron-builder`, esbuild, TypeScript (ESM), `node:test` + `tsx`, Next 15.5.25 standalone output, Fastify 5 (via `@science-studio/transport-service`).

## Global Constraints

- `save-exact=true` is set in the root `.npmrc`: every new dependency must be installed with an exact version (never a `^`/`~` range).
- The desktop app lives in `apps/desktop` and is OUTSIDE the root `npm run build` gate. It has its own `build`/`test`/`pack` scripts; do NOT add it to the root `build` chain.
- Product name is `Science Studio`; bundle id / `appId` is `ss.hx-engine.com`; window title `Science Studio`.
- Both servers bind `127.0.0.1` only, on ephemeral ports (`0`). They must never use 3000/3001. The app must run alongside a developer's `npm run dev`.
- Single-user only: never set `SS_ENTERPRISE_MODULE`. Default `TRANSPORT_RUNTIME=dsh`.
- Do NOT bundle the `dsh` binary or any model weights. The app probes `dsh` on `PATH` and degrades to a setup window when it is absent.
- All artifacts (code, ADR, docs, commit messages) are in English. Never add code comments unless surrounding code comments. Match the repo's `node:test` + `assert/strict` style.
- `apps/desktop` is `"type": "module"`; TypeScript compiles with the root `tsconfig.base.json` (`module: ESNext`, `moduleResolution: Bundler`, `strict`, `noUncheckedIndexedAccess`).

---

### Task 1: Let `createBackend` accept preloaded runtime plugins

**Why:** the packaged host is bundled by esbuild, so `createBackend`'s dynamic `import(specifier)` (a runtime variable) cannot be resolved from a bundle. Injecting the already-imported plugins keeps the composition root authoritative while making the host bundleable.

**Files:**
- Modify: `services/transport-service/src/composition.ts`
- Test: `services/transport-service/test/injected-plugins.test.ts`

**Interfaces:**
- Consumes: `RuntimePlugin` from `@science-studio/transport`; `resolveRuntimePlugins(env)` (existing).
- Produces: `createBackend(env?: NodeJS.ProcessEnv, plugins?: readonly RuntimePlugin[]): Promise<Backend>` — when `plugins` is non-empty it is used verbatim; otherwise behavior is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// services/transport-service/test/injected-plugins.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackend } from "../src/composition.js";
import type { RuntimePlugin } from "@science-studio/transport";

const stubPlugin: RuntimePlugin = {
  runtime: "dsh",
  factory: {
    runtime: "dsh",
    capabilities: { approvals: false },
    create: () => ({ runtime: "dsh", init: async () => {}, run: async function* () {} }) as never,
  },
  localBinding: () => ({ runtime: "dsh", config: {} }),
};

test("createBackend uses preloaded plugins instead of importing by specifier", async () => {
  const backend = await createBackend({ TRANSPORT_RUNTIME: "dsh", RECORD_STORE: "memory" }, [stubPlugin]);
  assert.ok(backend.environments);
  assert.equal(backend.capabilities?.approvals, false);
});

test("createBackend throws when the selected runtime has no preloaded plugin", async () => {
  await assert.rejects(
    () => createBackend({ TRANSPORT_RUNTIME: "nope", RECORD_STORE: "memory" }, [stubPlugin]),
    /no runtime plugin registered for "nope"/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/transport-service -- --test-name-pattern="preloaded plugins"`
Expected: FAIL — `createBackend` ignores the second argument and tries to import `@science-studio/transport-dsh`, so the second test's message differs / the first uses the real adapter.

- [ ] **Step 3: Implement the injection**

In `services/transport-service/src/composition.ts`, change the signature and thread it through:

```ts
export async function createBackend(
  env: NodeJS.ProcessEnv = process.env,
  plugins?: readonly RuntimePlugin[],
): Promise<Backend> {
  const specifier = env.SS_ENTERPRISE_MODULE;
  if (specifier) {
    const mod = (await import(specifier)) as EnterpriseModule;
    return mod.createBackend(env);
  }
  return localBackend(env, plugins);
}

async function localBackend(
  env: NodeJS.ProcessEnv,
  preloaded?: readonly RuntimePlugin[],
): Promise<Backend> {
  const plugins = preloaded && preloaded.length > 0 ? [...preloaded] : await resolveRuntimePlugins(env);
  // ...unchanged from here
}
```

Update the `docs/adr/0013` reference in the header comment of `composition.ts` only if one exists (it does not — leave the file's existing comments untouched).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @science-studio/transport-service`
Expected: PASS (all suites), including the two new tests.

- [ ] **Step 5: Type-check the change**

Run: `npm run build -w @science-studio/transport-service`
Expected: exits 0, `dist/composition.js` rewritten.

- [ ] **Step 6: Commit**

```bash
git add services/transport-service/src/composition.ts services/transport-service/test/injected-plugins.test.ts
git commit -m "feat(service): allow createBackend to accept preloaded runtime plugins"
```

---

### Task 2: Scaffold the `apps/desktop` workspace

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/index.ts`

**Interfaces:**
- Produces: workspace name `@science-studio/desktop`; `dist/` ESM output; scripts `build`, `test`, `start`, `pack`.

- [ ] **Step 1: Create the package manifest**

`apps/desktop/package.json` (omit version ranges on install; `npm i` writes exact versions):

```json
{
  "name": "@science-studio/desktop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/main/index.js",
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit",
    "test": "node --import tsx --test test/*.test.ts",
    "start": "npm run build && electron .",
    "pack": "npm run build && npm run build:desktop && electron-builder"
  },
  "dependencies": {
    "@science-studio/transport-dsh": "*",
    "@science-studio/transport-service": "*",
    "@science-studio/transport": "*"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.19.0"
  }
}
```

- [ ] **Step 2: Create the TypeScript project**

`apps/desktop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.mts"],
  "references": [
    { "path": "../../packages/transport" },
    { "path": "../../services/transport-service" }
  ]
}
```

`apps/desktop/src/index.ts`:

```ts
export {};
```

- [ ] **Step 3: Install dependencies (exact versions)**

Run: `npm install -w @science-studio/desktop`
Then: `npm install -w @science-studio/desktop --save-dev electron electron-builder esbuild`
Expected: `apps/desktop/package.json` gains exact versions under `devDependencies`; root `package-lock.json` updates.

- [ ] **Step 4: Verify the empty workspace builds**

Run: `npm run build -w @science-studio/desktop`
Expected: exits 0; `apps/desktop/dist/index.js` exists.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/package.json apps/desktop/tsconfig.json apps/desktop/src/index.ts package-lock.json
git commit -m "chore(desktop): scaffold the electron workspace"
```

---

### Task 3: `resolveDesktopPaths` (pure)

**Files:**
- Create: `apps/desktop/src/shared/paths.ts`
- Test: `apps/desktop/test/paths.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DesktopPaths {
    userDataDir: string;
    configPath: string;
    recordStorePath: string;
    projectRoot: string;
    dshHome: string;
    transcriptDir: string;
  }
  export function resolveDesktopPaths(input: {
    userDataDir: string;
    homeDir: string;
    env?: NodeJS.ProcessEnv;
  }): DesktopPaths;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/paths.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDesktopPaths } from "../src/shared/paths.js";

test("internal state lives under userData", () => {
  const p = resolveDesktopPaths({ userDataDir: "/ud", homeDir: "/home/me" });
  assert.equal(p.configPath, "/ud/config.env");
  assert.equal(p.recordStorePath, "/ud/record.jsonl");
  assert.equal(p.dshHome, "/ud/dsh");
  assert.equal(p.transcriptDir, "/ud/transcripts");
});

test("Projects default to ~/Documents/Science Studio/projects", () => {
  const p = resolveDesktopPaths({ userDataDir: "/ud", homeDir: "/home/me" });
  assert.equal(p.projectRoot, "/home/me/Documents/Science Studio/projects");
});

test("an explicit PROJECT_ROOT wins", () => {
  const p = resolveDesktopPaths({ userDataDir: "/ud", homeDir: "/home/me", env: { PROJECT_ROOT: "/data/ss" } });
  assert.equal(p.projectRoot, "/data/ss");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/desktop -- --test-name-pattern="userData"`
Expected: FAIL — `Cannot find module '../src/shared/paths.js'`.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/shared/paths.ts
import { join } from "node:path";

export interface DesktopPaths {
  userDataDir: string;
  configPath: string;
  recordStorePath: string;
  projectRoot: string;
  dshHome: string;
  transcriptDir: string;
}

export function resolveDesktopPaths(input: {
  userDataDir: string;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
}): DesktopPaths {
  const env = input.env ?? {};
  return {
    userDataDir: input.userDataDir,
    configPath: join(input.userDataDir, "config.env"),
    recordStorePath: join(input.userDataDir, "record.jsonl"),
    projectRoot: env.PROJECT_ROOT ?? join(input.homeDir, "Documents", "Science Studio", "projects"),
    dshHome: join(input.userDataDir, "dsh"),
    transcriptDir: join(input.userDataDir, "transcripts"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @science-studio/desktop`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/paths.ts apps/desktop/test/paths.test.ts
git commit -m "feat(desktop): resolve the app's data directories"
```

---

### Task 4: Config parsing, serialization, and child env (pure)

**Files:**
- Create: `apps/desktop/src/shared/config.ts`
- Test: `apps/desktop/test/config.test.ts`

**Interfaces:**
- Consumes: `DesktopPaths` (Task 3).
- Produces:
  ```ts
  export interface DesktopConfig { provider?: string; model?: string; vars?: Record<string, string> }
  export function parseConfigEnv(text: string): DesktopConfig;
  export function serializeConfigEnv(config: DesktopConfig): string;
  export function buildChildEnv(input: {
    base: NodeJS.ProcessEnv;
    config: DesktopConfig;
    paths: DesktopPaths;
  }): NodeJS.ProcessEnv;
  ```
  `buildChildEnv` sets `TRANSPORT_RUNTIME=dsh`, `NODE_ENV=production`, `DSH_PROVIDER`, `DSH_MODEL`, `DSH_HOME`, `DSH_TRANSCRIPT_DIR`, `DSH_DEFAULT_SESSION=science-studio`, `PROJECT_ROOT`, `RECORD_STORE_PATH`, and every `config.vars` entry.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv, parseConfigEnv, serializeConfigEnv } from "../src/shared/config.js";
import { resolveDesktopPaths } from "../src/shared/paths.js";

test("parseConfigEnv reads KEY=VALUE, ignoring blanks and comments", () => {
  const config = parseConfigEnv("# route\nDSH_PROVIDER=ollama-local\n\nDSH_MODEL=qwen3.8:latest\nOLLAMA_LOCAL_API_KEY=secret\n");
  assert.deepEqual(config, {
    provider: "ollama-local",
    model: "qwen3.8:latest",
    vars: { OLLAMA_LOCAL_API_KEY: "secret" },
  });
});

test("serializeConfigEnv round-trips through parseConfigEnv", () => {
  const config = { provider: "deepseek-official", model: "deepseek-v4-flash", vars: { DEEPSEEK_API_KEY: "k" } };
  assert.deepEqual(parseConfigEnv(serializeConfigEnv(config)), config);
});

test("buildChildEnv pins dsh and the app's directories", () => {
  const paths = resolveDesktopPaths({ userDataDir: "/ud", homeDir: "/home/me" });
  const env = buildChildEnv({ base: { PATH: "/bin" }, config: { provider: "p", model: "m" }, paths });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.TRANSPORT_RUNTIME, "dsh");
  assert.equal(env.DSH_PROVIDER, "p");
  assert.equal(env.DSH_MODEL, "m");
  assert.equal(env.DSH_DEFAULT_SESSION, "science-studio");
  assert.equal(env.DSH_HOME, "/ud/dsh");
  assert.equal(env.DSH_TRANSCRIPT_DIR, "/ud/transcripts");
  assert.equal(env.PROJECT_ROOT, "/home/me/Documents/Science Studio/projects");
  assert.equal(env.RECORD_STORE_PATH, "/ud/record.jsonl");
  assert.equal(env.SS_ENTERPRISE_MODULE, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/desktop -- --test-name-pattern="parseConfigEnv"`
Expected: FAIL — `Cannot find module '../src/shared/config.js'`.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/shared/config.ts
import type { DesktopPaths } from "./paths.js";

export interface DesktopConfig {
  provider?: string;
  model?: string;
  vars?: Record<string, string>;
}

export function parseConfigEnv(text: string): DesktopConfig {
  const vars: Record<string, string> = {};
  let provider: string | undefined;
  let model: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "DSH_PROVIDER") provider = value;
    else if (key === "DSH_MODEL") model = value;
    else vars[key] = value;
  }
  const config: DesktopConfig = {};
  if (provider !== undefined) config.provider = provider;
  if (model !== undefined) config.model = model;
  if (Object.keys(vars).length > 0) config.vars = vars;
  return config;
}

export function serializeConfigEnv(config: DesktopConfig): string {
  const lines: string[] = [];
  if (config.provider !== undefined) lines.push(`DSH_PROVIDER=${config.provider}`);
  if (config.model !== undefined) lines.push(`DSH_MODEL=${config.model}`);
  for (const key of Object.keys(config.vars ?? {}).sort()) lines.push(`${key}=${config.vars![key]}`);
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
  if (config.provider !== undefined) env.DSH_PROVIDER = config.provider;
  if (config.model !== undefined) env.DSH_MODEL = config.model;
  return env;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @science-studio/desktop`
Expected: PASS (Task 3 + 4 suites).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/config.ts apps/desktop/test/config.test.ts
git commit -m "feat(desktop): parse and serialize the model-route config"
```

---

### Task 5: `getFreePort` (loopback ephemeral)

**Files:**
- Create: `apps/desktop/src/shared/net.ts`
- Test: `apps/desktop/test/net.test.ts`

**Interfaces:**
- Produces: `getFreePort(host?: string): Promise<number>` — resolves an OS-assigned free TCP port on `127.0.0.1` (default).

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/net.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { getFreePort } from "../src/shared/net.js";

test("getFreePort returns a port that can be bound", async () => {
  const port = await getFreePort();
  assert.ok(Number.isInteger(port) && port > 0);
  await new Promise<void>((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/desktop -- --test-name-pattern="getFreePort"`
Expected: FAIL — `Cannot find module '../src/shared/net.js'`.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/shared/net.ts
import { createServer } from "node:net";

export function getFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @science-studio/desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/net.ts apps/desktop/test/net.test.ts
git commit -m "feat(desktop): pick a free loopback port"
```

---

### Task 6: `detectDsh` (PATH probe)

**Files:**
- Create: `apps/desktop/src/shared/dsh.ts`
- Test: `apps/desktop/test/dsh.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function detectDsh(input?: {
    pathEnv?: string;
    platform?: NodeJS.Platform;
    access?: (path: string) => void;   // throws when not executable
  }): string | null;
  ```
  Returns the first executable `dsh` on `PATH`, or `null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/dsh.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { detectDsh } from "../src/shared/dsh.js";

test("returns the first PATH entry containing an executable dsh", () => {
  const found = detectDsh({
    pathEnv: ["/none", "/opt/bin", "/usr/bin"].join(delimiter),
    access: (p) => {
      if (p !== join("/opt/bin", "dsh")) throw new Error("ENOENT");
    },
  });
  assert.equal(found, "/opt/bin/dsh");
});

test("returns null when no PATH entry has dsh", () => {
  assert.equal(detectDsh({ pathEnv: "/a:/b", access: () => { throw new Error("ENOENT"); } }), null);
});

test("returns null for an unset PATH", () => {
  assert.equal(detectDsh({ pathEnv: undefined, access: () => {} }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/desktop -- --test-name-pattern="dsh"`
Expected: FAIL — `Cannot find module '../src/shared/dsh.js'`.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/shared/dsh.ts
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function detectDsh(input: {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  access?: (path: string) => void;
} = {}): string | null {
  const pathEnv = input.pathEnv ?? process.env.PATH ?? "";
  const access = input.access ?? ((p: string) => accessSync(p, constants.X_OK));
  const names = (input.platform ?? process.platform) === "win32" ? ["dsh.exe", "dsh.cmd", "dsh.bat"] : ["dsh"];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        access(candidate);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @science-studio/desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/dsh.ts apps/desktop/test/dsh.test.ts
git commit -m "feat(desktop): probe PATH for the dsh CLI"
```

---

### Task 7: `startNextServer`

**Files:**
- Create: `apps/desktop/src/server/next.ts`
- Test: `apps/desktop/test/next.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NextServerHandle { port: number; close(): Promise<void> }
  export function waitForHttp(url: string, proc: { exitCode: number | null }, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
  export async function startNextServer(input: {
    nextDir: string; apiBaseUrl: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void;
  }): Promise<NextServerHandle>;
  ```
- Test `waitForHttp` directly against a throwaway `node:http` server; do NOT spawn Next in the unit test.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/next.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { waitForHttp } from "../src/server/next.js";

test("waitForHttp resolves once the server answers", async () => {
  const srv = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, { exitCode: null });
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("waitForHttp rejects when the process exits", async () => {
  await assert.rejects(() => waitForHttp("http://127.0.0.1:1/", { exitCode: 1 }), /next server exited/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/desktop -- --test-name-pattern="waitForHttp"`
Expected: FAIL — `Cannot find module '../src/server/next.js'`.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/server/next.ts
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { getFreePort } from "../shared/net.js";

export interface NextServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function waitForHttp(
  url: string,
  proc: { exitCode: number | null },
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`next server exited (${proc.exitCode})`);
    try {
      await fetch(url, { method: "GET" });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`next server did not answer ${url} in ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export async function startNextServer(input: {
  nextDir: string;
  apiBaseUrl: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): Promise<NextServerHandle> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [join(input.nextDir, "server.js")], {
    cwd: input.nextDir,
    env: {
      ...process.env,
      ...input.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      TRANSPORT_SERVICE_URL: input.apiBaseUrl,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => input.log?.(d.toString()));
  child.stderr?.on("data", (d: Buffer) => input.log?.(d.toString()));
  await waitForHttp(`http://127.0.0.1:${port}/`, child);
  return { port, close: () => stopChild(child) };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @science-studio/desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/server/next.ts apps/desktop/test/next.test.ts
git commit -m "feat(desktop): start and await the next standalone server"
```

---

### Task 8: The desktop host (`startHost`) and its fork entry

**Files:**
- Create: `apps/desktop/src/server/host.ts`
- Create: `apps/desktop/src/server/host-main.ts`
- Create: `apps/desktop/src/server/report.ts`
- Test: `apps/desktop/test/host.test.ts`

**Interfaces:**
- Consumes: `startNextServer`/`NextServerHandle` (Task 7); `createBackend`, `createTransportService` from `@science-studio/transport-service`; `runtimePlugins` from `@science-studio/transport-dsh`.
- Produces:
  ```ts
  export interface HostHandle { webPort: number; apiPort: number; close(): Promise<void> }
  export async function startHost(options: {
    nextDir: string;
    env: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    startWeb?: typeof startNextServer;
    startApi?: (env: NodeJS.ProcessEnv) => Promise<{ port: number; close(): Promise<void> }>;
  }): Promise<HostHandle>;
  export function readyMessage(ports: { webPort: number; apiPort: number }): { type: "ready"; webPort: number; apiPort: number };
  export function reportReady(ports: { webPort: number; apiPort: number }): void;
  ```
- `startHost` starts the API first (so its port exists), then hands the web server `apiBaseUrl = http://127.0.0.1:<apiPort>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/host.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startHost } from "../src/server/host.js";
import { readyMessage } from "../src/server/report.js";

test("startHost wires the web server to the api port and closes both", async () => {
  let seenApiBaseUrl = "";
  const host = await startHost({
    nextDir: "/unused",
    env: {},
    startApi: async () => ({
      port: await new Promise<number>((resolve) => {
        const srv = createServer((_req, res) => res.end("api"));
        srv.listen(0, "127.0.0.1", () => {
          const address = srv.address();
          resolve(typeof address === "object" && address ? address.port : 0);
        });
      }),
      close: async () => {},
    }),
    startWeb: async ({ apiBaseUrl }) => {
      seenApiBaseUrl = apiBaseUrl;
      return { port: 45678, close: async () => {} };
    },
  });
  assert.match(seenApiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(host.webPort, 45678);
  assert.ok(host.apiPort > 0);
  await host.close();
});

test("readyMessage has the shape the fork parent listens for", () => {
  assert.deepEqual(readyMessage({ webPort: 1, apiPort: 2 }), { type: "ready", webPort: 1, apiPort: 2 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @science-studio/desktop -- --test-name-pattern="startHost"`
Expected: FAIL — `Cannot find module '../src/server/host.js'`.

- [ ] **Step 3: Implement `report.ts` and `host.ts`**

```ts
// apps/desktop/src/server/report.ts
export function readyMessage(ports: { webPort: number; apiPort: number }): {
  type: "ready";
  webPort: number;
  apiPort: number;
} {
  return { type: "ready", webPort: ports.webPort, apiPort: ports.apiPort };
}

export function reportReady(ports: { webPort: number; apiPort: number }): void {
  const message = readyMessage(ports);
  if (typeof process.send === "function") process.send(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
}
```

```ts
// apps/desktop/src/server/host.ts
import { startNextServer, type NextServerHandle } from "./next.js";

export interface HostHandle {
  webPort: number;
  apiPort: number;
  close(): Promise<void>;
}

export async function startHost(options: {
  nextDir: string;
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  startWeb?: typeof startNextServer;
  startApi?: (env: NodeJS.ProcessEnv) => Promise<{ port: number; close(): Promise<void> }>;
}): Promise<HostHandle> {
  const startApi = options.startApi ?? defaultStartApi;
  const startWeb = options.startWeb ?? startNextServer;
  const api = await startApi(options.env);
  const apiBaseUrl = `http://127.0.0.1:${api.port}`;
  let web: NextServerHandle;
  try {
    web = await startWeb({ nextDir: options.nextDir, apiBaseUrl, env: options.env, log: options.log });
  } catch (err) {
    await api.close();
    throw err;
  }
  return {
    webPort: web.port,
    apiPort: api.port,
    async close() {
      await web.close();
      await api.close();
    },
  };
}

async function defaultStartApi(env: NodeJS.ProcessEnv): Promise<{ port: number; close(): Promise<void> }> {
  const { createBackend, createTransportService } = await import("@science-studio/transport-service");
  const { runtimePlugins } = await import("@science-studio/transport-dsh");
  const backend = await createBackend(env, runtimePlugins);
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => app.close() };
}
```

- [ ] **Step 4: Implement the fork entry**

```ts
// apps/desktop/src/server/host-main.ts
import { startHost } from "./host.js";
import { reportReady } from "./report.js";

const nextDir = process.env.DESKTOP_NEXT_DIR;
if (!nextDir) {
  process.stderr.write("[desktop-host] DESKTOP_NEXT_DIR is required\n");
  process.exit(1);
}

startHost({ nextDir, env: process.env, log: (line) => process.stderr.write(line) })
  .then((host) => {
    const shutdown = () => {
      host.close().finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    reportReady({ webPort: host.webPort, apiPort: host.apiPort });
  })
  .catch((err) => {
    process.stderr.write(`[desktop-host] ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w @science-studio/desktop`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/server/host.ts apps/desktop/src/server/host-main.ts apps/desktop/src/server/report.ts apps/desktop/test/host.test.ts
git commit -m "feat(desktop): host the transport service and next server in one child"
```

---

### Task 9: Next standalone output

**Files:**
- Modify: `apps/web/next.config.mjs`
- Modify: `package.json` (root scripts)

**Interfaces:**
- Produces: `apps/web/.next/standalone/server.js`; root script `build:web:standalone`.

- [ ] **Step 1: Add standalone output, gated by an env flag**

`apps/web/next.config.mjs`:

```js
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  ...(process.env.NEXT_OUTPUT === "standalone"
    ? { output: "standalone", outputFileTracingRoot: join(here, "..", "..") }
    : {}),
};

export default nextConfig;
```

- [ ] **Step 2: Add the root script**

In root `package.json` `scripts`, add (do not change the existing `build` chain):

```json
"build:web:standalone": "NEXT_OUTPUT=standalone npm run build -w @science-studio/web",
```

- [ ] **Step 3: Build and verify the standalone tree**

Run: `npm run build:web:standalone`
Expected: exits 0; the traced app is NESTED because `outputFileTracingRoot` is the
repo root — `server.js` lands at `apps/web/.next/standalone/apps/web/server.js`
(confirmed empirically; a flat `standalone/server.js` does NOT exist). The
directory containing `server.js` — `apps/web/.next/standalone/apps/web` — is the
`nextDir` the desktop host launches from and the `cwd` it uses.

Verify with: `find apps/web/.next/standalone -maxdepth 3 -name server.js`.

- [ ] **Step 4: Verify a normal web build is unaffected**

Run: `npm run build -w @science-studio/web`
Expected: exits 0 and does NOT emit `apps/web/.next/standalone` semantics changes (the flag is unset).

- [ ] **Step 5: Commit**

```bash
git add apps/web/next.config.mjs package.json
git commit -m "build(web): optional next standalone output for the desktop app"
```

---

### Task 10: Electron main process

**Files:**
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/host-child.ts`
- Create: `apps/desktop/src/main/windows.ts`

**Interfaces:**
- Consumes: `resolveDesktopPaths` (Task 3), `buildChildEnv`/`parseConfigEnv`/`serializeConfigEnv` (Task 4), `detectDsh` (Task 6), host entry (Task 8).
- Produces: IPC channels `desktop:getConfig`, `desktop:setConfig`, `desktop:detectDsh`, `desktop:openPath`, `desktop:restartHost`; the `scienceStudioDesktop` preload bridge (Task 11).

- [ ] **Step 1: Implement the host fork helper**

```ts
// apps/desktop/src/main/host-child.ts
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface HostPorts {
  webPort: number;
  apiPort: number;
}

export function forkHost(input: {
  hostEntry: string;
  nextDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
}): Promise<{ ports: HostPorts; child: ChildProcess }> {
  const child = fork(input.hostEntry, [], {
    cwd: input.cwd,
    env: { ...input.env, DESKTOP_NEXT_DIR: input.nextDir, ELECTRON_RUN_AS_NODE: "1" },
    execPath: process.execPath,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.on("data", (d: Buffer) => input.onLine?.(d.toString()));
  child.stderr?.on("data", (d: Buffer) => input.onLine?.(d.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("desktop host did not become ready within 60s")), 60_000);
    child.on("message", (message) => {
      const m = message as { type?: string; webPort?: number; apiPort?: number };
      if (m?.type === "ready" && typeof m.webPort === "number" && typeof m.apiPort === "number") {
        clearTimeout(timer);
        resolve({ ports: { webPort: m.webPort, apiPort: m.apiPort }, child });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`desktop host exited (${code ?? "signal"})`));
    });
  });
}

export function hostEntryPath(appRoot: string): string {
  return join(appRoot, "build", "host", "host.mjs");
}
```

- [ ] **Step 2: Implement the window helpers**

```ts
// apps/desktop/src/main/windows.ts
import { BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function createWorkbenchWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Science Studio",
    backgroundColor: "#0b0b0b",
    webPreferences: {
      preload: join(here, "..", "preload", "index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void win.loadURL(url);
  return win;
}

export function createConfigWindow(appRoot: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 640,
    title: "Science Studio — Settings",
    webPreferences: {
      preload: join(here, "..", "preload", "index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void win.loadFile(join(appRoot, "dist", "renderer", "config.html"));
  return win;
}
```

The preload is ESM, so it MUST have the `.mjs` extension (Electron's rule
for ESM preload scripts) and `sandbox: false` — both already handled here.

- [ ] **Step 3: Implement the main entry**

```ts
// apps/desktop/src/main/index.ts
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { resolveDesktopPaths, type DesktopPaths } from "../shared/paths.js";
import { buildChildEnv, parseConfigEnv, serializeConfigEnv, type DesktopConfig } from "../shared/config.js";
import { detectDsh } from "../shared/dsh.js";
import { forkHost, hostEntryPath, type HostPorts } from "./host-child.js";
import { createConfigWindow, createWorkbenchWindow } from "./windows.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..");

let workbench: BrowserWindow | null = null;
let settings: BrowserWindow | null = null;
let host: ChildProcess | null = null;

function paths(): DesktopPaths {
  return resolveDesktopPaths({ userDataDir: app.getPath("userData"), homeDir: homedir() });
}

async function readConfig(): Promise<DesktopConfig> {
  try {
    return parseConfigEnv(await readFile(paths().configPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeConfig(config: DesktopConfig): Promise<void> {
  const p = paths();
  await mkdir(p.userDataDir, { recursive: true });
  await writeFile(p.configPath, serializeConfigEnv(config), "utf8");
}

function nextDir(): string {
  if (process.env.DESKTOP_NEXT_DIR) return process.env.DESKTOP_NEXT_DIR;
  if (app.isPackaged) return join(process.resourcesPath, "next", "apps", "web");
  return join(appRoot, "..", "web", ".next", "standalone", "apps", "web");
}

async function boot(): Promise<HostPorts> {
  const p = paths();
  await mkdir(p.userDataDir, { recursive: true });
  const env = buildChildEnv({ base: process.env, config: await readConfig(), paths: p });
  const { ports, child } = await forkHost({
    hostEntry: hostEntryPath(appRoot),
    nextDir: nextDir(),
    cwd: p.userDataDir,
    env,
    onLine: (line) => process.stderr.write(`[desktop-host] ${line}`),
  });
  host = child;
  child.on("exit", () => {
    host = null;
  });
  return ports;
}

async function openWorkbench(): Promise<void> {
  const ports = await boot();
  workbench = createWorkbenchWindow(`http://127.0.0.1:${ports.webPort}/`);
  workbench.on("closed", () => {
    workbench = null;
  });
}

function openSettings(): void {
  if (settings) {
    settings.focus();
    return;
  }
  settings = createConfigWindow(appRoot);
  settings.on("closed", () => {
    settings = null;
  });
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      {
        label: "Science Studio",
        submenu: [
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openSettings() },
          {
            label: "Open Projects Folder",
            click: () => {
              void shell.openPath(paths().projectRoot);
            },
          },
          {
            label: "Restart Service",
            click: async () => {
              host?.kill("SIGTERM");
              host = null;
              await workbench?.loadURL("about:blank");
              await openWorkbench();
            },
          },
        ],
      },
    ]),
  );
}

function registerIpc(): void {
  ipcMain.handle("desktop:getConfig", () => readConfig());
  ipcMain.handle("desktop:setConfig", async (_event, config: DesktopConfig) => {
    await writeConfig(config);
    return readConfig();
  });
  ipcMain.handle("desktop:detectDsh", () => detectDsh());
  ipcMain.handle("desktop:openPath", async (_event, path: string) => {
    await shell.openPath(path);
  });
  ipcMain.handle("desktop:restartHost", async () => {
    host?.kill("SIGTERM");
    host = null;
    return boot();
  });
}

void app.whenReady().then(async () => {
  registerIpc();
  installMenu();
  const missingConfig = (await readFile(paths().configPath, "utf8").catch(() => "")).length === 0;
  if (missingConfig || !detectDsh()) {
    openSettings();
  } else {
    await openWorkbench();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void openWorkbench();
  });
});

app.on("window-all-closed", () => {
  host?.kill("SIGTERM");
  host = null;
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 4: Build the host bundle and the desktop sources**

**Precondition:** the host bundle inlines `@science-studio/transport-service` and
`@science-studio/transport-dsh` from their built `dist/`, so run
`npm run build` (root) once before this step.

Add these scripts to `apps/desktop/package.json`:

```json
"build:host": "esbuild src/server/host-main.ts --bundle --platform=node --format=esm --target=node20 --outfile=build/host/host.mjs --external:electron --external:@deepseek-ai/dsh-sdk-client --external:@deepseek-ai/dsh --external:@deepseek-ai/dsh-llm --external:@deepseek-ai/dsh-session --external:dotenv --banner:js=\"import { createRequire } from 'module'; process.argv[1]=''; const require = createRequire(import.meta.url);\" && cp ../../packages/transport-dsh/dist/bridge-plugin.js build/host/ && cp ../../packages/transport-dsh/dist/project-plugin.js build/host/",
"build:web": "npm --prefix ../.. run build:web:standalone",
"build:desktop": "npm run build:host && npm run build:web"
```

Bundling rules learned while building this (do not "simplify" them away):

- **The `@deepseek-ai/*` SDK and `dotenv` MUST stay external.** The SDK resolves
  its own `package.json` via `new URL("../package.json", import.meta.url)`; inlined
  into the bundle that path is `build/package.json` and the host dies with ENOENT.
  Keeping them external makes Node resolve them from `node_modules` (dev: the
  hoisted repo root; packaged: see Task 12's `NODE_PATH`).
- **The banner is load-bearing.** `process.argv[1]=''` stops the bundled
  transport-service's `isMain` guard from self-starting a SECOND service on the
  default runtime; `createRequire` is required because bundled `fastify`/`avvio`
  contain dynamic `require` calls that fail with `Dynamic require of "node:events"`
  under esbuild's ESM output.
- **The two dsh child plugins are copied next to the bundle** because the adapter
  locates them via `new URL("./bridge-plugin.js", import.meta.url)` — which,
  bundled, resolves to the bundle's own directory.

- [ ] **Step 5: Manual dev smoke (no packaging yet)**

With a built web standalone (`npm run build:desktop`) and `dsh` on PATH plus a configured route, run:

```bash
npm run build -w @science-studio/desktop
npm run build:host -w @science-studio/desktop
DESKTOP_NEXT_DIR="$PWD/apps/web/.next/standalone/apps/web" npx electron apps/desktop
```

Expected: Electron opens two windows (Settings first when unconfigured), and after saving config and restarting, the workbench loads and the composer can send. Destroy on any error; capture `[desktop-host]` stderr lines.

Note: in a container/headless box (no X display, no root-owned
`chrome-sandbox`) Electron needs `--no-sandbox` and an X server; on a normal
developer desktop run the command as written. If the environment cannot open a
window, record that GUI verification was not possible here and rely on the
build/types plus the host's own tests — do NOT mark the task done on a GUI claim
that was never observed.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main apps/desktop/package.json
git commit -m "feat(desktop): electron main process forks the host and opens the workbench"
```

`build/host/` is GENERATED (esbuild output) and is gitignored via
`apps/desktop/build/` in the root `.gitignore` — never commit the bundle or the
copied child plugins. `electron-builder` reads the working-tree files at pack
time (Task 12).

---

### Task 11: Preload bridge and the settings/config window

**Files:**
- Create: `apps/desktop/src/preload/index.mts`
- Create: `apps/desktop/src/renderer/config.html`
- Create: `apps/desktop/src/renderer/config.ts`
- Modify: `apps/desktop/package.json` (renderer copy step)

**Interfaces:**
- Consumes: IPC channels from Task 10.
- Produces: `window.scienceStudioDesktop` with `getConfig`, `setConfig`, `detectDsh`, `openPath`, `restartHost`.

- [ ] **Step 1: Implement the preload bridge**

```ts
// apps/desktop/src/preload/index.mts
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopConfig } from "../shared/config.js";

const api = {
  getConfig: (): Promise<DesktopConfig> => ipcRenderer.invoke("desktop:getConfig"),
  setConfig: (config: DesktopConfig): Promise<DesktopConfig> => ipcRenderer.invoke("desktop:setConfig", config),
  detectDsh: (): Promise<string | null> => ipcRenderer.invoke("desktop:detectDsh"),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke("desktop:openPath", path),
  restartHost: (): Promise<{ webPort: number; apiPort: number }> => ipcRenderer.invoke("desktop:restartHost"),
};

contextBridge.exposeInMainWorld("scienceStudioDesktop", api);

export type ScienceStudioDesktopApi = typeof api;
```

- [ ] **Step 2: Implement the settings renderer**

`apps/desktop/src/renderer/config.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'" />
    <title>Science Studio — Settings</title>
  </head>
  <body>
    <main id="app">Loading…</main>
    <script type="module" src="./config.js"></script>
  </body>
</html>
```

`apps/desktop/src/renderer/config.ts`:

```ts
import type { ScienceStudioDesktopApi } from "../preload/index.mjs";

declare global {
  interface Window {
    scienceStudioDesktop?: ScienceStudioDesktopApi;
  }
}

const bridge = window.scienceStudioDesktop;
const app = document.getElementById("app")!;

function field(label: string, name: string, value: string, hint = ""): string {
  return `<label>${label}<input name="${name}" value="${value.replace(/"/g, "&quot;")}" />${
    hint ? `<small>${hint}</small>` : ""
  }</label>`;
}

async function render(): Promise<void> {
  if (!bridge) {
    app.textContent = "This window must be opened by the Science Studio desktop app.";
    return;
  }
  const [config, dshPath] = await Promise.all([bridge.getConfig(), bridge.detectDsh()]);
  const vars = Object.entries(config.vars ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  app.innerHTML = `
    <h1>Science Studio Settings</h1>
    <p>${
      dshPath ? `Found dsh at <code>${dshPath}</code>.` : "The <code>dsh</code> CLI was not found on PATH. Install it before running the agent."
    }</p>
    <form id="form">
      ${field("Provider", "provider", config.provider ?? "", "e.g. ollama-local — must exist in ~/.dsh/settings.yaml")}
      ${field("Model", "model", config.model ?? "", "e.g. qwen3.8:latest")}
      <label>Credentials / extra env<textarea name="vars" rows="6" placeholder="OLLAMA_LOCAL_API_KEY=...">${vars}</textarea></label>
      <button type="submit">Save</button>
    </form>
    <p id="status"></p>
  `;
  document.getElementById("form")!.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    const parsedVars: Record<string, string> = {};
    for (const line of String(data.get("vars") ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      parsedVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    const nextConfig = {
      ...(String(data.get("provider") ?? "").trim() ? { provider: String(data.get("provider")).trim() } : {}),
      ...(String(data.get("model") ?? "").trim() ? { model: String(data.get("model")).trim() } : {}),
      ...(Object.keys(parsedVars).length > 0 ? { vars: parsedVars } : {}),
    };
    await bridge.setConfig(nextConfig);
    document.getElementById("status")!.textContent = "Saved. Use Restart Service from the menu to apply.";
  });
}

void render();
```

- [ ] **Step 3: Copy renderer assets during build**

Add to `apps/desktop/package.json` scripts a post-build copy (renderer `.html` is not emitted by `tsc`):

```json
"build": "tsc -b && node scripts/copy-renderer.mjs"
```

Create `apps/desktop/scripts/copy-renderer.mjs`:

```js
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
await mkdir(join(root, "dist", "renderer"), { recursive: true });
await cp(join(root, "src", "renderer", "config.html"), join(root, "dist", "renderer", "config.html"));
```

- [ ] **Step 4: Verify the build emits everything**

Run: `npm run build -w @science-studio/desktop`
Expected: `dist/main/index.js`, `dist/preload/index.mjs`, `dist/renderer/config.html`, `dist/renderer/config.js` all exist.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload apps/desktop/src/renderer apps/desktop/scripts apps/desktop/package.json
git commit -m "feat(desktop): preload bridge and settings window"
```

---

### Task 12: Package with electron-builder

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/package.json`
- Test: `apps/desktop/test/builder-config.test.mjs`

**Interfaces:**
- Produces: `release/` artifacts; app id `ss.hx-engine.com`; product name `Science Studio`.

- [ ] **Step 1: Implement the builder config**

```yaml
# apps/desktop/electron-builder.yml
appId: ss.hx-engine.com
productName: Science Studio
directories:
  output: release
files:
  - dist/**/*
  - package.json
extraResources:
  - from: build/host
    to: host
  - from: ../web/.next/standalone
    to: next
  - from: ../web/.next/standalone/node_modules
    to: next/node_modules
  - from: ../web/.next/static
    to: next/apps/web/.next/static
  - from: ../web/public
    to: next/apps/web/public
mac:
  target:
    - dmg
  category: public.app-category.productivity
linux:
  target:
    - AppImage
    - deb
  category: Science
```

**The trace `node_modules` needs its OWN `extraResources` entry — this is not
optional.** `app-builder-lib`'s `createFilter` returns `false` for the copied
dir's ROOT `node_modules` (`relative === "node_modules"`), so the
`../web/.next/standalone` entry silently drops it and the packaged `server.js`
dies with `Cannot find module 'next'`. The separate
`from: ../web/.next/standalone/node_modules` entry copies its CONTENTS into
`next/node_modules`, which the filter does not prune. `next dev` clears `.next`,
so the standalone tree exists only right after `npm run build:web:standalone`
(which `npm run pack` runs).

- [ ] **Step 1b: Make the externalized SDK resolvable in the packaged app**

`build:host` leaves `@deepseek-ai/*` and `dotenv` external (Task 10), so the host
must find them at runtime. In dev, Node walks up to the hoisted repo
`node_modules`; packaged, they live in the app's `node_modules` inside
`app.asar`. Electron-as-node reads asar, so point `NODE_PATH` at it when packaged.

In `apps/desktop/src/main/index.ts`, in `boot()`, after `buildChildEnv(...)`, add:

```ts
if (app.isPackaged) {
  env.NODE_PATH = join(app.getAppPath(), "node_modules");
}
```

(`app.getAppPath()` is the `app.asar` path; `join` and `app` are already imported
in that file.)

Then verify the packaged tree actually contains those packages after Step 4:
`ls apps/desktop/release/linux-unpacked/resources/app.asar.unpacked 2>/dev/null`;
electron-builder ships production dependencies of the workspace's
`@science-studio/transport-dsh` into the asar. If `@deepseek-ai/dsh-sdk-client`
is absent from the packaged app, add it (and `@deepseek-ai/dsh`) to
`apps/desktop/package.json` `dependencies` so electron-builder collects them, and
re-pack. Confirm by unpacking the asar (`npx asar list
release/linux-unpacked/resources/app.asar | grep dsh-sdk-client`) — do NOT mark
the task done until the SDK is present in the artifact.

- [ ] **Step 2: Write the failing test**

```js
// apps/desktop/test/builder-config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("builder config ships the host bundle and the next standalone tree", async () => {
  const text = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(text, /appId: ss\.hx-engine\.com/);
  assert.match(text, /productName: Science Studio/);
  assert.match(text, /from: build\/host\s*\n\s*to: host/);
  assert.match(text, /from: \.\.\/web\/\.next\/standalone\s*\n\s*to: next/);
  assert.match(text, /to: next\/apps\/web\/\.next\/static/);
  assert.match(text, /to: next\/apps\/web\/public/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @science-studio/desktop -- --test-name-pattern="builder config"`
Expected: FAIL — `ENOENT electron-builder.yml` before Step 1, or assertion mismatch after a partial file.

- [ ] **Step 4: Wire the pack script and run it**

`apps/desktop/package.json` `scripts`:

```json
"pack": "npm run build && npm run build:desktop && electron-builder"
```

Run: `npm run pack -w @science-studio/desktop`
Expected: `apps/desktop/release/` contains a `.dmg` (macOS) or `.AppImage` + `.deb` (Linux), and `release/linux-unpacked/resources/host/host.mjs` + `resources/next/apps/web/server.js` exist.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w @science-studio/desktop`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron-builder.yml apps/desktop/test/builder-config.test.mjs apps/desktop/package.json
git commit -m "build(desktop): package with electron-builder"
```

---

### Task 13: Dev mode against the running dev servers

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/package.json`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `DESKTOP_DEV_URL`.
- Produces: `npm run dev:desktop` in the root, which loads `http://localhost:3000` without forking the host.

- [ ] **Step 1: Add the dev branch to main**

In `apps/desktop/src/main/index.ts`, replace the `openWorkbench` body's `boot()` call with a dev check:

```ts
async function openWorkbench(): Promise<void> {
  const devUrl = process.env.DESKTOP_DEV_URL;
  if (devUrl) {
    workbench = createWorkbenchWindow(devUrl);
    workbench.on("closed", () => {
      workbench = null;
    });
    return;
  }
  const ports = await boot();
  workbench = createWorkbenchWindow(`http://127.0.0.1:${ports.webPort}/`);
  workbench.on("closed", () => {
    workbench = null;
  });
}
```

Also skip the `detectDsh()` gate in dev (a dev may test the shell without dsh):

```ts
const missingConfig = (await readFile(paths().configPath, "utf8").catch(() => "")).length === 0;
if (!process.env.DESKTOP_DEV_URL && (missingConfig || !detectDsh())) {
  openSettings();
} else {
  await openWorkbench();
}
```

- [ ] **Step 2: Add the dev script**

`apps/desktop/package.json`:

```json
"dev": "npm run build && DESKTOP_DEV_URL=${DESKTOP_DEV_URL:-http://localhost:3000} electron ."
```

Root `package.json`:

```json
"dev:desktop": "DESKTOP_DEV_URL=${DESKTOP_DEV_URL:-http://localhost:3000} npm run dev -w @science-studio/desktop"
```

- [ ] **Step 3: Manual verification**

Run (two terminals): `npm run dev` then `npm run dev:desktop`.
Expected: Electron opens a window showing the running dev workbench at `localhost:3000`; no host child is forked.

- [ ] **Step 4: Update AGENTS.md**

In the `Structure` block, add after the `apps/web` entries:

```
apps/desktop                      Electron desktop app (docs/adr/0013). Main owns window/menu/lifecycle and forks `build/host/host.mjs` — one Node child that runs the transport-service (dsh runtime, plugins INJECTED into createBackend so the esbuild bundle needs no dynamic import) and spawns the Next standalone server as a grandchild, both loopback/ephemeral, reporting ports over IPC. The config window writes `<userData>/config.env` (DSH_PROVIDER/DSH_MODEL + credential vars), which main turns into the child env. Outside the root build gate; `apps/desktop` has its own build/test/pack scripts.
```

In `Commands`, add:

```
- `npm run dev:desktop` — the Electron shell against the already-running dev pair
  (`DESKTOP_DEV_URL`, default http://localhost:3000). The packaged app instead
  builds `apps/web` with `NEXT_OUTPUT=standalone` (`npm run build:web:standalone`)
  and hosts both servers itself. Packaging: `npm run pack -w @science-studio/desktop`
  (electron-builder; `dmg` on macOS, `AppImage`/`deb` on Linux). Dev-only claim:
  `dsh` must be on PATH and a route configured in Settings for a real turn.
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/package.json package.json AGENTS.md
git commit -m "feat(desktop): dev mode against the local dev servers, and document it"
```

---

## Self-Review

**Spec coverage** (against `docs/adr/0013` and the grilling decisions):

| Decision | Task |
| --- | --- |
| A1 distributable installer | Task 12 |
| A2 Linux + macOS, cross-platform config | Task 12 |
| B5 Next standalone, not static export | Task 9 |
| B6 one forked child hosts both servers | Task 8 |
| B7 loopback ephemeral + IPC | Task 5, 7, 8, 10 |
| C1 default dsh, user-configured route | Task 4, 10, 11 |
| C2 single-user only | Task 4 (`SS_ENTERPRISE_MODULE` deleted) |
| C3 data dirs | Task 3, 4 |
| D9 single window + menu + open folder | Task 10 |
| D10 no update/signing | Task 12 (no publish/sign config) |
| E11 `apps/desktop`, outside gate | Task 2, 13 |
| Q14 detect dsh, friendly setup | Task 6, 10, 11 |
| bundle id `ss.hx-engine.com` | Task 12 |
| esbuild bundle needs injected plugins | Task 1 |

**Deviation to flag to the user:** the "disable sending when `dsh` is missing" half of Q14 is implemented as a launch gate (settings window first) rather than a composer lock inside the Next app, because the latter would add a desktop-specific signal to `apps/web`. Composer-locking is deferred to a follow-up.

**Known risks the implementer must resolve empirically (Task 9/10/12):**
- The exact path of the Next standalone `server.js` under `outputFileTracingRoot` (Task 9 Step 3) — copy it verbatim into `nextDir()` and `extraResources`.
- esbuild bundling `@science-studio/transport-dsh` may surface a missing dependency or a `__dirname`/`import.meta` assumption; if so, add `--external:<pkg>` and ship that package under `extraResources`, keeping the plugin files next to the bundle.
- `electron-builder` may need `asarUnpack` if the host bundle or Next reads files it cannot read from an asar; the host and plugins already live in `extraResources`, so start without `asarUnpack`.

---

## Follow-ups (from the final review + recorded minors)

Tasks 14–17. Same process; `apps/desktop` stays outside the root build gate.
The `builder-config.test.mjs` target assertions (recorded as a Task 12 minor) are
already present, so no task is needed for them.

### Task 14: Runtime setup UX (P1)

**Why:** a missing `dsh` (or an empty config) currently opens only the Settings
window with no way to reach the workbench, and the web UI never says the runtime
is unavailable — the deferred half of the Q14 decision.

**Files:**
- Create: `apps/desktop/src/shared/runtime-status.ts`
- Create: `apps/desktop/src/preload/workbench.cts` (a sandboxed CJS preload: it
  may use only `contextBridge`/`ipcRenderer`)
- Modify: `apps/desktop/tsconfig.json` (add `src/**/*.cts` to `include`)
- Modify: `apps/desktop/src/main/windows.ts` (`createWorkbenchWindow` uses
  `workbench.cjs`; keep `sandbox: true`)
- Modify: `apps/desktop/src/main/index.ts` (IPC `desktop:runtimeStatus` and
  `desktop:openWorkbench`)
- Modify: `apps/desktop/src/renderer/config.ts` + `config.html` (dsh status +
  "Open workbench anyway")
- Modify: `apps/web/components/studio/status-bar.tsx` (a `RuntimeChip` shown only
  when the desktop bridge is present)
- Test: `apps/desktop/test/runtime-status.test.ts`

**Interfaces:**
- `runtimeStatus(input: { dshPath: string | null; config: DesktopConfig }): { dshPath: string | null; provider: string | null; model: string | null; ready: boolean }`, where `ready = dshPath !== null && provider !== null && model !== null`.
- `workbench.cts` exposes EXACTLY `runtimeStatus(): Promise<RuntimeStatus>` — no config write, no `openPath`.
- Main IPC: `desktop:runtimeStatus` → `runtimeStatus({ dshPath: detectDsh({ pathEnv: pathEnv() }), config: await readConfig() })`; `desktop:openWorkbench` → `await openWorkbench()` (boots the host and shows the workbench regardless of the gate).
- The web `RuntimeChip` reads `window.scienceStudioDesktop?.runtimeStatus` optionally; it renders "runtime: ready" / "runtime: dsh missing" with a popover (provider/model + hint). It does NOT disable the composer (deferred; document here).

**Steps:** TDD `runtimeStatus`; wire the preload/IPC; renderer status + button; web chip. `npm run test -w @science-studio/desktop` and `npm run build -w @science-studio/desktop`.

**Acceptance:** with no `dsh` on PATH the Settings window shows "dsh: missing" and
"Open workbench anyway" opens the workbench; the workbench's status bar shows the
runtime chip inside the desktop app and renders unchanged in a plain browser.

### Task 15: Packaging finish (P2)

**Files:**
- Modify: `apps/desktop/package.json` (add `"author"`)
- Modify: `apps/desktop/electron-builder.yml` (`deb.maintainer` real value)
- Create: `apps/web/public/.gitkeep` (so the `../web/public` mapping always resolves)

**Steps:** set `author` and `deb.maintainer` to
`zhonghua-wang <zhonghua.wang@outlook.com>`; create `apps/web/public/.gitkeep`;
re-pack; launch the packaged AppImage under the user's display with `--no-sandbox`
(the AppImage's chrome-sandbox cannot be setuid) and confirm the log has no
`[desktop] failed to load`, then ask the user to confirm visually.

**Acceptance:** `npm run pack -w @science-studio/desktop` exits 0 with no
"file source doesn't exist" and no "author is missed"; the launched AppImage
renders the workbench.

**Deferred:** an app icon (no image toolchain here and no asset in the repo) — the
default Electron icon ships until an asset is supplied.

### Task 16: Test/type-gate hardening (P3)

**Files:**
- Modify: `tsconfig.tests.json` (include `apps/desktop/test/**/*.ts`)
- Modify: `services/transport-service/test/injected-plugins.test.ts` (the empty-`[]` fallback case)
- Modify: `apps/desktop/test/config.test.ts` (seed `base.SS_ENTERPRISE_MODULE`; add an empty-config round-trip)

**Steps:** add `apps/desktop/test/**/*.ts` to the test program's `include`, then
run `npm run build` (which ends with `tsc -p tsconfig.tests.json`) and fix every
error it surfaces — including errors in the desktop `src` modules the tests pull
in; add the two test cases; re-run.

**Acceptance:** `npm run build` exits 0 with the desktop tests type-checked; the
new cases fail against the pre-change code and pass after (RED/GREEN evidence).

### Task 17: Renderer + detectDsh robustness, docs (P4/P5)

**Files:**
- Modify: `apps/desktop/src/renderer/config.ts` (build inputs with DOM `textContent`/`createElement`, not raw `innerHTML`; wrap `getConfig`/`detectDsh`/`setConfig` in try/catch and show a status/error line)
- Create: `apps/desktop/tsconfig.renderer.json` (lib `ES2022` + `DOM`, `src/renderer` only)
- Modify: `apps/desktop/tsconfig.json` (drop `DOM` from `lib`)
- Modify: `apps/desktop/package.json` (`build` runs both tsconfigs)
- Modify: `apps/desktop/src/shared/dsh.ts` (accept a `pathModule`/platform so `join`/`delimiter` are platform-correct; use `statSync(candidate).isFile()` instead of `access(X_OK)` so a directory named `dsh` is rejected)
- Modify: `apps/desktop/test/dsh.test.ts` (cover the directory case and win32 separators)
- Modify: root `package.json` (drop the redundant `${DESKTOP_DEV_URL:-…}` from `dev:desktop`; the workspace `dev` already defaults it)

**Acceptance:** `apps/desktop` build and tests pass; the renderer no longer
interpolates stored values into `innerHTML`; `detectDsh` rejects a directory and
honors an injected win32 platform; the root `dev:desktop` still reaches
localhost:3000 by default.

**Note (no change):** the Next port's `getFreePort` pre-pick remains inherently
racy (the API binds `0` directly; Next's `server.js` coerces `PORT=0` to 3000, so
it needs a real number) — recorded, not fixed.
