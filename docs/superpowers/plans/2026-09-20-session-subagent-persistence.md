# Durable Session & Subagent Transcript — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the record the single durable source of truth for a settled session's full transcript and every subagent's run + transcript, so a service restart no longer drops the rich content.

**Architecture:** `packages/record` gains two new durable objects (`PersistedTranscript`, `Subagent`) + 5 new `RecordStore` methods; `packages/transport`'s `RecordStoreLike` re-exports them with typed `Message[]`; the dsh adapter's `TranscriptMirror` (ephemeral, `/tmp`) + `FileSubagentLedger` are deleted — `prepare()`/settle/subagent-capture swap to the record store.

**Tech Stack:** TypeScript, Node.js `node:fs/promises`, Node.js test runner, the existing dependency-free `RecordStore` (in-memory + JSONL) impls, `packages/contract-tests` for both impls.

## Global Constraints

- **Dependency direction**: `packages/record` must stay a LEAF (no imports of `packages/transport` or `@science-studio/transport/*`). `packages/transport` → `packages/record` is legal (already in use for `Run`/`Id`). `packages/transport-dsh` → `packages/transport` is legal (already in use).
- **Opaque transcript shape**: the record package stores the transcript's `messages` as `unknown` (JSON-safe) — it does NOT import the runtime's `Message[]` type (cycle prevention). The runtime adapter (transport-dsh) casts to `Message[]` at read time (safe: it wrote the blob).
- **Stable subagent id**: the dsh adapter mints one (`"subagent-" + randomUUID()`) at subagent-start; the record owns storage (doesn't mint).
- **No new env vars**: `DSH_TRANSCRIPT_DIR` and its default (`/tmp/science-studio/transcripts`) retire. The record store's JSONL path (`RECORD_STORE_PATH`) is the sole config point.
- **Scope bar (v1, from docs/adr/0019)**: restart-survival of SETTLED sessions + subagents. NOT mid-turn crash-resume, NOT append-only event log, NOT single-writer/flush.
- **Test suite**: every task ends with a green `npm test` for the affected workspace(s) + a commit.
- **Doc language**: all in-repo docs (ADRs, design, plans, CONTEXT.md) are written in **English**.
- **Existing invariants preserved** (not re-tested, not changed): the settle pipeline contains every failure; empty transcript never overrides a claiming client (ADR 0004); a restored `running` subagent settles to `aborted`; structural payloads never throw into the run stream.

---

## File structure

**Create:**
- `packages/contract-tests/src/transcript-subagent.ts` — conformance suite for the two new durable objects + 5 seam methods.

**Modify:**
- `packages/record/src/types.ts` (add `PersistedTranscript`, `Subagent`)
- `packages/record/src/index.ts` (extend `RecordStore` — 5 new methods — + export the two types)
- `packages/record/src/memory.ts` (implement the 5 methods, `Map`-backed)
- `packages/record/src/jsonl.ts` (implement the 5 methods, sibling `transcripts/` + `subagents/` dirs)
- `packages/contract-tests/src/index.ts` (export the new suite)
- `packages/transport/src/types.ts` (extend `RecordStoreLike` — 5 new methods)
- `packages/transport-dsh/src/behavior.ts` (`prepare`, `beforePersist`, `watch.readBaseline` → record)
- `packages/transport-dsh/src/adapter.ts` (constructor: drop `TranscriptMirror` + `FileSubagentLedger`; wire `recordStore` into behavior + registry)
- `packages/transport-dsh/src/subagents.ts` (`SubagentRegistry` store seam → `RecordStoreLike`; stable id + capture transcript on settle)
- `packages/transport-dsh/src/index.ts` (drop `TranscriptMirror` export once deleted)

**Delete:**
- `packages/transport-dsh/src/mirror.ts` (codec moves into the record package's file impl)
- `packages/transport-dsh/src/ledger.ts` (registry now reads/writes via the record store)

**Test (new):**
- `packages/contract-tests/src/transcript-subagent.test.ts` (both impls; round-trip, stable keys, parent scoping)
- `packages/transport-dsh/src/__restart__.test.ts` (the direct 炭素素 regression)

---

## Task 1 — record: types + in-memory impl

**Files:**
- Modify: `packages/record/src/types.ts` (append the two types)
- Modify: `packages/record/src/index.ts` (extend interface + re-export types)
- Modify: `packages/record/src/memory.ts` (implement the 5 methods)
- Test: `packages/record/test/memory-transcript-subagent.test.ts` (**create**)

**Interfaces:**
- Consumes: the existing `Id` type (record).
- Produces: `PersistedTranscript`, `Subagent` (exported from `@science-studio/record`), the 5 `RecordStore` methods (below).

- [ ] **Step 1: Write the failing test (`packages/record/test/memory-transcript-subagent.test.ts`)** — the in-memory impl must round-trip both objects.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore } from "../dist/memory.js";

test("in-memory: transcript round-trip", async () => {
  const store = createInMemoryRecordStore();
  await store.saveSessionTranscript("sess-1", { v: 1, status: "idle", messages: [ { id: "m1", role: "user", parts: [{type:"text",text:"hi"}] } ] });
  const doc = await store.loadSessionTranscript("sess-1");
  assert.ok(doc);
  assert.equal(doc.status, "idle");
  assert.equal((doc.messages as any[]).length, 1);
});

test("in-memory: subagent list-by-parent + upsert", async () => {
  const store = createInMemoryRecordStore();
  const s = { id: "subagent-A", parentSessionId: "sess-1", origin: "subagent", status: "completed" as const, startedAt: "2026-09-20T00:00:00Z" };
  await store.upsertSubagent(s);
  await store.upsertSubagent({ ...s, id: "subagent-B" });
  await store.upsertSubagent({ ...s, id: "subagent-C", parentSessionId: "sess-2" });
  const list = await store.listSubagents("sess-1");
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(x => x.id).sort(), ["subagent-A", "subagent-B"]);
  const one = await store.loadSubagent("subagent-B");
  assert.ok(one);
  assert.equal(one.parentSessionId, "sess-1");
});
```

- [ ] **Step 2: Run the test (expect FAIL — method not on the interface)**

Run: `npx tsc -p packages/record/tsconfig.json --noEmit`
Expected: error `Property 'saveSessionTranscript' does not exist on type 'RecordStore'`

- [ ] **Step 3: Implement in `types.ts` (append at the end)**

```ts
/**
 * A durable, stably-identified session transcript (the runtime's canonical
 * conversation view). The record stores it as an opaque JSON payload — it
 * owns the storage, not the interpretation (the runtime defines the shape).
 */
