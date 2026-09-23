# Worktree Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `Worktree` record entity and generalize the runtime/workspace scope from `projectId` to `(projectId, worktreeId)`, with a service-owned git surface at `/api/worktrees*`.

**Architecture:** A `Worktree` is a record row (`main` auto-ensured). The environment seam is keyed by `(projectId, worktreeId)` so each worktree gets its own `FsWorkspace` rooted at `<PROJECT_ROOT>/<projectId>/.worktrees/<id>/`. The service spawns the system `git` binary (mirroring the HPC SSH client) behind `/api/worktrees*` routes; it is the only writer of both git and the record row.

**Tech Stack:** TypeScript, Node `node:test` + `node:assert/strict`, Fastify, `@science-studio/{record,transport,workspace}`, `node:child_process`.

**Spec:** `docs/superpowers/specs/2026-09-23-dsh-worktree-plugin-design.md`

## Global Constraints

- **Plan order:** this is plan 1 of 3. The dsh plugin plan and the workbench plan depend on it; do not start them first.
- **Deliberate deviation from the spec:** the spec says `Session.worktreeId: Id` is required. This plan makes it **optional** (`worktreeId?: Id`) with `DEFAULT_WORKTREE_ID = "main"` and a `sessionWorktreeId()` normalizer. Semantics are identical (absent = `main`, legacy rows read as `main`) but no existing test fixture or adapter must change. Flagged for the spec reviewer.
- **No git library.** The service spawns the system `git` binary; the `GIT_BINARY` env var overrides the default `git` on PATH.
- **Path convention, derived not stored:** `worktreeRelPath("main") === ""`, else `.worktrees/<id>` (POSIX).
- **Gitignore entries** for a new repository: `.worktrees/` and `.science-studio/`.
- **Initial commit identity is local, never global:** `-c user.name=Science Studio -c user.email=science-studio@localhost`.
- **Ids:** a Worktree id is the slug of its name, unique within the Project, suffixed on collision; `main` is reserved.
- **Compatibility:** a request that claims no worktree resolves to `main`, so every existing project-level route keeps working.
- **Root build gate:** each task ends green under the package's own test command; the final task runs `npm run build` (the real type gate).

## Review Focus

- **A claimed but unknown `worktreeId`** → the request must fail 404/400, never silently fall back to `main` (a typo must not run in the wrong directory).
- **A branch another worktree already holds** → `git worktree add -b` fails; must surface as 409, not 502, and must leave no record row.
- **A failed record write after a successful `git worktree add`** → the orphaned checkout must be rolled back so git and the record cannot drift.
- **A Project whose workspace is not yet a repository** → listing worktrees must NOT create a repository; only creating one may.
- **Legacy persisted Sessions with no `worktreeId`** → must list and resolve under `main`.
- **A `main` worktree rename/archive/delete** → must be refused 403.

---

### Task 1: `Worktree` record type and in-memory store

**Files:**
- Modify: `packages/record/src/types.ts`
- Create: `packages/record/src/worktree.ts`
- Modify: `packages/record/src/index.ts`
- Modify: `packages/record/src/memory.ts`
- Test: `packages/record/test/worktree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Worktree { id: Id; projectId: Id; name: string; branch: string; createdAt: string; archivedAt?: string }`
  - `const DEFAULT_WORKTREE_ID = "main"; const MAIN_BRANCH = "main"`
  - `function sessionWorktreeId(session: Session): Id` (returns `session.worktreeId ?? DEFAULT_WORKTREE_ID`)
  - `Session.worktreeId?: Id`
  - `RecordStore` methods:
    `addWorktree(worktree: Worktree): Promise<Worktree>`,
    `getWorktree(id: Id): Promise<Worktree | null>`,
    `listWorktrees(projectId: Id, opts?: { includeArchived?: boolean }): Promise<Worktree[]>`,
    `updateWorktree(id: Id, patch: { name: string }): Promise<Worktree>`,
    `archiveWorktree(id: Id, archivedAt: string): Promise<Worktree>`,
    `unarchiveWorktree(id: Id): Promise<Worktree>`,
    `deleteWorktree(id: Id): Promise<void>`

- [ ] **Step 1: Add the type and the normalizer**

In `packages/record/src/types.ts`, add after the `Project` interface:

```ts
/**
 * A git worktree of a Project's repository: an isolated checkout on its own
 * branch. The Project root IS the `main` worktree; linked worktrees are nested
 * under `.worktrees/` (docs/adr/0025). `id` is a stable slug unique within the
 * Project and `main` is reserved; `name` is the only mutable field. The on-disk
 * path is DERIVED from the id, never stored.
 */
export interface Worktree {
  id: Id;
  projectId: Id;
  /** Display name — the only mutable field. */
  name: string;
  /** The git branch this worktree checks out (stored: it cannot be derived from `id`). */
  branch: string;
  createdAt: string;
  /** Set when the Worktree is archived — hidden from the default listing, never deleted. */
  archivedAt?: string;
}
```

Add to `Session` (after `projectId`):

```ts
  /**
   * The Worktree this Session runs in. Absent means the `main` worktree — a
   * legacy row written before worktrees existed (normalize with
   * `sessionWorktreeId`).
   */
  worktreeId?: Id;
```

Create `packages/record/src/worktree.ts`:

```ts
import type { Id, Session } from "./types.js";

/** The auto-ensured default worktree (its path IS the Project root). */
export const DEFAULT_WORKTREE_ID: Id = "main";
/** The default branch a `main` worktree checks out. */
export const MAIN_BRANCH = "main";

/** The worktree a Session belongs to; a legacy row with none is `main`. */
export function sessionWorktreeId(session: Session): Id {
  return session.worktreeId ?? DEFAULT_WORKTREE_ID;
}
```

- [ ] **Step 2: Export the type, constants and normalizer from the package surface**

In `packages/record/src/index.ts`, add `Worktree` to the `import type` block and to the `export type { ... } from "./types.js"` block, then add:

```ts
export { DEFAULT_WORKTREE_ID, MAIN_BRANCH, sessionWorktreeId } from "./worktree.js";
```

Add the Worktree methods to the `RecordStore` interface (after `listProjects`, before the Session methods):

```ts
  addWorktree(worktree: Worktree): Promise<Worktree>;
  getWorktree(id: Id): Promise<Worktree | null>;
  /** A Project's Worktrees, insertion order. Archived worktrees excluded unless asked for. */
  listWorktrees(projectId: Id, opts?: { includeArchived?: boolean }): Promise<Worktree[]>;
  /** Rename a Worktree (its id and branch are immutable). Returns the updated row. */
  updateWorktree(id: Id, patch: { name: string }): Promise<Worktree>;
  /** Mark a Worktree archived; returns the updated row. */
  archiveWorktree(id: Id, archivedAt: string): Promise<Worktree>;
  /** Clear a Worktree's archived flag; returns the updated row. */
  unarchiveWorktree(id: Id): Promise<Worktree>;
  /** Remove a Worktree and every Session/Run under it. */
  deleteWorktree(id: Id): Promise<void>;
```

- [ ] **Step 3: Write the failing shared-contract test**

