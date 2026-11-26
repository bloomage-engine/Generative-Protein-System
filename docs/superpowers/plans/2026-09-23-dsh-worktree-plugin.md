# dsh Worktree Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the dsh agent `worktree_list` / `worktree_create` / `worktree_remove` tools, a `/worktree` command, and a system-prompt section that names the worktree it is running in — all as a thin fetch of the service's `/api/worktrees*`.

**Architecture:** A fifth dependency-free cordis child plugin (`worktree-plugin.ts`) loaded by a per-launch profile patch, following `hpc-plugin.ts` exactly: no `@deepseek-ai/*` imports, never writes stdout, fails soft, inert without Project config. The adapter writes the patch and mounts it only for a real Project.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, cordis child-plugin API (`tools`, `systemPrompt`, `commands`), global `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-23-dsh-worktree-plugin-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-23-worktree-backend.md` (the `/api/worktrees*` routes must exist).

## Global Constraints

- Child-plugin rules (from `bridge-plugin.ts`): import NOTHING from `@deepseek-ai/*`; never write to stdout (it is the JSON-RPC wire — diagnostics go to stderr); `apply` fails soft.
- `name = "gps-worktree"`; `inject = ["commands", "tools", "systemPrompt"]`.
- The service base URL resolves `config.service ?? process.env.GPS_SERVICE_URL ?? "http://127.0.0.1:3001"`, trailing slashes stripped (same as `hpc-plugin.ts`).
- Prompt section order `470` (project is 450, hpc is 465).
- The agent CANNOT change its own cwd; the prompt must say so plainly.

## Review Focus

- **Unreachable/erroring service** → every tool returns a text result naming the failure, never throws (a throw would look like a broken tool).
- **A missing `worktree` config** (Project present, context absent) → the tools still register and the prompt omits the current-worktree line, rather than crashing.
- **`worktree_create` while already inside a worktree** → must create a sibling, never attempt to move the agent.
- **The plugin mounted without Project config** → fully inert (no tools, no section, no command).
- **Cold start** → `/worktree` appears in the menu before the child has ever run (curated fallback list).

---

### Task 1: `worktree-plugin.ts` child plugin

**Files:**
- Create: `packages/transport-dsh/src/worktree-plugin.ts`
- Test: `packages/transport-dsh/test/worktree-plugin.test.ts`