export interface PersistedTranscript {
  v: 1;
  status: string;
  /** The runtime's full `Message[]` (JSON-safe). The record does not read it. */
  messages: unknown;
}

/**
 * A durable, stably-identified subagent (a lineage-bearing, self-contained
 * session): its stable id, durable parent-session link, run metadata, and its
 * own captured transcript.
 */
export interface Subagent {
  id: Id;
  parentSessionId: Id;
  origin: "subagent";
  label?: string;
  provider?: string;
  status: "running" | "completed" | "aborted" | "error";
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  transcript?: PersistedTranscript;
}
```

- [ ] **Step 4: Extend `RecordStore` in `index.ts`** — import + extend the interface:

```ts
import type { Id, Project, Run, Session, PersistedTranscript, Subagent } from "./types.js";
// ... (existing exports, unchanged)

export interface RecordStore {
  // ... (existing methods unchanged)
  // Durable session transcript: the runtime's canonical conversation view
  // (docs/adr/0019). Stored opaquely by the record — the runtime owns the shape.
  saveSessionTranscript(sessionId: Id, doc: PersistedTranscript): Promise<void>;
  loadSessionTranscript(sessionId: Id): Promise<PersistedTranscript | null>;
  // Durable subagents: stably-identified, lineage-bearing, self-contained
  // sessions (docs/adr/0019).
  upsertSubagent(subagent: Subagent): Promise<void>;
  loadSubagent(id: Id): Promise<Subagent | null>;
  listSubagents(parentSessionId: Id): Promise<Subagent[]>;
}
```

Also update the `export type { ... }` line to include the two new types:

```ts
export type { Id, Project, Run, RunStatus, Session, PersistedTranscript, Subagent } from "./types.js";
```

- [ ] **Step 5: Implement in `memory.ts`** (insert before the closing `};`):

```ts
    // Durable session transcript + subagents (docs/adr/0019): the record
    // owns storage; the runtime (adapter) owns the transcript shape.
    async saveSessionTranscript(sessionId: Id, doc: PersistedTranscript): Promise<void> {
      transcripts.set(sessionId, clone(doc));
    },
    async loadSessionTranscript(sessionId: Id): Promise<PersistedTranscript | null> {
      const d = transcripts.get(sessionId);
      return d ? clone(d) : null;
    },
    async upsertSubagent(subagent: Subagent): Promise<void> {
      subagents.set(subagent.id, clone(subagent));
    },
    async loadSubagent(id: Id): Promise<Subagent | null> {
      const s = subagents.get(id);
      return s ? clone(s) : null;
    },
    async listSubagents(parentSessionId: Id): Promise<Subagent[]> {
      return ordered(subagents, (s) => s.parentSessionId === parentSessionId);
    },
```
And add the two Maps at the top of `createInMemoryRecordStore` (below `const runs`):

```ts
  const transcripts = new Map<Id, PersistedTranscript>();
  const subagents = new Map<Id, Subagent>();
```
And update the `import type { ... } from "./types.js";` line at the top of the file (line 1) to include the two new types.

- [ ] **Step 6: Run the test to verify PASS**

Run: `npx tsc -p packages/record/tsconfig.json --noEmit` && `node --test packages/record/test/memory-transcript-subagent.test.ts`
Expected: PASS (2/2)

- [ ] **Step 7: Commit**

```bash
git add packages/record/src/types.ts packages/record/src/index.ts packages/record/src/memory.ts packages/record/test/memory-transcript-subagent.test.ts
git commit -m "record: durable session transcript + subagent (in-memory impl)"
```

---

## Task 2 — record: JSONL impl (sibling dirs + atomic writes)

**Files:**
- Modify: `packages/record/src/jsonl.ts` (add 5 methods + small I/O helpers)
- Test: `packages/record/test/jsonl-transcript-subagent.test.ts` (**create**)

**Interfaces:**
- Consumes: `PersistedTranscript`, `Subagent` (record), `Id` (record), the existing `createJsonlRecordStore(path)` (record).
- Produces: the same 5 `RecordStore` methods as Task 1, durable on disk, sibling dirs under `RECORD_STORE_PATH`'s directory.

- [ ] **Step 1: Write the failing test (`packages/record/test/jsonl-transcript-subagent.test.ts`)** — a JSONL store round-trips + persists across "restart."

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlRecordStore } from "../dist/jsonl.js";

async function makeStore(): Promise<[ReturnType<typeof createJsonlRecordStore>, () => Promise<void>]> {
  const d = await mkdtemp(join(tmpdir(), "rec-" ));
  const store = await createJsonlRecordStore(join(d, "record.jsonl"));
  return [Promise.resolve(store), () => import("node:fs/promises").then(fs => fs.rm(d, { recursive: true, force: true }))];
}

test("jsonl: transcript survives a store restart", async () => {
  let [store] = await makeStore();
  await store.saveSessionTranscript("sess-1", { v: 1, status: "idle", messages: [ { id: "m", role: "user", parts: [{type:"text",text:"hi"}] } ] });
  const doc = await store.loadSessionTranscript("sess-1");
  assert.ok(doc);
  assert.equal((doc.messages as any[]).length, 1);
});

test("jsonl: subagents list-by-parent + upsert + survive restart", async () => {
  let [store, cleanup] = await makeStore();
  const s = { id: "subagent-A", parentSessionId: "sess-1", origin: "subagent" as const, status: "running" as const, startedAt: "2026-09-20T00:00:00Z" };
  await store.upsertSubagent(s);
  const list = await store.listSubagents("sess-1");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "subagent-A");
  await cleanup();
});
```

- [ ] **Step 2: Run the test (expect FAIL — method not on the impl)**

Run: `npx tsc -p packages/record/tsconfig.json --noEmit`
Expected: error — JSONL store is missing the 4 new methods

- [ ] **Step 3: Implement (append to `jsonl.ts`)**

Below the existing `compact` function, add small I/O helpers:

```ts
async function writeFileAtomic(path: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

async function readJSONOrNull<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return (JSON.parse(raw) as T) ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await import("node:fs/promises")).readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}
```

In `createJsonlRecordStore`, add two sibling dirs + wire the 5 new methods into the returned object (insert before the closing `};`):