Create `packages/record/test/worktree.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WORKTREE_ID,
  createInMemoryRecordStore,
  createJsonlRecordStore,
  sessionWorktreeId,
  type Project,
  type RecordStore,
  type Run,
  type Session,
  type Worktree,
} from "../src/index.js";

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "Metabolism",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const worktree = (over: Partial<Worktree> = {}): Worktree => ({
  id: "main",
  projectId: "p1",
  name: "main",
  branch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  projectId: "p1",
  agentId: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  sessionId: "s1",
  projectId: "p1",
  status: "completed",
  agentId: "main",
  parameters: {},
  input: "hi",
  ...over,
});

async function bothStores(runFn: (make: () => Promise<RecordStore>) => Promise<void>): Promise<void> {
  await runFn(async () => createInMemoryRecordStore());
  const dir = await mkdtemp(join(tmpdir(), "ss-record-worktree-"));
  try {
    await runFn(async () => createJsonlRecordStore(join(dir, "record.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("worktrees satisfy the RecordStore contract in both stores", async () => {
  await bothStores(async (make) => {
    const store = await make();
    await store.createProject(project());
    await store.addWorktree(worktree());
    await store.addWorktree(worktree({ id: "exp-a", name: "Experiment A", branch: "exp/a" }));

    assert.deepEqual(
      (await store.listWorktrees("p1")).map((w) => w.id),
      ["main", "exp-a"],
    );
    assert.equal((await store.getWorktree("exp-a"))?.branch, "exp/a");
    assert.equal(await store.getWorktree("missing"), null);

    await store.archiveWorktree("exp-a", "2026-02-01T00:00:00.000Z");
    assert.deepEqual(
      (await store.listWorktrees("p1")).map((w) => w.id),
      ["main"],
    );
    assert.deepEqual(
      (await store.listWorktrees("p1", { includeArchived: true })).map((w) => w.id),
      ["main", "exp-a"],
    );
    await store.unarchiveWorktree("exp-a");
    assert.equal((await store.getWorktree("exp-a"))?.archivedAt, undefined);

    await store.updateWorktree("exp-a", { name: "Renamed" });
    assert.equal((await store.getWorktree("exp-a"))?.name, "Renamed");

    // Rows are copies.
    const fetched = (await store.listWorktrees("p1"))[0]!;
    fetched.name = "mutated";
    assert.equal((await store.getWorktree("main"))?.name, "main");
  });
});

test("deleting a worktree cascades its sessions and runs", async () => {
  await bothStores(async (make) => {
    const store = await make();
    await store.createProject(project());
    await store.addWorktree(worktree());
    await store.addWorktree(worktree({ id: "exp-a", name: "Experiment A", branch: "exp/a" }));
    await store.addSession(session({ id: "s1", worktreeId: "exp-a" }));
    await store.addSession(session({ id: "s2", worktreeId: "main" }));
    await store.addRun(run({ id: "r1", sessionId: "s1" }));
    await store.addRun(run({ id: "r2", sessionId: "s2" }));

    await store.deleteWorktree("exp-a");
    assert.equal(await store.getWorktree("exp-a"), null);
    assert.equal(await store.getSession("s1"), null);
    assert.equal((await store.getSession("s2"))?.id, "s2");
    assert.deepEqual(
      (await store.listRuns("p1")).map((r) => r.id),
      ["r2"],
    );
  });
});

test("deleting a project cascades its worktrees", async () => {
  await bothStores(async (make) => {
    const store = await make();
    await store.createProject(project());
    await store.addWorktree(worktree({ id: "exp-a", name: "Experiment A", branch: "exp/a" }));
    await store.deleteProject("p1");
    assert.deepEqual(await store.listWorktrees("p1", { includeArchived: true }), []);
  });
});

test("sessionWorktreeId defaults a legacy session to main", () => {
  assert.equal(sessionWorktreeId(session()), DEFAULT_WORKTREE_ID);
  assert.equal(sessionWorktreeId(session({ worktreeId: "exp-a" })), "exp-a");
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm run test -w @science-studio/record`
Expected: FAIL — the worktree methods are not on the store / exports are missing.

- [ ] **Step 5: Implement the in-memory store methods**

In `packages/record/src/memory.ts`, import `Worktree`, add `const worktrees = new Map<Id, Worktree>();`, and add methods mirroring the Project ones:

```ts
    async addWorktree(worktree: Worktree): Promise<Worktree> {
      worktrees.set(worktree.id, clone(worktree));
      return clone(worktree);
    },
    async getWorktree(id: Id): Promise<Worktree | null> {
      const w = worktrees.get(id);
      return w ? clone(w) : null;
    },
    async listWorktrees(
      projectId: Id,
      opts: { includeArchived?: boolean } = {},
    ): Promise<Worktree[]> {
      return ordered(
        worktrees,
        (w) => w.projectId === projectId && (opts.includeArchived === true || w.archivedAt === undefined),
      );
    },
    async updateWorktree(id: Id, patch: { name: string }): Promise<Worktree> {
      const prev = worktrees.get(id);
      if (!prev) throw new Error(`worktree not found: ${id}`);
      const next = { ...prev, name: patch.name };
      worktrees.set(id, clone(next));
      return clone(next);
    },
    async archiveWorktree(id: Id, archivedAt: string): Promise<Worktree> {
      const prev = worktrees.get(id);
      if (!prev) throw new Error(`worktree not found: ${id}`);
      const next = { ...prev, archivedAt };
      worktrees.set(id, clone(next));
      return clone(next);
    },
    async unarchiveWorktree(id: Id): Promise<Worktree> {
      const prev = worktrees.get(id);
      if (!prev) throw new Error(`worktree not found: ${id}`);
      const { archivedAt: _dropped, ...rest } = prev;
      worktrees.set(id, clone(rest));
      return clone(rest);
    },
    async deleteWorktree(id: Id): Promise<void> {
      worktrees.delete(id);
      const removed = new Set<Id>();
      for (const session of [...sessions.values()]) {
        if (session.worktreeId === id) {
          sessions.delete(session.id);
          transcripts.delete(session.id);
          removed.add(session.id);
        }
      }
      for (const run of [...runs.values()]) {
        if (removed.has(run.sessionId)) runs.delete(run.id);
      }
      for (const sub of [...subagents.values()]) {
        if (removed.has(sub.parentSessionId)) subagents.delete(sub.id);
      }
    },
```

In the existing `deleteProject`, add `worktrees.delete` for the project's rows:

```ts
      for (const w of [...worktrees.values()]) {
        if (w.projectId === id) worktrees.delete(w.id);
      }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -w @science-studio/record`
Expected: PASS for the in-memory half; the JSONL half still fails until Task 2 — that is fine, proceed.

- [ ] **Step 7: Commit**

```bash
git add packages/record/src/types.ts packages/record/src/worktree.ts packages/record/src/index.ts packages/record/src/memory.ts packages/record/test/worktree.test.ts
git commit -m "feat(record): Worktree entity and in-memory store support"
```

---

### Task 2: JSONL store support and legacy Session normalization

**Files:**
- Modify: `packages/record/src/jsonl.ts`
- Test: `packages/record/test/worktree.test.ts` (same file, both stores)

**Interfaces:**
- Consumes: Task 1's types and methods.
- Produces: the same `RecordStore` surface, durable on disk.

- [ ] **Step 1: Extend the JSONL row union and tables**

In `packages/record/src/jsonl.ts`:
- Add `Worktree` to the type import.
- Add `{ t: "worktree"; v: Worktree }` to the `Row` union and `"worktree"` to the `drop` table union.
- Add `worktrees: Map<Id, Worktree>` to `Tables`.
- In `apply()` add `case "worktree": tables.worktrees.set(row.v.id, row.v); break;` and `else if (row.table === "worktree") tables.worktrees.delete(row.id);`.
- In `parseLine()`'s guard add `parsed.t === "worktree"`.
- In `compact()` add `...[...tables.worktrees.values()].map((v): Row => ({ t: "worktree", v })),`.
- Extend `drop(table, id)`'s parameter type to include `"worktree"`.