**Interfaces:**
- Consumes: the service's `/api/worktrees*` (plan 1).
- Produces (all exported): `name`, `inject`, `interface WorktreePluginConfig`, `interface WorktreeHost`, `interface WorktreeToolDefinition`, `interface WorktreePromptSection`, `interface WorktreeCommandDefinition`, `function apply(ctx: WorktreeHost, config: WorktreePluginConfig | undefined): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/transport-dsh/test/worktree-plugin.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apply,
  type WorktreeCommandDefinition,
  type WorktreeHost,
  type WorktreePromptSection,
  type WorktreeToolDefinition,
} from "../src/worktree-plugin.js";

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };
const WT = { id: "exp-a", name: "Experiment A", branch: "exp-a", root: "/w/.worktrees/exp-a" };

function fakeHost() {
  const tools: WorktreeToolDefinition[] = [];
  const sections: WorktreePromptSection[] = [];
  const commands: WorktreeCommandDefinition[] = [];
  const ctx: WorktreeHost = {
    tools: { register: (d) => { tools.push(d); return () => {}; } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    commands: { register: (c) => { commands.push(c); return () => {}; } },
    effect: (body) => { body(); },
  };
  return {
    ctx,
    tools: () => tools,
    sections: () => sections,
    commands: () => commands,
  };
}

function tool(host: ReturnType<typeof fakeHost>, name: string): WorktreeToolDefinition {
  const found = host.tools().find((entry) => entry.name === name);
  assert.ok(found, `tool ${name} is registered`);
  return found;
}

interface CalledRequest { url: string; method?: string; body?: Record<string, unknown>; }

function stubFetch(handler: (req: CalledRequest) => { status: number; json: unknown }) {
  const calls: CalledRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const req: CalledRequest = {
      url: String(input),
      ...(init?.method ? { method: init.method } : {}),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    };
    calls.push(req);
    const res = handler(req);
    return new Response(JSON.stringify(res.json), { status: res.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("a project config registers the three tools, the command and the prompt section", () => {
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://127.0.0.1:9" });
  assert.deepEqual(host.tools().map((t) => t.name).sort(), [
    "worktree_create",
    "worktree_list",
    "worktree_remove",
  ]);
  assert.deepEqual(host.commands().map((c) => c.name), ["worktree"]);
  assert.deepEqual(host.sections().map((s) => s.name), ["gps-worktree"]);
  assert.equal(host.sections()[0]?.order, 470);
});

test("without Project config the plugin is inert", () => {
  const host = fakeHost();
  apply(host.ctx, {});
  assert.equal(host.tools().length, 0);
  assert.equal(host.sections().length, 0);
  assert.equal(host.commands().length, 0);
});

test("the prompt names the current worktree and its branch", () => {
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc" });
  const text = host.sections()[0]?.text ?? "";
  assert.match(text, /Experiment A/);
  assert.match(text, /exp-a/);
  assert.match(text, /无法切换|cannot switch/i);
});

test("worktree_list marks the current worktree", async () => {
  const stub = stubFetch(() => ({
    status: 200,
    json: { worktrees: [
      { id: "main", name: "main", branch: "main" },
      { id: "exp-a", name: "Experiment A", branch: "exp-a" },
    ] },
  }));
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc:3001/" });
  try {
    const text = String(await tool(host, "worktree_list").execute({}, {}));
    assert.match(text, /Experiment A/);
    assert.match(text, /当前/);
    assert.ok(stub.calls[0]?.url.startsWith("http://svc:3001/api/worktrees?projectId=drought-screen"));
  } finally {
    stub.restore();
  }
});

test("worktree_create POSTs name/branch and reports the new row", async () => {
  const stub = stubFetch(() => ({
    status: 201,
    json: { worktree: { id: "exp-b", name: "Experiment B", branch: "exp-b" } },
  }));
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc" });
  try {
    const text = String(await tool(host, "worktree_create").execute({ name: "Experiment B" }, {}));
    assert.match(text, /Experiment B/);
    assert.equal(stub.calls[0]?.method, "POST");
    assert.equal(stub.calls[0]?.body?.name, "Experiment B");
  } finally {
    stub.restore();
  }
});

test("worktree_remove validates the id and relays the service error", async () => {
  const stub = stubFetch(() => ({ status: 409, json: { error: "branch is already checked out" } }));
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc" });
  try {
    const invalid = String(await tool(host, "worktree_remove").execute({ worktree: "bad id!" }, {}));
    assert.match(invalid, /参数无效/);
    const text = String(await tool(host, "worktree_remove").execute({ worktree: "exp-b" }, {}));
    assert.match(text, /already checked out/);
  } finally {
    stub.restore();
  }
});

test("an unreachable service is a tool result, never a throw", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc" });
  try {
    const text = String(await tool(host, "worktree_list").execute({}, {}));
    assert.match(text, /无法连接/);
  } finally {
    globalThis.fetch = original;
  }
});

test("/worktree lists worktrees through the same fetch", async () => {
  const stub = stubFetch(() => ({ status: 200, json: { worktrees: [{ id: "main", name: "main", branch: "main" }] } }));
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc" });
  try {
    const result = await host.commands()[0]!.handler({ agent: null, rawInput: "/worktree", signal: new AbortController().signal });
    assert.equal(result.kind, "success");
    assert.match(result.text, /main/);
  } finally {
    stub.restore();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test packages/transport-dsh/test/worktree-plugin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the plugin**

Create `packages/transport-dsh/src/worktree-plugin.ts`, mirroring `hpc-plugin.ts`'s structure and fail-soft style:

- Header comment: a thin fetch channel; the service owns git (docs/adr/0025); inert without Project; no `@deepseek-ai/*` imports; no stdout.
- Exports: `name = "gps-worktree"`, `inject = ["commands", "tools", "systemPrompt"]`.
- `DEFAULT_SERVICE = "http://127.0.0.1:3001"`, `READ_TIMEOUT_MS = 15_000`, `WRITE_TIMEOUT_MS = 30_000`.
- `WorktreePluginConfig { project?: { id: string; name?: string; createdAt?: string }; worktree?: { id: string; name: string; branch: string; root: string }; service?: string }`.
- `WorktreeHost { tools?: { register(d: WorktreeToolDefinition): () => void }; systemPrompt?: { section(s: WorktreePromptSection): () => void }; commands?: { register(d: WorktreeCommandDefinition): () => void }; effect?(body: () => () => void, label?: string): unknown }`.
- `WorktreeToolDefinition` with the same fields hpc uses (`name`, `description`, `parameters`, `output`, `execute`).
- `WorktreeCommandDefinition { name: string; description: string; handler: (invocation: { agent: unknown; rawInput: string; signal: AbortSignal }) => { kind: "success" | "error"; text: string } | Promise<{ kind: "success" | "error"; text: string }> }`.
- `warn(message, detail)` → `process.stderr.write(\`[dsh worktree] ...\`)`.
- `callService(service, projectId, method, path, body?, timeoutMs?)` — copy the hpc-plugin implementation verbatim (the `projectId` query, JSON parse, non-2xx relays `data.error`, network failure returns `无法连接…`).
- `describeWorktree(w, currentId)` → `` `- ${w.name}（分支 ${w.branch}）${w.id === currentId ? " ⟵ 当前" : ""}` ``.
- `listWorktrees(service, projectId)` → `callService(..., "GET", "/api/worktrees")` then read `data.worktrees`.
- Tools:
  - `worktree_list`: description "列出本项目的 worktree（git 分支）及其当前所在。" — render the list, marking `config.worktree?.id`; empty → "本项目只有默认 worktree main。"
  - `worktree_create`: parameters `{ name (required), branch?, base? }`; POST `/api/worktrees` with those fields (omit empty branch/base); on success render the created row; description must state it does NOT change the agent's own working directory.
  - `worktree_remove`: parameters `{ worktree (required) }`; validate with `/^[a-z0-9][a-z0-9-]*$/` (else "参数无效：worktree 应为 slug 形式的 id。"); POST `/api/worktrees/${encodeURIComponent(id)}/delete`; success → "已删除 worktree …". Description warns it deletes the branch's sessions too.
- Prompt section `{ name: "gps-worktree", order: 470, text: [...] }`, text lines:
  - `你当前在 worktree「${worktree.name}」（分支 ${worktree.branch}），根路径 ${worktree.root}。`
  - `同一项目的其他 worktree 是同一 git 仓库的独立 checkout，位于 .worktrees/ 下，各自拥有一组会话。`
  - `你可以用 worktree_list / worktree_create / worktree_remove 查看与增删 worktree，但无法切换自己的工作目录——要换到别的 worktree，请在 Generative Protein System 界面上打开那个 worktree。`
  - When `config.worktree` is absent, omit the first line and use a generic phrasing.
- `/worktree` command `{ name: "worktree", description: "列出本项目的 worktree 分支", handler: async () => ... }` — fetch and render, returning `{ kind: "success", text }` (or `{ kind: "error", text }` on failure).
- Registration: the same `disposers`/`tryRegister`/`effect` shape as `hpc-plugin.ts` (`apply` fails soft).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test packages/transport-dsh/test/worktree-plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-dsh/src/worktree-plugin.ts packages/transport-dsh/test/worktree-plugin.test.ts
git commit -m "feat(dsh): worktree tools, /worktree command and prompt section"
```

---

### Task 2: `writeWorktreePatch`

**Files:**
- Modify: `packages/transport-dsh/src/bridge.ts`
- Test: `packages/transport-dsh/test/worktree-launch.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface WorktreePluginLaunchConfig { project: { id: string; name: string; createdAt: string }; worktree?: { id: string; name: string; branch: string; root: string }; service?: string }`
  - `writeWorktreePatch(opts: { dir: string; pluginPath: string; config: WorktreePluginLaunchConfig }): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `packages/transport-dsh/test/worktree-launch.test.ts` (patch-writer half; the adapter half is Task 3):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWorktreePatch } from "../src/bridge.js";

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };
const WT = { id: "exp-a", name: "Experiment A", branch: "exp-a", root: "/w/.worktrees/exp-a" };

test("writeWorktreePatch inserts the plugin by file URL with a JSON config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-worktree-launch-"));
  try {
    const file = await writeWorktreePatch({
      dir,
      pluginPath: "/opt/ss/worktree-plugin.js",
      config: { project: META, worktree: WT, service: "http://127.0.0.1:3123" },
    });
    const patch = await readFile(file, "utf8");
    assert.match(patch, /- insert:/);
    assert.match(patch, /id: gps-worktree/);
    assert.match(patch, /worktree-plugin\.js/);
    assert.match(patch, /"worktree":\{"id":"exp-a"/);
    assert.match(patch, /"service":"http:\/\/127\.0\.0\.1:3123"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test packages/transport-dsh/test/worktree-launch.test.ts`
Expected: FAIL — `writeWorktreePatch` is not exported.

- [ ] **Step 3: Implement**

In `packages/transport-dsh/src/bridge.ts`, after `writeHpcPatch`, add `WorktreePluginLaunchConfig` and `writeWorktreePatch` by copying `writeHpcPatch`'s body and changing: the filename prefix (`worktree-${randomUUID().slice(0, 8)}.cordis.patch.yml`) and the patch id (`gps-worktree`). Keep the `file:` URL name and the single JSON `config` node.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test packages/transport-dsh/test/worktree-launch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-dsh/src/bridge.ts packages/transport-dsh/test/worktree-launch.test.ts
git commit -m "feat(dsh): writeWorktreePatch launch artifact"
```

---

### Task 3: Adapter mounts the worktree plugin

**Files:**
- Modify: `packages/transport-dsh/src/adapter.ts`
- Test: `packages/transport-dsh/test/worktree-launch.test.ts` (extend with the adapter assertion)

**Interfaces:**
- Consumes: `writeWorktreePatch` (Task 2), `WorktreeContext` from `@gps/transport`.
- Produces: `DshRuntimeAdapterOptions.worktreePluginPath?: string`; the adapter writes the worktree patch whenever `opts.project` exists.

- [ ] **Step 1: Write the failing test**

Append to `worktree-launch.test.ts`:

```ts
import { DshRuntimeAdapter } from "../src/adapter.js";
import type { DshClientLaunchOptions, DshTurnClient } from "../src/client.js";

const noRecordStore = { addRun: async () => {} };

async function mountedPatches(opts: {
  project?: { id: string; name: string; createdAt: string };
  worktree?: { id: string; name: string; branch: string; root: string };
}): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-worktree-mount-"));
  let seen: DshClientLaunchOptions | undefined;
  const adapter = new DshRuntimeAdapter({
    createClient: (options): DshTurnClient => { seen = options; return { start: async () => {}, close: async () => {}, runTurn: async () => {} }; },
    bridgeDir: dir,
    bridgePluginPath: "/opt/ss/bridge-plugin.js",
    worktreePluginPath: "/opt/ss/worktree-plugin.js",
  });
  await adapter.init({
    binding: { runtime: "dsh", config: {} },
    recordStore: noRecordStore,
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.worktree ? { worktree: opts.worktree } : {}),
  });
  const files = seen?.patches ?? [];
  return Promise.all(files.map((file) => readFile(file, "utf8")));
}

test("the adapter mounts the worktree plugin for a real project", async () => {
  const patches = await mountedPatches({ project: META, worktree: WT });
  assert.ok(patches.some((p) => /gps-worktree/.test(p)));
  assert.ok(patches.some((p) => /"worktree":\{"id":"exp-a"/.test(p)));
});

test("without a project the worktree plugin is not mounted", async () => {
  const patches = await mountedPatches({});
  assert.ok(!patches.some((p) => /gps-worktree/.test(p)));
});
```

Add the needed imports at the top of the file if not already present (`mkdtemp`, `join`, `tmpdir`, `readFile`, `rm` are from Task 2's test; merge the imports).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test packages/transport-dsh/test/worktree-launch.test.ts`
Expected: FAIL — the adapter has no `worktreePluginPath` option and mounts no worktree patch.

- [ ] **Step 3: Implement**

In `packages/transport-dsh/src/adapter.ts`:
- Add to `DshRuntimeAdapterOptions`, after `hpcPluginPath`:

```ts
  /**
   * The child-side worktree plugin this adapter's launch patch mounts — the
   * `worktree_*` tools, `/worktree` and the prompt section (docs/adr/0025).
   * Defaults to this package's own build output.
   */
  worktreePluginPath?: string;