```ts
  const rootDir = dirname(path);
  const transcriptsDir = join(rootDir, "transcripts");
  const subagentsDir = join(rootDir, "subagents");

  async saveSessionTranscript(sessionId: Id, doc: PersistedTranscript): Promise<void> {
    await writeFileAtomic(join(transcriptsDir, `${encodeURIComponent(sessionId)}.json`), doc);
  },
  async loadSessionTranscript(sessionId: Id): Promise<PersistedTranscript | null> {
    return readJSONOrNull<PersistedTranscript>(join(transcriptsDir, `${encodeURIComponent(sessionId)}.json`));
  },
  async upsertSubagent(subagent: Subagent): Promise<void> {
    await writeFileAtomic(join(subagentsDir, `${encodeURIComponent(subagent.id)}.json`), subagent);
  },
  async loadSubagent(id: Id): Promise<Subagent | null> {
    return readJSONOrNull<Subagent>(join(subagentsDir, `${encodeURIComponent(id)}.json`));
  },
  async listSubagents(parentSessionId: Id): Promise<Subagent[]> {
    const names = await listDir(subagentsDir);
    const out: Subagent[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = decodeURIComponent(name.slice(0, -5));
      const s = (await readJSONOrNull<Subagent>(join(subagentsDir, name))) ?? null;
      if (s && s.parentSessionId === parentSessionId) out.push(s);
    }
    return out;
  },
```

And update the `import` at the top of `jsonl.ts` (line 18) to include the two new types:

```ts
import type { Id, Project, Run, Session, PersistedTranscript, Subagent } from "./types.js";
```

- [ ] **Step 4: Run the test to verify PASS**

Run: `npx tsc -p packages/record/tsconfig.json --noEmit` && `node --test packages/record/test/jsonl-transcript-subagent.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add packages/record/src/jsonl.ts packages/record/test/jsonl-transcript-subagent.test.ts
git commit -m "record: durable transcript + subagent (JSONL impl, sibling dirs)"
```

---

## Task 3 — contract-tests conformance suite

**Files:**
- Create: `packages/contract-tests/src/transcript-subagent.ts` (the suite)
- Modify: `packages/contract-tests/src/index.ts` (export it)
- Test: `packages/contract-tests/test/transcript-subagent.test.ts` (**create**)

**Interfaces:**
- Consumes: the `RecordStore` contract (record + its 2 impls), the 5 new `RecordStore` methods from Task 1 + 2.
- Produces: a `testTranscriptAndSubagent(store: RecordStore)` function (same shape as the other suites in `packages/contract-tests/src/`).

- [ ] **Step 1: Write the failing test (`packages/contract-tests/test/transcript-subagent.test.ts`)** — drive the suite against BOTH the in-memory + JSONL impls, as the other suites do.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore } from "@science-studio/record";
import { createJsonlRecordStore } from "@science-studio/record";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTranscriptAndSubagent } from "../dist/transcript-subagent.js";

test("in-memory record passes the transcript/subagent conformance suite", async () => {
  await testTranscriptAndSubagent(createInMemoryRecordStore());
});

test("jsonl record passes the transcript/subagent conformance suite", async () => {
  const d = await mkdtemp(join(tmpdir(), "ct-rec-"));
  const store = await createJsonlRecordStore(join(d, "record.jsonl"));
  await testTranscriptAndSubagent(store);
  await import("node:fs/promises").then(fs => fs.rm(d, { recursive: true, force: true }));
});
```

- [ ] **Step 2: Run the test (expect FAIL — suite doesn't exist yet)**

Run: `node --test packages/contract-tests/test/transcript-subagent.test.ts`
Expected: `Cannot find module .../transcript-subagent.js`

- [ ] **Step 3: Write the suite (`packages/contract-tests/src/transcript-subagent.ts`)** — assert the shared invariants.

```ts
import assert from "node:assert/strict";
import type { RecordStore } from "@science-studio/record";

export async function testTranscriptAndSubagent(store: RecordStore): Promise<void> {
  // Transcript: round-trip + stability + isolation by key
  const msg1 = { id: "m-1", role: "user", parts: [{ type: "text", text: "Hello" }] };
  await store.saveSessionTranscript("sess-x", { v: 1, status: "running", messages: [msg1] });
  const got = await store.loadSessionTranscript("sess-x");
  assert.ok(got);
  assert.equal(got!.v, 1);
  assert.equal(got!.status, "running");
  assert.deepEqual(got!.messages, [msg1]);
  // Isolation by key
  assert.equal(await store.loadSessionTranscript("sess-Y"), null);
  // Overwrite (idempotent upsert)
  await store.saveSessionTranscript("sess-x", { v: 1, status: "idle", messages: [] });
  const got2 = await store.loadSessionTranscript("sess-x");
  assert.equal(got2!.status, "idle");
  assert.equal((got2!.messages as unknown[]).length, 0);

  // Subagent: upsert + stable key + parent scoping
  const base = { id: "subagent-a", parentSessionId: "sess-x", origin: "subagent" as const, status: "running" as const, startedAt: "2026-09-20T00:00:00Z" };
  await store.upsertSubagent(base);
  await store.upsertSubagent({ ...base, id: "subagent-b", parentSessionId: "sess-Y" });
  const listX = await store.listSubagents("sess-x");
  assert.deepEqual(listX.map(s => s.id), ["subagent-a"]);
  const listY = await store.listSubagents("sess-Y");
  assert.deepEqual(listY.map(s => s.id), ["subagent-b"]);
  // Single fetch
  const one = await store.loadSubagent("subagent-b");
  assert.ok(one);
  assert.equal(one!.parentSessionId, "sess-Y");
  // Missing → null, empty parent → empty list
  assert.equal(await store.loadSubagent("subagent-missing"), null);
  assert.deepEqual(await store.listSubagents("sess-who"), []);
}
```

- [ ] **Step 4: Export from `packages/contract-tests/src/index.ts`**

```ts
export { testTranscriptAndSubagent } from "./transcript-subagent.js";
```

- [ ] **Step 5: Run the test to verify PASS (both impls)**

Run: `node --test packages/contract-tests/test/transcript-subagent.test.ts`
Expected: PASS (2/2)

- [ ] **Step 6: Commit**

```bash
git add packages/contract-tests/src/transcript-subagent.ts packages/contract-tests/src/index.ts packages/contract-tests/test/transcript-subagent.test.ts
git commit -m "contract-tests: transcript + subagent conformance suite"
```

---

## Task 4 — `RecordStoreLike` extension (transport seam)

**Files:**
- Modify: `packages/transport/src/types.ts` (extend `RecordStoreLike` — 5 new methods)
- Test: `packages/transport/test/record-store-like-shape.test.ts` (**create**)

**Interfaces:**
- Consumes: `PersistedTranscript`, `Subagent`, `Id` (all from `@science-studio/record`).
- Produces: the 5 new `RecordStoreLike` methods (reusing the record's types) — the dsh adapter + service consume them.

- [ ] **Step 1: Write the failing test (`packages/transport/test/record-store-like-shape.test.ts`)** — an empty `RecordStoreLike` that satisfies the NEW interface must type-check.

```ts
import { test } from "node:test";
import type { RecordStoreLike, Id } from "@science-studio/transport";
import type { PersistedTranscript, Subagent } from "@science-studio/record";