- [ ] **Step 2: Normalize a legacy Session on decode**

In `apply()`, replace the session case so a missing `worktreeId` becomes `main`:

```ts
    case "session": {
      const session = row.v.worktreeId === undefined ? { ...row.v, worktreeId: "main" } : row.v;
      tables.sessions.set(session.id, session);
      break;
    }
```

- [ ] **Step 3: Add the JSONL Worktree methods**

Add `worktrees` to the `Tables` initializer, and implement the seven methods mirroring the Project methods, using `append({ t: "worktree", v })` and `drop("worktree", id)`. The cascade for `deleteWorktree` must reuse the existing per-session durable removal:

```ts
    async deleteWorktree(id: Id): Promise<void> {
      const removed = new Set<Id>();
      for (const session of [...tables.sessions.values()]) {
        if (session.worktreeId === id) {
          await drop("session", session.id);
          tables.sessions.delete(session.id);
          await removeSessionDurable(session.id);
          removed.add(session.id);
        }
      }
      for (const run of [...tables.runs.values()]) {
        if (removed.has(run.sessionId)) {
          await drop("run", run.id);
          tables.runs.delete(run.id);
        }
      }
      await drop("worktree", id);
      tables.worktrees.delete(id);
    },
```

and add to the existing `deleteProject` cascade:

```ts
      for (const worktree of [...tables.worktrees.values()]) {
        if (worktree.projectId === id) {
          await drop("worktree", worktree.id);
          tables.worktrees.delete(worktree.id);
        }
      }
```

- [ ] **Step 4: Run the test to verify it passes in both stores**

Run: `npm run test -w @science-studio/record`
Expected: PASS — all `worktree.test.ts` cases green in both stores.

- [ ] **Step 5: Commit**

```bash
git add packages/record/src/jsonl.ts
git commit -m "feat(record): durable Worktree rows and legacy session normalization"
```

---

### Task 3: `RecordDirectory` worktree lifecycle

**Files:**
- Modify: `services/transport-service/src/directory.ts`
- Test: `services/transport-service/test/directory-worktree.test.ts`

**Interfaces:**
- Consumes: `RecordStore` worktree methods, `DEFAULT_WORKTREE_ID`/`MAIN_BRANCH`.
- Produces, on `RecordDirectory`:
  - `ensureWorktree(projectId: Id): Promise<Worktree>` — ensures the `main` row (id `main`, name `main`, branch `main`), returns it.
  - `findWorktree(projectId: Id, id: Id): Promise<Worktree | null>`
  - `requireWorktree(projectId: Id, id: Id): Promise<Worktree>` — throws `WorktreeNotFoundError`.
  - `mintWorktreeId(projectId: Id, name: string): Promise<Id>`
  - `addWorktree(projectId: Id, input: { id: Id; name: string; branch: string }): Promise<Worktree>`
  - `listWorktrees(projectId: Id, opts?): Promise<Worktree[]>`
  - `renameWorktree(id: Id, name: string): Promise<Worktree>`
  - `archiveWorktree(id: Id): Promise<Worktree>` / `unarchiveWorktree(id: Id): Promise<Worktree>`
  - `deleteWorktree(id: Id): Promise<void>`
  - `class WorktreeNotFoundError extends Error` (name `WorktreeNotFoundError`)
  - `createSession(projectId, { agentId?, title?, worktreeId? })` and
    `resolveOrCreateSession(projectId, sessionKey, worktreeId?)`

- [ ] **Step 1: Write the failing test**

Create `services/transport-service/test/directory-worktree.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore } from "@science-studio/record";
import { createRecordDirectory, WorktreeNotFoundError } from "../src/directory.js";

const make = async () => {
  const store = await createInMemoryRecordStore();
  await store.createProject({ id: "p1", name: "P", createdAt: "2026-01-01T00:00:00.000Z" });
  let n = 0;
  const directory = createRecordDirectory({
    store,
    newId: () => `sess-${++n}`,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { store, directory };
};

test("ensureWorktree auto-creates exactly one main row", async () => {
  const { store, directory } = await make();
  const first = await directory.ensureWorktree("p1");
  assert.equal(first.id, "main");
  assert.equal(first.branch, "main");
  const second = await directory.ensureWorktree("p1");
  assert.equal(second.id, "main");
  assert.equal((await store.listWorktrees("p1", { includeArchived: true })).length, 1);
});

test("mintWorktreeId slugs the name and suffixes collisions", async () => {
  const { directory } = await make();
  assert.equal(await directory.mintWorktreeId("p1", "Experiment A"), "experiment-a");
  await directory.addWorktree("p1", { id: "experiment-a", name: "Experiment A", branch: "experiment-a" });
  assert.equal(await directory.mintWorktreeId("p1", "Experiment A"), "experiment-a-2");
});

test("mintWorktreeId never yields the reserved main id", async () => {
  const { directory } = await make();
  assert.equal(await directory.mintWorktreeId("p1", "main"), "main-2");
});

test("requireWorktree rejects an unknown id and accepts main", async () => {
  const { directory } = await make();
  await directory.ensureWorktree("p1");
  assert.equal((await directory.requireWorktree("p1", "main")).id, "main");
  await assert.rejects(() => directory.requireWorktree("p1", "nope"), WorktreeNotFoundError);
});

test("createSession stamps the worktree and resolveOrCreateSession defaults to main", async () => {
  const { directory } = await make();
  await directory.ensureWorktree("p1");
  const explicit = await directory.createSession("p1", { worktreeId: "exp-a" });
  assert.equal(explicit.worktreeId, "exp-a");
  const lazy = await directory.resolveOrCreateSession("p1", "thread-1");
  assert.equal(lazy.worktreeId, "main");
  const lazy2 = await directory.resolveOrCreateSession("p1", "thread-2", "exp-a");
  assert.equal(lazy2.worktreeId, "exp-a");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test services/transport-service/test/directory-worktree.test.ts`
Expected: FAIL — `ensureWorktree`/`WorktreeNotFoundError` are not exported.

- [ ] **Step 3: Implement the directory methods**

In `services/transport-service/src/directory.ts`:
- Add `Worktree` to the record type import and import `DEFAULT_WORKTREE_ID`, `MAIN_BRANCH`.
- Add `export class WorktreeNotFoundError extends Error { constructor(readonly projectId: Id, readonly worktreeId: Id) { super(\`worktree not found: ${worktreeId}\`); this.name = "WorktreeNotFoundError"; } }`
- Extend the `RecordDirectory` interface with the methods listed in **Interfaces**.
- Implement them inside `createRecordDirectory`. Slug reuse: the module-private `slug()` already exists; add a numeric suffix loop:

```ts
  const mintWorktreeId = async (projectId: Id, name: string): Promise<Id> => {
    const base = slug(name) || "worktree";
    for (let i = 1; i < 1000; i += 1) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      if (candidate === DEFAULT_WORKTREE_ID) continue;
      if (!(await opts.store.getWorktree(candidate))) return candidate;
    }
    throw new Error("could not mint a unique worktree id");
  };
```

`ensureWorktree`:

```ts
    async ensureWorktree(projectId: Id): Promise<Worktree> {
      const existing = await opts.store.getWorktree(DEFAULT_WORKTREE_ID);
      if (existing && existing.projectId === projectId) return existing;
      return opts.store.addWorktree({
        id: DEFAULT_WORKTREE_ID,
        projectId,
        name: DEFAULT_WORKTREE_ID,
        branch: MAIN_BRANCH,
        createdAt: now(),
      });
    },
```

`requireWorktree`:

```ts
    async requireWorktree(projectId: Id, id: Id): Promise<Worktree> {
      const worktree = await opts.store.getWorktree(id);
      if (!worktree || worktree.projectId !== projectId) {
        throw new WorktreeNotFoundError(projectId, id);
      }
      return worktree;
    },
```

- [ ] **Step 4: Thread `worktreeId` through session creation**

Change `createSession`'s options type to `{ agentId?: Id; title?: string; worktreeId?: Id }`, and add `...(o.worktreeId ? { worktreeId: o.worktreeId } : {})` to the added Session. Change `resolveOrCreateSession(projectId, sessionKey, worktreeId?)` to include `worktreeId: worktreeId ?? DEFAULT_WORKTREE_ID` on the created row, and update the `RecordDirectory` interface signature.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test services/transport-service/test/directory-worktree.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/transport-service/src/directory.ts services/transport-service/test/directory-worktree.test.ts
git commit -m "feat(service): RecordDirectory worktree lifecycle and session worktree stamping"
```

---

### Task 4: `FsWorkspace` hidden entries

**Files:**
- Modify: `packages/workspace/src/fs-workspace.ts`
- Test: `packages/workspace/test/fs-workspace-hidden.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FsWorkspaceOptions.hiddenEntries?: readonly string[]` — entries whose `name` matches are omitted from `list`.

- [ ] **Step 1: Write the failing test**

Create `packages/workspace/test/fs-workspace-hidden.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsWorkspace } from "../src/index.js";