```

- Add a private field `private readonly worktreePluginPath: string;` and in the constructor:

```ts
    this.worktreePluginPath =
      options.worktreePluginPath ?? fileURLToPath(new URL("./worktree-plugin.js", import.meta.url));
```

- Import `writeWorktreePatch` from `./bridge.js`.
- After the HPC patch block in `initialize`, add:

```ts
    // The worktree plugin rides a FIFTH launch patch (docs/adr/0025): the
    // `worktree_*` tools, `/worktree` and a prompt section naming the worktree.
    // A thin channel to the service's `/api/worktrees*` (the service owns git),
    // so its config carries the Project identity, the worktree context the
    // service passed in, and the service base URL when the launch env declared
    // one.
    if (opts.project) {
      try {
        const service = process.env.GPS_SERVICE_URL;
        patches.push(
          await writeWorktreePatch({
            dir: this.bridgeDir,
            pluginPath: this.worktreePluginPath,
            config: {
              project: opts.project,
              ...(opts.worktree ? { worktree: opts.worktree } : {}),
              ...(service ? { service } : {}),
            },
          }),
        );
      } catch (err) {
        console.warn("[dsh] worktree plugin unavailable", err);
      }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test packages/transport-dsh/test/worktree-launch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-dsh/src/adapter.ts packages/transport-dsh/test/worktree-launch.test.ts
git commit -m "feat(dsh): mount the worktree plugin for a real project"
```

---

### Task 4: Curate `/worktree` into the cold menu

**Files:**
- Modify: `packages/transport-dsh/src/commands.ts`
- Test: `packages/transport-dsh/test/commands.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: a `/worktree` `CommandDescriptor` in `DSH_HARNESS_FALLBACK_DESCRIPTORS`.

- [ ] **Step 1: Write the failing test**

Append to `packages/transport-dsh/test/commands.test.ts`:

```ts
test("the cold fallback catalog carries the worktree command", () => {
  const ids = DSH_HARNESS_FALLBACK_DESCRIPTORS.map((d) => d.id);
  assert.ok(ids.includes("worktree"), "the cold menu should offer /worktree");
});
```

(Ensure `DSH_HARNESS_FALLBACK_DESCRIPTORS` is imported at the top of that test file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test packages/transport-dsh/test/commands.test.ts`
Expected: FAIL — `worktree` is not in the list.

- [ ] **Step 3: Implement**

In `packages/transport-dsh/src/commands.ts`, add to `DSH_HARNESS_FALLBACK_DESCRIPTORS` after the `cron` entry:

```ts
  // This package's own worktree plugin registers `/worktree` in the harness
  // registry (like `/project` and `/cron`), listed here for the same cold-menu
  // reason: a cold child cannot be asked for it.
  {
    id: "worktree",
    label: "/worktree",
    description: "列出本项目的 worktree 分支",
    invocationText: "/worktree",
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test packages/transport-dsh/test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-dsh/src/commands.ts packages/transport-dsh/test/commands.test.ts
git commit -m "feat(dsh): curate /worktree into the cold command menu"
```

---

### Task 5: Plugin package docs and full verification

**Files:**
- Modify: `AGENTS.md` (the `packages/transport-dsh` bullet)

**Interfaces:** none.

- [ ] **Step 1: Describe the plugin in `AGENTS.md`**

In the `packages/transport-dsh` paragraph, add a sentence naming the FIFTH dependency-free child plugin: it registers the `worktree_*` tools, `/worktree` (curated into the cold menu) and a `systemPrompt` section naming the active worktree; every tool merely fetches the service's `/api/worktrees*` (the service owns git), it is mounted only for a real Project, and it cannot change the agent's cwd.

- [ ] **Step 2: Run the package tests**

Run: `npm run test -w @gps/transport-dsh`
Expected: PASS.

- [ ] **Step 3: Run the root build gate**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: describe the dsh worktree plugin"
```

---

## Plan complete — what ships

After Task 5, a dsh agent in any real Project has `worktree_list` / `worktree_create` / `worktree_remove`, a `/worktree` slash command (present from the cold menu), and a system prompt that names the worktree it runs in and states it cannot switch its own cwd. The workbench UI is the final plan.