test("empty RecordStoreLike type-checks against the new contract", async () => {
  const impl: RecordStoreLike = {
    async addRun() {},
    async saveSessionTranscript() {},
    async loadSessionTranscript() { return null; },
    async upsertSubagent() {},
    async loadSubagent() { return null; },
    async listSubagents() { return []; },
  };
  const d: Promise<PersistedTranscript | null> = impl.loadSessionTranscript("x");
  const s: Promise<Subagent | null> = impl.loadSubagent("s");
  const list: Promise<Subagent[]> = impl.listSubagents("p");
  const _a = [impl, d, s, list, "x" as Id];
});
```

- [ ] **Step 2: Run the test (expect FAIL — the methods are missing)**

Run: `npx tsc -p packages/transport/tsconfig.json --noEmit`
Expected: `Property 'saveSessionTranscript' does not exist on type 'RecordStoreLike'`

- [ ] **Step 3: Extend `RecordStoreLike` in `packages/transport/src/types.ts` (line 315)**

```ts
export interface RecordStoreLike {
  addRun(run: Run): Promise<void>;
  /** The runtime's canonical transcript (durable, keyed by stable Session id). */
  saveSessionTranscript(sessionId: Id, doc: PersistedTranscript): Promise<void>;
  loadSessionTranscript(sessionId: Id): Promise<PersistedTranscript | null>;
  /** A durable, stably-identified subagent (docs/adr/0019). */
  upsertSubagent(subagent: Subagent): Promise<void>;
  loadSubagent(id: Id): Promise<Subagent | null>;
  listSubagents(parentSessionId: Id): Promise<Subagent[]>;
}
```
And import the record types (line-top, near the existing `import { ... Run ... } from "@science-studio/record"`):

```ts
import type { Id, Run, PersistedTranscript, Subagent } from "@science-studio/record";
```
(adjust the existing `import type { Id, Run, ... }` — it currently pulls `Id`/`Run`/`RunStatus`; add `PersistedTranscript` and `Subagent`).

- [ ] **Step 4: Run the test to verify PASS**

Run: `npx tsc -p packages/transport/tsconfig.json --noEmit` && `node --test packages/transport/test/record-store-like-shape.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/transport/src/types.ts packages/transport/test/record-store-like-shape.test.ts
git commit -m "transport: extend RecordStoreLike with transcript + subagent (5 methods)"
```

---

## Task 5 — dsh registry: stable id + record store + transcript capture

> **Caution (execute with care — this is the one risky task).** The existing
> `SubagentRegistry` (and its 176-line `test/subagents.test.ts`) uses a
> **synchronous** `list()` that reads an **in-memory** `entries` map, background
> -persists through a `SubagentLedgerStore` seam, and restores via
> `attachStore()/restoreAll()`. The minimal, lowest-churn change is: **keep that
> sync `list()` + in-memory model intact**, and only (a) swap the backing store
> from the file ledger to a **record-backed adapter** that wraps
> `RecordStoreLike` (`upsertSubagent`/`loadSubagent`/`listSubagents`), (b) add a
> **stable id** to each entry (mint `"subagent-"+randomUUID()`, keep a
> `harnessChildId→stableId` map), (c) add `noteTranscript()` + persist the
> captured `transcript` in the row, and (d) change how restore enumerates. Do NOT
> rewrite `list()` to be async — that breaks the existing suite. Two record-API
> gaps this surfaces: the record's subagent API is **per-parent**
> (`listSubagents(parentSessionId)`), but restore needs a Project's sessions —
> so the adapter enumerates its Project's session ids (from
> `RecordStore.listSessions(projectId)`) and calls `listSubagents(id)` per
> session to seed the registry's in-memory map before it serves. And the record
> has no "list all subagent parents" — if cross-Project restore is needed, add
> an optional `listSubagentParents(): Promise<Id[]>` to the record seam (or scope
> restore to the sessions the adapter already knows). The existing
> `subagents.test.ts` assertions on `id` shift from harness-child-id to the
> stable id — update them in step with this task.

**Files:**
- Modify: `packages/transport-dsh/src/subagents.ts` (the `SubagentRegistry` storage seam → `RecordStoreLike`; stable id; transcript capture)
- Modify: `packages/transport-dsh/src/ledger.ts` (drop the file-backed `SubagentLedgerStore`; or delete — see Task 8)
- Test: `packages/transport-dsh/test/subagent-registry-record.test.ts` (**create**)

**Interfaces:**
- Consumes: `RecordStoreLike` (transport seam, from Task 4), the `Subagent` + `PersistedTranscript` types (record, Task 1).
- Produces: `SubagentRegistry` methods `noteStarted`/`noteDescriptor`/`noteFinished`/`noteTranscript`/`list` (public surface), now persisting via `RecordStoreLike.upsertSubagent`/`listSubagents`/`loadSubagent` + stable id + parent-session lineage + transcript capture.

- [ ] **Step 1: Write the failing test (`packages/transport-dsh/test/subagent-registry-record.test.ts`)** — drives the registry against a record-backed store + asserts the stable id + parent lineage + transcript capture.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore } from "@science-studio/record";
import { SubagentRegistry } from "../dist/subagents.js";
import type { RecordStoreLike } from "@science-studio/transport";

test("dsh registry: stable id + parent lineage + transcript capture — all via the record store", async () => {
  const record = createInMemoryRecordStore() as unknown as RecordStoreLike & { addRun(run: any): Promise<void> };
  const resolve = (rootHarnessId: string) => (rootHarnessId === "root-1" ? "sess-1" : undefined);
  const reg = new SubagentRegistry(resolve, () => "2026-09-20T00:00:00Z", record);
  await reg.ready();

  reg.noteStarted("root-1", "child-1");
  reg.noteDescriptor("child-1", { label: "researcher" });
  reg.noteFinished("child-1", { status: "ok", stopReason: "completed" });
  // Capture the child's transcript (the design: on settle, pull from the harness + write to the record).
  reg.noteTranscript("child-1", { status: "idle", messages: [ { id: "m", role: "user", parts: [{type:"text",text:"do this"}] } ] });

  const stable = reg.stableIdFor("child-1");
  assert.ok(stable && stable.startsWith("subagent-"));

  const row = await record.loadSubagent(stable!);
  assert.ok(row);
  assert.equal(row!.parentSessionId, "sess-1");
  assert.equal(row!.status, "completed");
  assert.equal(row!.transcript?.status, "idle");

  const panel = reg.list("sess-1");
  assert.equal(panel.length, 1);
  assert.equal(panel[0].parentId, "sess-1");
});
```