test("hiddenEntries are omitted from listings at any depth", async () => {
  const root = await mkdtemp(join(tmpdir(), "ss-hidden-"));
  try {
    await mkdir(join(root, ".worktrees", "exp-a"), { recursive: true });
    await mkdir(join(root, "data", ".git"), { recursive: true });
    await writeFile(join(root, "data", "x.csv"), "a\n");
    const ws = new FsWorkspace(root, { agentRoot: root, hiddenEntries: [".git", ".worktrees"] });
    assert.deepEqual((await ws.list()).entries.map((e) => e.name), ["data"]);
    assert.deepEqual((await ws.list("data")).entries.map((e) => e.name), ["x.csv"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test packages/workspace/test/fs-workspace-hidden.test.ts`
Expected: FAIL — `.worktrees` is listed.

- [ ] **Step 3: Implement the option**

In `packages/workspace/src/fs-workspace.ts`:
- Add to `FsWorkspaceOptions`:

```ts
  /** Entry names omitted from `list` results (e.g. `.git`, `.worktrees`). */
  hiddenEntries?: readonly string[];
```

- Add a private field `private readonly hidden: ReadonlySet<string>;` set in the constructor: `this.hidden = new Set(options.hiddenEntries ?? []);`
- In `list()`, inside the `for (const dirent of dirents)` loop, after the symlink check add:

```ts
      if (this.hidden.has(dirent.name)) continue;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test packages/workspace/test/fs-workspace-hidden.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace/src/fs-workspace.ts packages/workspace/test/fs-workspace-hidden.test.ts
git commit -m "feat(workspace): optional hiddenEntries for listings"
```

---

### Task 5: Environment seam keyed by `(projectId, worktreeId)`

**Files:**
- Modify: `packages/transport/src/environment.ts`
- Modify: `packages/transport/src/index.ts`
- Test: `packages/transport/test/environment.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Environment.worktreeId: Id`
  - `EnvironmentProvider.acquire(principal, projectId, worktreeId)`
  - `EnvironmentProvider.release?(principal, projectId, worktreeId?)` (omitted = all of the project)
  - `LocalEnvironmentOptions.environmentFor(projectId, worktreeId)`

- [ ] **Step 1: Write the failing test**

Create `packages/transport/test/environment.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalEnvironmentProvider, NullWorkspace, type RuntimeAdapter } from "../src/index.js";

const adapter = (): RuntimeAdapter =>
  ({ runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} }) as RuntimeAdapter;
const principal = { id: "u", tenant: "t" };

test("environments are cached per (project, worktree)", async () => {
  const built: string[] = [];
  const provider = new LocalEnvironmentProvider({
    environmentFor: async (projectId, worktreeId) => {
      built.push(`${projectId}/${worktreeId}`);
      return { adapter: adapter(), workspace: new NullWorkspace() };
    },
  });
  const a = await provider.acquire(principal, "p1", "main");
  const b = await provider.acquire(principal, "p1", "main");
  const c = await provider.acquire(principal, "p1", "exp-a");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.worktreeId, "main");
  assert.equal(c.worktreeId, "exp-a");
  assert.deepEqual(built, ["p1/main", "p1/exp-a"]);
});

test("release without a worktree releases every child of the project", async () => {
  let calls = 0;
  const provider = new LocalEnvironmentProvider({
    environmentFor: async () => {
      calls += 1;
      return { adapter: adapter(), workspace: new NullWorkspace() };
    },
  });
  await provider.acquire(principal, "p1", "main");
  await provider.acquire(principal, "p1", "exp-a");
  await provider.acquire(principal, "p2", "main");
  await provider.release?.(principal, "p1");
  await provider.acquire(principal, "p1", "main");
  await provider.acquire(principal, "p1", "exp-a");
  assert.equal(calls, 5); // 3 initial + 2 rebuilt
});

test("release with a worktree drops only that one", async () => {
  const provider = new LocalEnvironmentProvider({
    environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
  });
  const first = await provider.acquire(principal, "p1", "exp-a");
  await provider.acquire(principal, "p1", "main");
  await provider.release?.(principal, "p1", "exp-a");
  const rebuilt = await provider.acquire(principal, "p1", "exp-a");
  assert.notEqual(first, rebuilt);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @science-studio/transport`
Expected: FAIL — arity mismatch (`worktreeId` missing) / `worktreeId` property missing.

- [ ] **Step 3: Implement the seam change**

In `packages/transport/src/environment.ts`:
- Add `worktreeId: Id` to `Environment` (with a doc comment).
- Change `EnvironmentProvider.acquire` to `acquire(principal: Principal, projectId: Id, worktreeId: Id)`; `release?(principal, projectId, worktreeId?)`.
- Change `LocalEnvironmentOptions.environmentFor(projectId: Id, worktreeId: Id)`.
- Rewrite `LocalEnvironmentProvider` with a composite key:

```ts
  private readonly environments = new Map<string, Environment>();
  private readonly inflight = new Map<string, Promise<Environment>>();
  private static key(projectId: Id, worktreeId: Id): string {
    return `${projectId}\u0000${worktreeId}`;
  }

  async acquire(_principal: Principal, projectId: Id, worktreeId: Id): Promise<Environment> {
    const key = LocalEnvironmentProvider.key(projectId, worktreeId);
    const cached = this.environments.get(key);
    if (cached) return cached;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.local
        .environmentFor(projectId, worktreeId)
        .then((built) => {
          const environment: Environment = { ...built, projectId, worktreeId };
          this.environments.set(key, environment);
          return environment;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  async release(_principal: Principal, projectId: Id, worktreeId?: Id): Promise<void> {
    const prefix = `${projectId}\u0000`;
    const keys = [...this.environments.keys()].filter((key) =>
      worktreeId === undefined
        ? key.startsWith(prefix)
        : key === LocalEnvironmentProvider.key(projectId, worktreeId),
    );
    for (const key of keys) {
      this.environments.delete(key);
      const pending = this.inflight.get(key);
      if (pending) {
        await pending.catch(() => {});
        this.environments.delete(key);
      }
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @science-studio/transport`
Expected: PASS. (The other transport tests will type-fail until Tasks 7–8 update composition — run only this file if needed: `npx tsx --test packages/transport/test/environment.test.ts`.)

- [ ] **Step 5: Commit**

```bash
git add packages/transport/src/environment.ts packages/transport/test/environment.test.ts
git commit -m "feat(transport): key the environment seam by (projectId, worktreeId)"
```

---

### Task 6: `WorktreeContext` on the runtime init seam

**Files:**
- Modify: `packages/transport/src/types.ts`
- Modify: `packages/transport/src/seams.ts`
- Modify: `packages/transport/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface WorktreeContext { id: string; name: string; branch: string; root: string }` and `RuntimeInitOptions.worktree?: WorktreeContext`.

- [ ] **Step 1: Add the type**

In `packages/transport/src/types.ts`, after `ProjectContext`:

```ts
/**
 * The record-owned Worktree an adapter serves (docs/adr/0025) — a read-only
 * view an adapter may render into its tools/system prompt. `root` is the
 * worktree's directory as the AGENT sees it.
 */
export interface WorktreeContext {
  id: string;
  name: string;
  branch: string;
  root: string;
}
```

And add to `RuntimeInitOptions`:

```ts
  /**
   * The Worktree this adapter serves, when the deployment has one. A dsh child
   * names it in the worktree plugin's system prompt (docs/adr/0025).
   */
  worktree?: WorktreeContext;
```

- [ ] **Step 2: Re-export from both entries**

In `packages/transport/src/seams.ts` add `WorktreeContext` to the `./types.js` type export block. In `packages/transport/src/index.ts` add `WorktreeContext` to the re-export from `./seams.js`.

- [ ] **Step 3: Verify**

Run: `npx tsc -b packages/transport`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/transport/src/types.ts packages/transport/src/seams.ts packages/transport/src/index.ts
git commit -m "feat(transport): WorktreeContext on the runtime init seam"
```

---

### Task 7: `worktree/paths.ts` pure layout helper

**Files:**
- Create: `services/transport-service/src/worktree/paths.ts`
- Test: `services/transport-service/test/worktree-paths.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_WORKTREE_ID` from `@science-studio/record`.
- Produces:
  - `function worktreeRelPath(worktreeId: Id): string` — `""` for `main`, else `posix.join(".worktrees", id)`.
  - `const WORKTREES_DIR = ".worktrees"`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { worktreeRelPath } from "../src/worktree/paths.js";

test("main worktree path is the project root", () => {
  assert.equal(worktreeRelPath("main"), "");
});

test("a linked worktree lives under .worktrees/<id>", () => {
  assert.equal(worktreeRelPath("exp-a"), ".worktrees/exp-a");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test services/transport-service/test/worktree-paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { posix } from "node:path";
import { DEFAULT_WORKTREE_ID, type Id } from "@science-studio/record";

/** The directory under a Project root that holds linked worktree checkouts. */
export const WORKTREES_DIR = ".worktrees";

/**
 * The workspace-relative path of a worktree under its Project root: the empty
 * string for `main` (the Project root itself), else `.worktrees/<id>`. Derived,
 * never stored (docs/adr/0025).
 */
export function worktreeRelPath(worktreeId: Id): string {
  return worktreeId === DEFAULT_WORKTREE_ID ? "" : posix.join(WORKTREES_DIR, worktreeId);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test services/transport-service/test/worktree-paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/transport-service/src/worktree/paths.ts services/transport-service/test/worktree-paths.test.ts
git commit -m "feat(service): worktree relative-path helper"
```

---

### Task 8: Composition — per-worktree workspace and environment

**Files:**
- Modify: `services/transport-service/src/composition.ts`

**Interfaces:**
- Consumes: `worktreeRelPath` (Task 7), the new `environmentFor(projectId, worktreeId)` (Task 5), `WorktreeContext` (Task 6).
- Produces: `localWorkspace(env, projectId, worktreeId)` and an `environmentFor(projectId, worktreeId)` that passes the worktree context to `adapter.init`.

- [ ] **Step 1: Update `localWorkspace`**

Replace the signature and body:

```ts
export function localWorkspace(env: NodeJS.ProcessEnv, projectId: Id, worktreeId: Id): Workspace {
  const root = env.PROJECT_ROOT;
  if (!root) return new NullWorkspace();
  const agentRoot = env.PROJECT_AGENT_ROOT ?? root;
  const maxInlineRaw = env.WORKSPACE_MAX_INLINE_BYTES;
  const maxInlineBytes = maxInlineRaw && /^\d+$/.test(maxInlineRaw) ? Number(maxInlineRaw) : undefined;
  const rel = worktreeRelPath(worktreeId);
  return new FsWorkspace(join(root, projectId, rel), {
    agentRoot: join(agentRoot, projectId, rel),
    hiddenEntries: [".git", WORKTREES_DIR],
    ...(maxInlineBytes !== undefined ? { maxInlineBytes } : {}),
  });
}
```

Add the imports: `import { WORKTREES_DIR, worktreeRelPath } from "./worktree/paths.js";`

- [ ] **Step 2: Update `environmentFor`**

Change the callback to accept `(projectId, worktreeId)`, compute the workspace with both, read the worktree row, and pass `worktree` to `init`:

```ts
    environmentFor: async (projectId, worktreeId) => {
      const workspace = localWorkspace(env, projectId, worktreeId);
      const adapter = plugin.factory.create(binding);
      const project = await records.getProject(projectId).catch(() => null);
      const worktree = await records.getWorktree(worktreeId).catch(() => null);
      void adapter
        .init({
          binding,
          recordStore,
          workspace,
          env: { ...env },
          ...(project === null
            ? {}
            : { project: { id: project.id, name: project.name, createdAt: project.createdAt } }),
          ...(worktree === null
            ? {}
            : {
                worktree: {
                  id: worktree.id,
                  name: worktree.name,
                  branch: worktree.branch,
                  root: workspace.toAgentPath(""),
                },
              }),
        })
        .catch((err) =>
          console.error(`[transport-service] adapter init failed for ${projectId}/${worktreeId}`, err),
        );
      return { adapter, workspace };
    },
```

- [ ] **Step 3: Verify the service still type-checks**

Run: `npx tsc -b services/transport-service`
Expected: errors only where `acquire`/`environmentFor`/`release` call sites are not yet updated (Task 9) — list them and continue.

- [ ] **Step 4: Commit**

```bash
git add services/transport-service/src/composition.ts
git commit -m "feat(service): per-worktree workspace and environment"
```

---

### Task 9: `ProjectScopes` worktree claim

**Files:**
- Modify: `services/transport-service/src/project-scope.ts`
- Test: `services/transport-service/test/worktree-scope.test.ts`

**Interfaces:**
- Consumes: `directory.requireWorktree` (Task 3), the new `acquire(principal, projectId, worktreeId)` (Task 5).
- Produces:
  - `ProjectScope.worktreeId: Id`
  - `interface ProjectClaim { principal; projectId; worktreeId; threadId }`
  - `ProjectScopes.claim(request): Promise<ProjectClaim>` — resolves ids WITHOUT acquiring the environment.
  - `acquire`/`sessionOf`/`withWorkspace` resolve `worktreeId` (claim key `worktreeId`, default `"main"`) and validate it via `requireWorktree`.
  - `sessionOf` passes `scope.worktreeId` to `resolveOrCreateSession`.

- [ ] **Step 1: Write the failing test**

Create `services/transport-service/test/worktree-scope.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore } from "@science-studio/record";
import { LocalEnvironmentProvider, NullWorkspace, type RuntimeAdapter } from "@science-studio/transport";
import { createRecordDirectory } from "../src/directory.js";
import { createProjectScopes } from "../src/project-scope.js";

const adapter = (): RuntimeAdapter =>
  ({ runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} }) as RuntimeAdapter;

async function harness() {
  const store = await createInMemoryRecordStore();
  await store.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  await store.addWorktree({ id: "main", projectId: "project-default", name: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" });
  await store.addWorktree({ id: "exp-a", projectId: "project-default", name: "A", branch: "exp/a", createdAt: "2026-01-01T00:00:00.000Z" });
  const directory = createRecordDirectory({ store });
  const environments = new LocalEnvironmentProvider({
    environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
  });
  const scope = createProjectScopes({ environments, directory, defaultProjectId: "project-default" });
  const request = (query: Record<string, string>) =>
    ({ query, body: {}, principal: { id: "u", tenant: "t" } }) as never;
  return { scope, request };
}

test("a missing worktree claim defaults to main", async () => {
  const { scope, request } = await harness();
  const claim = await scope.claim(request({}));
  assert.equal(claim.worktreeId, "main");
});

test("a claimed worktree is honored", async () => {
  const { scope, request } = await harness();
  const acquired = await scope.acquire(request({ worktreeId: "exp-a" }));
  assert.equal(acquired.worktreeId, "exp-a");
});

test("an unknown worktree is rejected, never defaulted", async () => {
  const { scope, request } = await harness();
  await assert.rejects(() => scope.acquire(request({ worktreeId: "nope" })));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test services/transport-service/test/worktree-scope.test.ts`
Expected: FAIL — `claim` is not a function / `WorktreeNotFoundError` propagates only after implementation.

- [ ] **Step 3: Implement the claim**

In `services/transport-service/src/project-scope.ts`:
- Add `const WORKTREE_CLAIM_KEYS = ["worktreeId"] as const;`
- Add `worktreeId: Id` to `ProjectScope`, and define/export `ProjectClaim`.
- Add `claim(request): Promise<ProjectClaim>` to the interface.
- Refactor the internal resolution:

```ts
  const resolveClaim = (request: FastifyRequest): ProjectClaim => {
    const principal = request.principal!;
    return {
      principal,
      projectId: claim(request, PROJECT_CLAIM_KEYS) ?? defaultProjectId,
      worktreeId: claim(request, WORKTREE_CLAIM_KEYS) ?? DEFAULT_WORKTREE_ID,
      threadId: claim(request, SESSION_CLAIM_KEYS),
    };
  };

  const acquire = async (request: FastifyRequest): Promise<ProjectScope> => {
    const resolved = resolveClaim(request);
    await directory.requireWorktree(resolved.projectId, resolved.worktreeId);
    return {
      ...resolved,
      environment: await environments.acquire(resolved.principal, resolved.projectId, resolved.worktreeId),
    };
  };
```

- `claim: async (request) => resolveClaim(request)`.
- `acquireProject(principal, projectId)` uses `worktreeId: DEFAULT_WORKTREE_ID`, calls `requireWorktree`, and acquires with it.
- `sessionOf` calls `directory.resolveOrCreateSession(scope.projectId, sessionKey, scope.worktreeId)`.

Import `DEFAULT_WORKTREE_ID` from `@science-studio/record`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test services/transport-service/test/worktree-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/transport-service/src/project-scope.ts services/transport-service/test/worktree-scope.test.ts
git commit -m "feat(service): resolve a worktree in the project scope"
```

---

### Task 10: git client and lazy repository init

**Files:**
- Create: `services/transport-service/src/worktree/git.ts`
- Test: `services/transport-service/test/worktree-git.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface GitResult { code: number; stdout: string; stderr: string }`
  - `interface GitRunner { run(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<GitResult> }`
  - `function createGitRunner(opts?: { gitBin?: string }): GitRunner`
  - `class GitError extends Error { readonly stderr: string; readonly code: number }`
  - High-level helpers (taking a `GitRunner`):
    - `isRepo(git, dir): Promise<boolean>`
    - `ensureRepo(git, dir): Promise<boolean>` (returns whether it initialized)
    - `currentBranch(git, dir): Promise<string>`
    - `worktreeAdd(git, { repoDir, path, branch, base, createBranch }): Promise<void>` (throws `GitError` on failure)
    - `worktreeRemove(git, { repoDir, path, force }): Promise<void>`
    - `listWorktrees(git, repoDir): Promise<{ path: string; branch: string | null }[]>`
  - `const GITIGNORE_ENTRIES = [".worktrees/", ".science-studio/"]`

- [ ] **Step 1: Write the failing test**

Create `services/transport-service/test/worktree-git.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitRunner,
  currentBranch,
  ensureRepo,
  GitError,
  isRepo,
  listWorktrees,
  worktreeAdd,
  worktreeRemove,
} from "../src/worktree/git.js";

const git = createGitRunner();

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ss-git-"));
}

test("ensureRepo initializes main, gitignores and commits, idempotently", async () => {
  const dir = await tmp();
  try {
    assert.equal(await isRepo(git, dir), false);
    assert.equal(await ensureRepo(git, dir), true);
    assert.equal(await isRepo(git, dir), true);
    assert.equal(await currentBranch(git, dir), "main");
    const ignore = await readFile(join(dir, ".gitignore"), "utf8");
    assert.match(ignore, /\.worktrees\//);
    assert.match(ignore, /\.science-studio\//);
    assert.equal(await ensureRepo(git, dir), false); // already a repo
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worktreeAdd creates a linked checkout and worktreeRemove clears it", async () => {
  const dir = await tmp();
  try {
    await ensureRepo(git, dir);
    const path = join(dir, ".worktrees", "exp-a");
    await worktreeAdd(git, { repoDir: dir, path, branch: "exp-a", base: "main", createBranch: true });
    assert.equal(await currentBranch(git, path), "exp-a");
    const listed = await listWorktrees(git, dir);
    assert.ok(listed.some((w) => w.branch === "exp-a"));
    await worktreeRemove(git, { repoDir: dir, path, force: true });
    await assert.rejects(() => stat(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worktreeAdd on a branch already checked out throws GitError with stderr", async () => {
  const dir = await tmp();
  try {
    await ensureRepo(git, dir);
    await worktreeAdd(git, { repoDir: dir, path: join(dir, ".worktrees", "same"), branch: "same", base: "main", createBranch: true });
    await assert.rejects(
      () => worktreeAdd(git, { repoDir: dir, path: join(dir, ".worktrees", "same-2"), branch: "same", base: "main", createBranch: false }),
      (err: unknown) => err instanceof GitError && /already checked out|already used/i.test(err.stderr),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test services/transport-service/test/worktree-git.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `worktree/git.ts`**

```ts
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<GitResult>;
}

export class GitError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number) {
    super(message);
    this.name = "GitError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
export const GITIGNORE_ENTRIES = [".worktrees/", ".science-studio/"] as const;
const COMMITTER = ["-c", "user.name=Science Studio", "-c", "user.email=science-studio@localhost"];

export function createGitRunner(opts: { gitBin?: string } = {}): GitRunner {
  const gitBin = opts.gitBin ?? process.env.GIT_BINARY ?? "git";
  return {
    run(args, runOpts = {}) {
      return new Promise((resolve) => {
        const child = spawn(gitBin, args, { cwd: runOpts.cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timeoutMs = runOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          resolve({ code: -1, stdout, stderr: `${stderr}\ngit timed out after ${timeoutMs}ms`.trim() });
        }, timeoutMs);
        timer.unref?.();
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: -1, stdout, stderr: err.message });
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
  };
}

/** True when `dir` is inside a git work tree (false for a missing binary). */
export async function isRepo(git: GitRunner, dir: string): Promise<boolean> {
  const result = await git.run(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  return result.code === 0 && result.stdout.trim() === "true";
}

async function ensureGitignore(dir: string): Promise<void> {
  const file = join(dir, ".gitignore");
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch {
    current = "";
  }
  const lines = new Set(current.split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  await writeFile(file, `${prefix}${missing.join("\n")}\n`, "utf8");
}

async function must(git: GitRunner, args: string[], cwd: string): Promise<string> {
  const result = await git.run(args, { cwd });
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(" ")} failed`, result.stderr.trim(), result.code);
  }
  return result.stdout;
}

/** Lazily initialize `dir` as a git repo with a first commit. Idempotent. */
export async function ensureRepo(git: GitRunner, dir: string): Promise<boolean> {
  if (await isRepo(git, dir)) return false;
  await must(git, ["init", "-b", "main"], dir);
  await ensureGitignore(dir);
  await must(git, ["add", "-A"], dir);
  await must(git, [...COMMITTER, "commit", "-m", "Initialize project workspace"], dir);
  return true;
}

export async function currentBranch(git: GitRunner, dir: string): Promise<string> {
  return (await must(git, ["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();
}

export async function worktreeAdd(
  git: GitRunner,
  opts: { repoDir: string; path: string; branch: string; base: string; createBranch: boolean },
): Promise<void> {
  const args = opts.createBranch
    ? ["worktree", "add", "-b", opts.branch, opts.path, opts.base]
    : ["worktree", "add", opts.path, opts.branch];
  await must(git, args, opts.repoDir);
}

export async function worktreeRemove(
  git: GitRunner,
  opts: { repoDir: string; path: string; force: boolean },
): Promise<void> {
  const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), opts.path];
  await must(git, args, opts.repoDir);
}

/** Parse `git worktree list --porcelain` into path/branch pairs. */
export async function listWorktrees(
  git: GitRunner,
  repoDir: string,
): Promise<{ path: string; branch: string | null }[]> {
  const out = await must(git, ["worktree", "list", "--porcelain"], repoDir);
  const result: { path: string; branch: string | null }[] = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) result.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current) result.push(current);
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test services/transport-service/test/worktree-git.test.ts`
Expected: PASS (requires `git` on PATH).

- [ ] **Step 5: Commit**

```bash
git add services/transport-service/src/worktree/git.ts services/transport-service/test/worktree-git.test.ts
git commit -m "feat(service): spawn-based git client and lazy repo init"
```

---

### Task 11: `/api/worktrees*` routes

**Files:**
- Create: `services/transport-service/src/worktree/routes.ts`
- Modify: `services/transport-service/src/composition.ts` (add `projectRoot?`/`git?` test seams to `Backend`)
- Modify: `services/transport-service/src/server.ts` (register the routes; add the 404 error handler)
- Test: `services/transport-service/test/worktree-routes.test.ts`

**Interfaces:**
- Consumes: `ProjectScopes.claim`, `RecordDirectory` worktree methods, the git helpers, `EnvironmentProvider.release`.
- Produces: `registerWorktreeRoutes(app, deps): void` with `deps = { scope, directory, records, environments, git, projectRoot? }`.

- [ ] **Step 1: Write the failing test**

Create `services/transport-service/test/worktree-routes.test.ts`. Follow the `withServer` shape used by `workspace-routes.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryRecordStore } from "@science-studio/record";
import { LocalEnvironmentProvider, LocalPrincipalResolver, NullWorkspace, type RuntimeAdapter } from "@science-studio/transport";
import { createTransportService } from "../src/server.js";
import type { Backend } from "../src/composition.js";

const adapter = (): RuntimeAdapter =>
  ({ runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} }) as RuntimeAdapter;

test("create, list, and delete a worktree through the routes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ss-wt-"));
  const records = await createInMemoryRecordStore();
  await records.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records,
    recordDefaults: { projectId: "project-default", projectName: "D", agentId: "main" },
    projectRoot,
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const created = await fetch(`${base}/api/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default", name: "Experiment A" }),
    });
    assert.equal(created.status, 201);
    const { worktree } = (await created.json()) as { worktree: { id: string; branch: string } };
    assert.equal(worktree.id, "experiment-a");
    assert.equal(worktree.branch, "experiment-a");

    const list = await fetch(`${base}/api/worktrees?projectId=project-default`);
    const listed = (await list.json()) as { worktrees: { id: string }[] };
    assert.deepEqual(listed.worktrees.map((w) => w.id).sort(), ["experiment-a", "main"]);

    const denied = await fetch(`${base}/api/worktrees/main/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default" }),
    });
    assert.equal(denied.status, 403);

    const deleted = await fetch(`${base}/api/worktrees/experiment-a/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default" }),
    });
    assert.equal(deleted.status, 200);
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("listing does not create a repository", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ss-wt-"));
  const records = await createInMemoryRecordStore();
  await records.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records,
    recordDefaults: { projectId: "project-default", projectName: "D", agentId: "main" },
    projectRoot,
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await fetch(`${base}/api/worktrees?projectId=project-default`);
    const { stat } = await import("node:fs/promises");
    await assert.rejects(() => stat(join(projectRoot, "project-default", ".git")));
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test services/transport-service/test/worktree-routes.test.ts`
Expected: FAIL — 404 for `/api/worktrees`.

- [ ] **Step 3: Add the `Backend` test seams**

In `services/transport-service/src/composition.ts`, add to `Backend`:

```ts
  /** Test seam: the host-side project root git worktrees live under (default `PROJECT_ROOT`). */
  projectRoot?: string;
  /** Test seam: the git runner (defaults to the real system-git spawner). */
  git?: import("./worktree/git.js").GitRunner;
```

- [ ] **Step 4: Implement `worktree/routes.ts`**

Implement `registerWorktreeRoutes(app, deps)`:

- Resolve `projectDir(projectId)` = `projectRoot ? join(projectRoot, projectId) : null`; `worktreeDir(projectId, id)` = `projectDir ? join(projectDir, worktreeRelPath(id)) : null`.
- `GET /api/worktrees`: `const claim = await scope.claim(request)`; `await directory.ensureWorktree(claim.projectId)`; list with `includeArchived`; decorate each row with on-disk info when `projectDir` exists and `isRepo` is true (parse `listWorktrees(git, projectDir)` into a path→branch map; `exists` = the worktree dir stat succeeds). Return `{ worktrees, defaultWorktreeId: DEFAULT_WORKTREE_ID }`.
- `POST /api/worktrees`: validate `name` non-empty → 400; 404 when `records.getProject(projectId)` is null; 503 when `projectDir` is null; `await ensureRepo(git, projectDir)`; `id = await directory.mintWorktreeId(...)`; `branch = body.branch?.trim() || id`; `base = body.base?.trim() || "main"`; `path = worktreeDir(...)!`; wrap `worktreeAdd` — on `GitError`, map `/already checked out|already exists|is already used/i.test(err.stderr)` to 409 else 502, returning `{ error: err.stderr || err.message }`; then `directory.addWorktree(projectId, { id, name, branch })` in a try/catch whose catch best-effort `worktreeRemove(..., force: true)` and rethrows; return 201 `{ worktree }`.
- `POST /api/worktrees/:id/rename`: 403 for `main`; 400 empty name; 404 when `getWorktree` misses or `projectId` differs; return `{ worktree: await directory.renameWorktree(id, name) }`.
- `POST /api/worktrees/:id/archive` / `unarchive`: 403 for `main`; 404 when missing; for archive call `environments.release?.(claim.principal, claim.projectId, id)` (best-effort, log on failure); return `{ worktree }`.
- `POST /api/worktrees/:id/delete`: 403 for `main`; 404 when missing; `await environments.release?.(...)`; if `projectDir` and `worktreeDir` exist: `await worktreeRemove(git, { repoDir: projectDir, path, force: true }).catch(log)`; if the dir still exists after, move it to a sibling `.recycle/<basename>-<ts>` with `mkdir`+`rename` (copy `moveToRecycle`'s shape from `fs-workspace.ts`); `await directory.deleteWorktree(id)`; return `{ ok: true }`.
- Map a thrown `WorktreeNotFoundError` via the server error handler (next step), or catch it in each route; prefer the handler.

- [ ] **Step 5: Register the routes and add the error handler**

In `services/transport-service/src/server.ts`:
- Import `registerWorktreeRoutes` from `./worktree/routes.js`, `createGitRunner` from `./worktree/git.js`, and `WorktreeNotFoundError` from `./directory.js`.
- Import `localWorkspace` from `./composition.js` if needed for the `exists` check (or use `stat`).
- Before the routes, add:

```ts
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorktreeNotFoundError) {
      return reply.code(404).send({ error: err.message });
    }
    reply.send(err);
  });
```

- After the HPC registration, add:

```ts
  registerWorktreeRoutes(app, {
    scope,
    directory,
    records,
    environments: backend.environments,
    git: backend.git ?? createGitRunner(),
    ...((backend.projectRoot ?? process.env.PROJECT_ROOT)
      ? { projectRoot: (backend.projectRoot ?? process.env.PROJECT_ROOT)! }
      : {}),
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test services/transport-service/test/worktree-routes.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole service suite**

Run: `npm run test -w @science-studio/transport-service`
Expected: PASS — fix any existing test that constructed a `Backend` without worktree fields (the defaults keep them optional).

- [ ] **Step 8: Commit**

```bash
git add services/transport-service/src/worktree/routes.ts services/transport-service/src/composition.ts services/transport-service/src/server.ts services/transport-service/test/worktree-routes.test.ts
git commit -m "feat(service): /api/worktrees routes with lazy init and cascade"
```

---

### Task 12: Sessions and transport carry `worktreeId`

**Files:**
- Modify: `services/transport-service/src/server.ts`
- Test: `services/transport-service/test/worktree-routes.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's `createSession({ worktreeId })`, Task 9's scope claim.
- Produces: `POST /api/projects/:id/sessions` accepts `worktreeId`; `GET /api/projects/:id/sessions?worktreeId=` filters; the transport/watch routes already thread it via `scope`.

- [ ] **Step 1: Write the failing test**

Append to `worktree-routes.test.ts`:

```ts
test("a session is created under a claimed worktree and listed by it", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ss-wt-"));
  const records = await createInMemoryRecordStore();
  await records.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records,
    recordDefaults: { projectId: "project-default", projectName: "D", agentId: "main" },
    projectRoot,
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await fetch(`${base}/api/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default", name: "Experiment A" }),
    });
    const created = await fetch(`${base}/api/projects/project-default/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreeId: "experiment-a" }),
    });
    const { session } = (await created.json()) as { session: { worktreeId?: string } };
    assert.equal(session.worktreeId, "experiment-a");

    const listed = await fetch(`${base}/api/projects/project-default/sessions?worktreeId=experiment-a`);
    const body = (await listed.json()) as { sessions: { worktreeId?: string }[] };
    assert.equal(body.sessions.length, 1);
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test services/transport-service/test/worktree-routes.test.ts`
Expected: FAIL — `worktreeId` is not threaded / the filter is ignored.

- [ ] **Step 3: Implement**

In `server.ts`'s `POST /api/projects/:id/sessions`:
- Read `worktreeId` from the body; when present, `await directory.requireWorktree(id, worktreeId)` (catch → 404) and pass it to `directory.createSession(id, { ..., worktreeId })`.
- In `GET /api/projects/:id/sessions`, read `worktreeId` from the query and filter with `sessionWorktreeId(session) === worktreeId` when present. Import `sessionWorktreeId` from `@science-studio/record`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test services/transport-service/test/worktree-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/transport-service/src/server.ts services/transport-service/test/worktree-routes.test.ts
git commit -m "feat(service): sessions carry and filter by worktreeId"
```

---

### Task 13: Web proxy for `/api/worktrees`

**Files:**
- Create: `apps/web/app/api/worktrees/[[...path]]/route.ts`
- Test: none (the proxy is pinned by the workbench plan's e2e).

**Interfaces:**
- Consumes: `proxyToService` from `apps/web/lib/service-proxy.ts`.
- Produces: same-origin `/api/worktrees*` on port 3000.

- [ ] **Step 1: Read a sibling proxy route**

Read `apps/web/app/api/hpc/[[...path]]/route.ts` and copy its exact shape (exported `runtime`/`dynamic` literals, the `proxyToService` call, query/path relay).

- [ ] **Step 2: Create the route**

Create `apps/web/app/api/worktrees/[[...path]]/route.ts` relaying `GET` and `POST` to the upstream `/api/worktrees` prefix with all catch-all segments and the query string. Keep the per-hop specifics (upstream path, method, body) only; everything else comes from `service-proxy.ts`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/worktrees/[[...path]]/route.ts
git commit -m "feat(web): /api/worktrees proxy hop"
```

---

### Task 14: ADRs and documentation

**Files:**
- Create: `docs/adr/0025-worktree-is-a-record-scoped-environment-dimension.md`
- Modify: `docs/adr/0007-record-layer-is-project-session-run.md`
- Modify: `docs/adr/0008-per-project-runtime-provisioning.md`
- Modify: `AGENTS.md`
- Modify: `CONTEXT.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Write ADR 0025**

Follow the existing ADR shape (Status / Context / Decision / Consequences). Record: `Worktree` is a record entity; the Project root is the `main` worktree; the environment is keyed by `(projectId, worktreeId)`; the service owns git; path is derived; archive releases the child.

- [ ] **Step 2: Revise ADR-0007 and ADR-0008**

- 0007: change the vocabulary line to `Project → Worktree → Session → Run` and note `Worktree` was added by 0025.
- 0008: change "per Project" to "per worktree" and note one harness child per live worktree.

- [ ] **Step 3: Update `AGENTS.md` and `CONTEXT.md`**

- `AGENTS.md`: in the "Project/Session lifecycle" bullet, add the worktree routes and the derived-path rule; in the workspace bullet, note `localWorkspace(env, projectId, worktreeId)` and `.worktrees/`; in the record-layer bullet, add `project-default`'s `main` worktree.
- `CONTEXT.md`: add a **Worktree** entry under the domain vocabulary (a git worktree of a Project on its own branch; `main` is the Project root).

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0025-worktree-is-a-record-scoped-environment-dimension.md docs/adr/0007-record-layer-is-project-session-run.md docs/adr/0008-per-project-runtime-provisioning.md AGENTS.md CONTEXT.md
git commit -m "docs: record the worktree record entity and per-worktree environment"
```

- [ ] **Step 5: Run the root build gate**

Run: `npm run build`
Expected: PASS (record → transport → workspace → … → typecheck:tests).

---

## Plan complete — what ships

After Task 14, the service can create/list/rename/archive/delete git worktrees, sessions carry a worktree, transport/workspace requests scope to `(projectId, worktreeId)`, and the whole thing passes the root build. The dsh agent tools and the workbench UI are the next two plans.