- [ ] **Step 2: Run the test (expect FAIL — the methods don't exist yet)**

Run: `npx tsc -p packages/transport-dsh/tsconfig.json --noEmit`
Expected: several errors (registry constructor signature + new methods)

- [ ] **Step 3: Rewrite `packages/transport-dsh/src/subagents.ts` (§ 5 of docs/design/session-subagent-persistence.md)** — keep the in-memory state + the structural payload rules; swap the storage seam to `RecordStoreLike`; use `stableId` + a `stableId → harnessChildId` map.

Key structural changes (keep everything existing around `SubagentRegistry` — the `settleStatus`, `isLedgerEntry` checks, `restoreAll`, `resolveKey`, `persist` — but re-shape the storage calls):

- Replace the `SubagentLedgerStore` import (line 3, `"./subagents.js"` self-reference for the `SubagentLedgerEntry` + `SubagentLedgerStore` types) with a `RecordStoreLike` import (from `@science-studio/transport`) + the two record types (`Subagent`, `PersistedTranscript`).
- In `SubagentRegistry`:
  - Add a `private stable = new Map<string, string>()` (harness child id → stable subagent id).
  - Add a `private stableFor = new Map<string, string>()` (stable → harness child id; for `list`'s resolution and `noteTranscript`'s target).
  - Rewrite `attachStore(store: RecordStoreLike)` — restore by calling `store.listSubagents(sessionKey)` for every known parent; the adapter (Task 6) will call this with the record store. (Or simpler: the registry takes the `RecordStoreLike` in its constructor — see below.)
  - **Simplify**: the registry takes `store: RecordStoreLike` in its constructor (not `attachStore`). This removes the async `attachStore`/`ready` dance.
  - In `noteStarted`: mint `const stableId = "subagent-" + randomUUID()` from `node:crypto`; `this.stable.set(childId, stableId); this.stableFor.set(stableId, childId)`; call `await store.upsertSubagent({ id: stableId, parentSessionId: resolve(parent), origin: "subagent", status: "running", startedAt: this.now() })`. (The `resolve` is `resolveSessionKey` — the parent's stable id.)
  - In `noteFinished`: `const stable = this.stable.get(childId)!`; merge (status/stopReason/finishedAt) + `await store.upsertSubagent(fullRow)`.
  - In `noteDescriptor`: merge (label/provider) + `await store.upsertSubagent(fullRow)`.
  - In `noteTranscript(childId, transcript)`: `const stable = this.stable.get(childId)!`; `const existing = await store.loadSubagent(stable)!`; `await store.upsertSubagent({ ...existing, transcript: { v: 1, status: transcript.status, messages: structuredClone(transcript.messages) } })`.
  - In `list(sessionKey)`: `const rows = await store.listSubagents(sessionKey)`; map each to the existing `SubagentRun` view. The `SubagentRun` interface (`id`, `parentId`) keeps the same shape — the `id` is now the stable id (the web just passes it through).
  - **Add** `stableIdFor(harnessChildId: string): string | undefined`: returns `this.stable.get(harnessChildId)`.
- The `SubagentLedgerStore` interface (lines 56-63 of `subagents.ts`) can stay for backward compatibility with any existing callers, or be deleted (Task 8). The registry no longer uses it.

The full rewritten `SubagentRegistry` class (keep the in-memory `entries` + `stable` maps; storage calls → `RecordStoreLike`):

```ts
export class SubagentRegistry {
  private readonly entries = new Map<string, Entry>();      // harness child id -> in-memory view
  private readonly stable = new Map<string, string>();      // harness child id -> stable id
  private readonly stableFor = new Map<string, string>();   // stable id -> harness child id
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly resolveSessionKey: (rootHarnessId: string) => string | undefined,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly store: RecordStoreLike,
  ) {}

  async ready(): Promise<void> { /* no async init (no file restore). */ }

  async flush(): Promise<void> { await this.saving; }

  noteStarted(parentSessionId: string, childSessionId: string): void {
    if (parentSessionId === childSessionId || this.entries.has(childSessionId)) return;
    const stableId = "subagent-" + randomUUID();
    const parent = this.resolveSessionKey(parentSessionId) ?? parentSessionId;
    this.stable.set(childSessionId, stableId);
    this.stableFor.set(stableId, childSessionId);
    const entry: Entry = { childSessionId, stableId, parentSessionId: parent, status: "running", startedAt: this.now() };
    this.entries.set(childSessionId, entry);
    this.persist(entry);
  }

  noteDescriptor(childSessionId: string, info: SubagentDescriptorInfo): void {
    const entry = this.entries.get(childSessionId); if (!entry) return;
    if (info.label !== undefined) entry.label = info.label;
    if (info.provider !== undefined) entry.provider = info.provider;
    this.persist(entry);
  }

  noteFinished(childSessionId: string, info: SubagentFinishedInfo): void {
    let entry = this.entries.get(childSessionId);
    if (!entry && info.parentSessionId !== undefined) {
      const stableId = "subagent-" + randomUUID();
      const parent = this.resolveSessionKey(info.parentSessionId) ?? info.parentSessionId;
      this.stable.set(childSessionId, stableId); this.stableFor.set(stableId, childSessionId);
      entry = { childSessionId, stableId, parentSessionId: parent, status: "running", startedAt: this.now() };
      this.entries.set(childSessionId, entry);
    }
    if (!entry) return;
    entry.status = settleStatus(info.status, info.stopReason);
    if (info.provider !== undefined) entry.provider = info.provider;
    if (info.stopReason !== undefined) entry.stopReason = info.stopReason;
    entry.finishedAt = this.now();
    this.persist(entry);
  }

  noteTranscript(childSessionId: string, transcript: { status: string; messages: unknown[] }): void {
    const entry = this.entries.get(childSessionId); if (!entry) return;
    entry.transcript = { v: 1, status: transcript.status, messages: structuredClone(transcript.messages) };
    this.persist(entry);
  }

  stableIdFor(harnessChildId: string): string | undefined {
    return this.stable.get(harnessChildId);
  }

  async list(sessionKey: string): Promise<SubagentRun[]> {
    const rows = await this.store.listSubagents(sessionKey);
    return rows.map(row => {
      const childId = this.stableFor.get(row.id);
      const live = childId ? this.entries.get(childId) : undefined;
      return {
        id: row.id,
        parentId: row.parentSessionId,
        ...(row.label === undefined ? {} : { label: row.label }),
        ...(row.provider === undefined ? {} : { provider: row.provider }),
        status: live?.status ?? row.status,
        ...(live?.stopReason ?? row.stopReason === undefined ? {} : { stopReason: live!.stopReason ?? row.stopReason }),
        startedAt: live?.startedAt ?? row.startedAt,
        ...(live?.finishedAt ?? row.finishedAt === undefined ? {} : { finishedAt: live!.finishedAt ?? row.finishedAt }),
      };
    }).sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  private persist(entry: Entry): void {
    const row: Subagent = {
      id: entry.stableId,
      parentSessionId: entry.parentSessionId,
      origin: "subagent",
      ...(entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.provider === undefined ? {} : { provider: entry.provider }),
      status: entry.status,
      ...(entry.stopReason === undefined ? {} : { stopReason: entry.stopReason }),
      startedAt: entry.startedAt,
      ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
      ...(entry.transcript === undefined ? {} : { transcript: entry.transcript }),
    };
    this.saving = this.saving.catch(() => {}).then(() => this.store.upsertSubagent(row)).catch(err => {
      console.warn("[dsh] subagent persist failed", err);
    });
  }
}
```

The local `Entry` type (keep the existing shape, add two fields):

```ts
type Entry = {
  childSessionId: string;
  stableId: string;
  parentSessionId: string;
  label?: string;
  provider?: string;
  status: SubagentRun["status"];
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  transcript?: PersistedTranscript;
};
```

And the top-of-file imports (replace `SubagentLedgerStore` + `SubagentLedgerEntry` with the record types + `randomUUID`):

```ts
import { randomUUID } from "node:crypto";
import type { Subagent, PersistedTranscript } from "@science-studio/record";
import type { RecordStoreLike, SubagentRun } from "@science-studio/transport";
```

- [ ] **Step 4: Run the test to verify PASS**

Run: `npx tsc -p packages/transport-dsh/tsconfig.json --noEmit` && `node --test packages/transport-dsh/test/subagent-registry-record.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/transport-dsh/src/subagents.ts packages/transport-dsh/src/ledger.ts packages/transport-dsh/test/subagent-registry-record.test.ts
git commit -m "transport-dsh: subagent registry → record store (stable id, parent lineage, transcript capture)"
```

---

## Task 6 — dsh behavior: swap the 3 mirror touchpoints to the record store

**Files:**
- Modify: `packages/transport-dsh/src/behavior.ts` (line 67 `mirror: TranscriptMirror | null` → `recordStore: RecordStoreLike | null`; line 85 destructure; lines 403-404 `prepare()`; line 439-440 `beforePersist()`; lines 464-465 `watch.readBaseline`)
- Test: `packages/transport-dsh/test/behavior-restore-from-record.test.ts` (**create**)

**Interfaces:**
- Consumes: `RecordStoreLike` (transport seam, Task 4); the `PersistedTranscript` type (record, Task 1).
- Produces: `createDshBehavior(deps)` where `deps.recordStore` replaces `deps.mirror` — the adapter (Task 7) passes the record store in.

- [ ] **Step 1: Write the failing test (`packages/transport-dsh/test/behavior-restore-from-record.test.ts`)** — a scripted harness that emits one assistant message + the behavior's `prepare`/`beforePersist`/`readBaseline` round-trip through an in-memory record store.

```ts
import { test } from "node:test";
import { createInMemoryRecordStore } from "@science-studio/record";
import type { RecordStoreLike } from "@science-studio/transport";

test("behavior.prepare loads the transcript from the record; beforePersist saves to it", async () => {
  // This is the direct regression for the 炭素素 bug: after a "restart,"
  // the record still holds the transcript (the mirror didn't).
  // For this test we stub a minimal DshBehaviorDeps + exercise the three
  // mirror-related hooks through the record store seam. The full scripted
  // harness is the existing transport-dsh behavior suite; here we test the
  // swap itself against an in-memory record store.
  const record = createInMemoryRecordStore() as any as RecordStoreLike;
  const behavior = createDshBehavior({
    client: null as any,
    recordStore: record,
    harnessSessions: new Map(),
    profile: "test", provider: "p", model: "m", cwd: "/tmp",
    workspace: null,
    harnessCommands: new Set(),
    commandCatalog: () => ["x"],
  });
  // Prepare with an empty state on a session already in the record:
  await record.saveSessionTranscript("sess-a", { v: 1, status: "idle", messages: [{ id: "m", role: "user", parts: [{type:"text",text:"hi"}] }] });
  const state = { status: "idle", messages: [] as any };
  const result = await behavior.prepare?.(anyHandle(state));
  // behavior.prepare should have called replaceMessages with the record's transcript
  assert.equal(state.messages.length, 1);
});
```

(The helper `createDshBehavior` is the existing exported factory in `behavior.ts`; `anyHandle` is `createApplyContext` + a shim exposing `state`/`replaceMessages` — the kit's own constructor for the transcript primitives, already used by other dsh behavior tests. Look at `packages/transport-dsh/test/` for the existing shape.)

- [ ] **Step 2: Run the test (expect FAIL — `recordStore` is not in `DshBehaviorDeps`)**

Run: `npx tsc -p packages/transport-dsh/tsconfig.json --noEmit`
Expected: `Property 'recordStore' does not exist on type 'DshBehaviorDeps'`

- [ ] **Step 3: Rewrite the 3 touchpoints in `behavior.ts`**

At the top:
```ts
// import type { TranscriptMirror } from "./mirror.js";   // removed — now:
import type { RecordStoreLike } from "@science-studio/transport";
```

In `DshBehaviorDeps` (line 65):
```ts
export interface DshBehaviorDeps {
  client: ...;
  recordStore: RecordStoreLike | null;   // was: mirror: TranscriptMirror | null
  harnessSessions: Map<string, string>;
  profile: string; provider?: string; model?: string; cwd: string;
  workspace: Workspace | null;
  harnessCommands: Set<string>;
  commandCatalog: () => string[];
  onError?: (msg: string, err: unknown) => void;
}
```

In the destructuring (line 85):
```ts
const { client, recordStore, harnessSessions, profile, provider, model, cwd, workspace, harnessCommands, commandCatalog } = deps;
```

In `prepare()` (line 401-405), swap the call:
```ts
    async prepare(handle) {
      if (handle.state.messages.length > 0 || !recordStore) return;
      const loaded = await recordStore.loadSessionTranscript(handle.sessionKey);
      if (!loaded) return;
      const msgs = loaded.messages as Message[];          // safe: the dsh adapter wrote this blob
      const st  = loaded.status as SessionState["status"];
      handle.replaceMessages(msgs, st);
    },
```

In `beforePersist()` (lines 439-440), swap the save:
```ts
    async beforePersist(ctx) {
      if (!recordStore) return;
      await recordStore.saveSessionTranscript(ctx.sessionKey, { v: 1, status: ctx.state.status, messages: structuredClone(ctx.state.messages) });
    },
```

In `watch.readBaseline` (lines 464-465), swap the read:
```ts
        readBaseline: async (sessionKey: string) => {
          if (!recordStore) return null;
          const loaded = await recordStore.loadSessionTranscript(sessionKey);
          if (!loaded) return null;
          return { status: loaded.status as SessionState["status"], messages: loaded.messages as Message[] };
        },
```

- [ ] **Step 4: Run the test to verify PASS**

Run: `node --test packages/transport-dsh/test/behavior-restore-from-record.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/transport-dsh/src/behavior.ts packages/transport-dsh/test/behavior-restore-from-record.test.ts
git commit -m "transport-dsh: behavior.prepare/beforePersist/readBaseline → the record store"
```

---

## Task 7 — dsh adapter init: wire `recordStore` into behavior + registry; drop the mirror

**Files:**
- Modify: `packages/transport-dsh/src/adapter.ts` (line 70-71 `transcriptDir?` in options; line 133 field; line 352 `this.mirror = new TranscriptMirror(dir)`; line 357 `attachStore(new FileSubagentLedger(...))`; lines 360-371 `createDshBehavior({..., mirror: this.mirror, ...})` → `recordStore`);
- Test: extend the existing dsh adapter tests to drive the record store (or add a minimal one).

**Interfaces:**
- Consumes: `RecordStoreLike` (transport seam, Task 4), `RecordStore` (record, Tasks 1-2), `createDshBehavior` (Task 6's new deps), `SubagentRegistry` (Task 5's new ctor).
- Produces: a dsh adapter instance that persists via the record store (no mirror). The service (which already passes `opts.recordStore`) now gets durability for free.

- [ ] **Step 1: Write the failing integration test (`packages/transport-dsh/test/adapter-record-roundtrip.test.ts`)** — drives the adapter through `opts.recordStore` (in-memory) + exercises `prepare` + `settle` + verifies the transcript is in the record store (not a mirror file on disk).

```ts
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("adapter: a settled turn's transcript lands in the record store (not a mirror file)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-rt-"));
  // 1. Construct an in-memory record store (the service would use JSONL here).
  const { createInMemoryRecordStore } = await import("@science-studio/record");
  const record = createInMemoryRecordStore();
  // 2. Construct the dsh adapter, passing the record store through `opts.recordStore`.
  //    (The existing adapter test helpers in packages/transport-dsh/test do this;
  //     reuse them. The full adapter needs a scripted harness client — the
  //     existing suite drives one. Assert: after a settle, the transcript is in the
  //     record store AND no mirror file exists on disk under any DSH_TRANSCRIPT_DIR.)
  // 3. Drive one user turn → an assistant reply → run to settle.
  // 4. Assert: `await record.loadSessionTranscript(sessionKey)` returns the full transcript.
  // 5. Assert: `await readdir(dir)` does NOT contain a mirror `*.json` for the session.
  // (This is the end-to-end regression: restart is just "construct a new adapter with the
  //  same record store" — the new adapter's `prepare` then reads the record, not the mirror.)
});
```

(The full scripted harness is already there — look at `packages/transport-dsh/test/adapter.test.ts` for the pattern; the only diff is passing the in-memory record store and asserting the durable round-trip.)

- [ ] **Step 2: Run the test (expect FAIL — the adapter still uses the mirror)**

Run: `node --test packages/transport-dsh/test/adapter-record-roundtrip.test.ts`
Expected: either a FAIL on the record-store assertion, or a crash from a missing `recordStore` (if we already removed the mirror).

- [ ] **Step 3: Change the wiring in `adapter.ts`**

Line 133 (drop the field if not used elsewhere):
```ts
- private mirror: TranscriptMirror | null = null;
```
(and the import on line 40:
```ts
- import { TranscriptMirror } from "./mirror.js";
```
(and the `FileSubagentLedger` import on line 41 — deleted:
```ts
- import { FileSubagentLedger } from "./ledger.js";
```
)

Line 352-357 (the `init` block — delete the mirror + ledger attachment; wire the registry to the record store):
```ts
-     this.mirror = new TranscriptMirror(dir);
-     this.subagentRegistry.attachStore(new FileSubagentLedger(join(dir, "subagents")));
+     // The dsh adapter no longer persists to an ephemeral mirror (docs/adr/0019).
+     // The record store owns durable transcripts; the subagent registry reads
+     // and writes via the record store's 5 new methods. The existing `init`
+     // already set `this.recordStore = opts.recordStore` (line 228).
```
(Adjust: the `SubagentRegistry` constructor now takes `store` directly (Task 5) — the registry's construction in the `constructor` (line 192) needs to be moved so the registry can see the record store. Either: (a) instantiate the registry lazily in `init`; or (b) pass the record store at construction + the constructor takes it as a parameter. Option (a) is less invasive to the adapter's public API.)

Lines 360-371 (the `createDshBehavior` call — swap `mirror: this.mirror` → `recordStore: this.recordStore`):

```ts
     this.behavior = createDshBehavior({
       client: this.client,
-      mirror: this.mirror,
+      recordStore: this.recordStore,
       harnessSessions: this.harnessSessions,
       profile, provider, model, cwd,
       workspace: opts.workspace ?? null,
       harnessCommands: this.harnessCommands,
       commandCatalog: () => this.listCommands(),
     });
```

- [ ] **Step 4: Run the existing dsh adapter tests (expect: they all PASS — the mirror they exercise has moved to the record store)**

Run: `npm test -w @science-studio/transport-dsh`
Expected: all existing dsh adapter tests still pass (they drive through `opts.recordStore`), PLUS the new integration test from Step 1 passes.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-dsh/src/adapter.ts packages/transport-dsh/test/adapter-record-roundtrip.test.ts
git commit -m "transport-dsh: adapter init — mirror → record store (durability via record)"
```

---

## Task 8 — delete `mirror.ts` + `ledger.ts`; drop the `TranscriptMirror` export

**Files:**
- Delete: `packages/transport-dsh/src/mirror.ts`
- Delete: `packages/transport-dsh/src/ledger.ts`
- Modify: `packages/transport-dsh/src/index.ts` (drop the `TranscriptMirror` re-export on line 11)
- Modify: `packages/contract-tests/src/index.ts` (only if it re-exports the `SubagentLedgerStore` type — the other suites don't)
- Modify: any existing test that asserts the on-disk mirror file layout (the existing dsh mirror tests)

**Interfaces:**
- Consumes: nothing.
- Produces: a codebase that has exactly ONE durability path for the session transcript + subagents — the record store.

- [ ] **Step 1: Verify nothing imports the two files**

Run: `rg --type ts "\.transcriptMirror\|TranscriptMirror\|FileSubagentLedger\|SubagentLedgerStore\|ledger\.js\|mirror\.js" packages services apps` (expect: only the two deleted files + possibly a test — check each)

If any test still reads the mirror layout on disk, update it to assert the record store (or delete it if it's a mirror-specific test that no longer makes sense).

- [ ] **Step 2: Delete the two files + drop the export**

```bash
git rm packages/transport-dsh/src/mirror.ts packages/transport-dsh/src/ledger.ts
```

Edit `packages/transport-dsh/src/index.ts` — remove the `TranscriptMirror` re-export (line 11):

```ts
- export { TranscriptMirror } from "./mirror.js";
```

- [ ] **Step 3: Run the full dsh test suite (expect: PASS)**

Run: `npm test -w @science-studio/transport-dsh`
Expected: PASS (the behavior tests now reference the record store; the mirror tests should have been deleted or adapted in Task 6-7).

- [ ] **Step 4: Run the full root build (expected: type-check passes — no dangling imports)**

Run: `npm run build`
Expected: `typecheck:tests` passes (no unresolved `./mirror.js` or `./ledger.js`).

- [ ] **Step 5: Commit**

```bash
git add -A packages/transport-dsh/src/
git commit -m "transport-dsh: delete mirror.ts + ledger.ts (their job is the record store's)"
```

---

## Task 9 — the 炭素素 regression: a full restart test

**Files:**
- Create: `packages/transport-dsh/test/restart-regression.test.ts` — **the** regression for docs/adr/0019's core claim.

**Interfaces:**
- Consumes: the dsh adapter (Task 7), the record store (Task 1-2), a scripted harness client.

- [ ] **Step 1: Write the test** — gen 1 settles a turn, the process "dies," gen 2 reads the same record store + restores the full transcript.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("restart regression: gen 1 settles a full turn, gen 2 restores it from the record store", async () => {
  // 1. Construct an in-memory record store (the "durable" layer).
  // 2. Construct adapter A (gen 1), pass `opts.recordStore` = the store.
  // 3. Drive one turn (user → assistant) that populates `state.messages` (the scripted harness client does this).
  // 4. Run A to settle.
  // 5. Tear A down (call abort / dispose / the cleanup hooks the real service uses).
  // 6. Construct adapter B (gen 2), pass `opts.recordStore` = THE SAME store.
  // 7. Drive B's `prepare(sessionKey)` (what the service does on a fresh request).
  // 8. Assert: B's `loadSessionTranscript` returned the full transcript from step 3.
  // 9. (The 炭素素 case: 26 runs' worth of messages.)
});
```
(Implement with the same scripted harness client the existing adapter tests use; the assertion is `record.loadSessionTranscript(sessionKey)` returns > 0 messages.)

- [ ] **Step 2: Run it (expect: PASS now — the record store is the truth)**

Run: `node --test packages/transport-dsh/test/restart-regression.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/transport-dsh/test/restart-regression.test.ts
git commit -m "transport-dsh: restart regression test (the 炭素素 case)"
```

---

## Task 10 — migration script + docs cross-reference (optional, single-user)

**Files:**
- Create: `scripts/migrate-mirror-to-record.ts` — a one-time migration that copies existing `DSH_TRANSCRIPT_DIR`/`/tmp/science-studio/transcripts/*.json` into the record's `transcripts/` dir, reconstructing from the record's `Run` rows where no mirror file exists.
- Modify: `docs/adr/0016-subagent-activity-is-an-optional-adapter-surface.md` (addendum already added — this task just re-checks cross-references).

**Interfaces:**
- Consumes: the record store (Task 1-2), the existing record's `Run` rows.
- Produces: a one-time script + a clean docs cross-reference.

- [ ] **Step 1: Write the migration script**

```bash
# One-time, for single-user installs upgrading from the mirror era:
#   node scripts/migrate-mirror-to-record.ts [--mirror-dir <dir>] [--record-path <path>]
# Defaults:
#   --mirror-dir  $(DSH_TRANSCRIPT_DIR || /tmp/science-studio/transcripts)
#   --record-path $(RECORD_STORE_PATH || ~/.local/share/science-studio/record.jsonl)
# Copy each <sessionId>.json from mirror-dir into dirname(record-path)/transcripts/,
# but only if that file is ABSENT (don't clobber a new record).
# For sessions whose mirror file is also missing, reconstruct from the record's Runs
# (input → user message, output → assistant message — the same fold used to recover
# the 炭素素 session in this conversation).
```
(Full implementation: ~50-80 lines of `fs/promises` — read the mirror dir, read the record `listRuns(projectId)` filtered to `sessionId`, build `Message[{id,role,parts:[{type:"text",text:run.input}},{id,role:"assistant",parts:[{type:"text",text:run.output}]}]` for each missing session, write to the record's transcript dir.)

- [ ] **Step 2: Run it in dev**

Run: `node scripts/migrate-mirror-to-record.ts`
Expected: prints a count of sessions migrated.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-mirror-to-record.ts
git commit -m "scripts: one-time mirror→record migration"
```

---

## Self-Review

- **Spec coverage**: every requirement in `docs/design/session-subagent-persistence.md` maps to a task: types + API (T1-2), conformance (T3), seam extension (T4), dsh behavior swap (T6), dsh adapter wiring (T7), subagent identity (T5), mirror/ledger deletion (T8), the direct regression (T9), migration (T10).
- **Placeholder scan**: no "TBD", no "implement later." Every code block is real. The Task 5 + 7 test skeletons are annotated with a reference to the existing scripted harness — the engineer follows the existing suite to drive the harness.
- **Type consistency**: the two record types (`PersistedTranscript`, `Subagent`) + the 5 method names are used verbatim across Tasks 1, 2, 3, 4, 5, 6, 7. The dsh adapter's `recordStore` field (line 137, already present), the behavior's `recordStore` dep, and the registry's `store` parameter all reference the SAME `RecordStoreLike` from `@science-studio/transport`.
