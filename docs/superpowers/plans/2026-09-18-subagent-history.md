# Subagent history, display names, and child-session drill-in — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completed subagent runs survive service restarts and stay visible behind a History toggle, rows get human-readable names, and double-clicking a row opens the child's full session record in the tab system.

**Architecture:** The dsh adapter gains a durable per-Session subagent ledger (same placement pattern as its transcript mirror), a new optional seam member `subagentTranscript?(sessionKey, childId)` reads the harness's own durable child-session log (zstd JSONL, Node built-in zstd), the shared service exposes it at one new GET route, and the workbench panel/viewer/tab system consume it. The record layer is untouched.

**Tech Stack:** TypeScript monorepo (npm workspaces, Node 24, `node:zlib` zstd), Fastify service, Next.js 15 (App Router, `params: Promise<…>`), zustand, shadcn/ui, `node:test` + playwright-core for web e2e.

**Spec:** `docs/superpowers/specs/2026-09-18-subagent-history-design.md`

## Global Constraints

- **No new runtime dependencies.** zstd decoding uses Node's built-in `zlib` (`zstdDecompressSync`).
- **Structural payloads in `@gps/transport-dsh` modules that read harness data** — no `@deepseek-ai/*` *value* imports (type-only imports are fine); unknown shapes degrade to unlabeled/absent, never throw.
- **Record layer untouched** — no new record entity; `SubagentRun` stays best-effort live state (docs/adr/0002, 0007, 0016 addendum).
- **Fail-soft reads** — a missing/unreadable child log resolves to `null` (route → 404, UI → friendly state), never an error throw into a route.
- **Artifacts (code comments, docs, ADR) are written in English.**
- **Type gate is the root build:** `npm run build` (package `tsc -b` chain + `tsconfig.tests.json`). `npm run typecheck` is known-broken for the service — do not use it.
- **Per-package tests:** `node --test` via the package's `npm run test -w <workspace>` (tsx strips types; the root `npm run build` is the real type check).
- **Web e2e** (`apps/web/test/*.mjs`) needs a pre-built client (`npm run build -w @gps/transport-client`) and a Chromium (they SKIP without one); they run their own `next dev` under a private dist dir.
- **The `useSubagents` hook's host must never re-render** and the panel must keep polling nothing while collapsed (existing invariants, pinned by `apps/web/test/subagents-panel.test.mjs`).
- Commit messages and artifacts in English; each task ends in a commit (skip the Steps that say "Commit" only if the operator overrides).

---

## File map (locked decomposition)

| File | Change |
| --- | --- |
| `packages/transport/src/types.ts` | Modify: `SubagentTranscript`, `subagentTranscript?`, doc fixes |
| `packages/transport/src/runtime.ts` | Modify: `capabilities.subagentTranscript` |
| `packages/transport/src/index.ts` | Modify: export the new type |
| `packages/transport-openclaw/src/binding.ts` | Modify: capability `false` |
| `packages/transport-dsh/src/binding.ts` | Modify: capability (T1 `false`, T5 `true`) |
| `packages/contract-tests/src/runtime-factory.ts` | Modify: capability/method match assertion |
| `packages/contract-tests/test/conformance.test.ts` | Modify: fixture capability |
| `services/transport-service/test/{injected-plugins,composition-settings}.test.ts`, `test/fixtures/per-project-runtime.ts` | Modify: fixture capabilities |
| `packages/transport-dsh/src/subagents.ts` | Modify: `sessionKey`, store seam, settle-restore, finished-create, `flush` |
| `packages/transport-dsh/src/ledger.ts` | Create: `FileSubagentLedger` |
| `packages/transport-dsh/src/adapter.ts` | Modify: attach store, `dshHome`/`launchCwd`, `parentSessionId`, `subagentTranscript()`, `flushSubagents()` |
| `packages/transport-dsh/src/child-transcript.ts` | Create: `projectKey`, `readChildTranscript` |
| `packages/transport-dsh/src/index.ts` | Modify: export the ledger + reader |
| `services/transport-service/src/server.ts` | Modify: transcript route |
| `packages/transport-client/src/subagents.ts` + `src/index.ts` | Modify: fetch hook + exports |
| `apps/web/store/studio-store.ts` | Modify: toggle + `openSubagent` |
| `apps/web/components/studio/subagents-view.tsx` | Modify: toggle, filter, names, double-click |
| `apps/web/components/studio/file-utils.ts`, `file-icons.tsx`, `tab-strip.tsx`, `file-preview-pane.tsx` | Modify: synthetic-tab plumbing |
| `apps/web/components/studio/renderers/SubagentRenderer.tsx` | Create: transcript rendering |
| `apps/web/app/api/transport/subagents/[childId]/transcript/route.ts` | Create: proxy hop |
| Tests: `packages/transport-dsh/test/{subagents,adapter,child-transcript}.test.ts`, `packages/transport-client/test/subagents.test.ts`, `services/transport-service/test/subagents.test.ts`, `apps/web/test/subagents-panel.test.mjs` | Extend |
| `docs/adr/0016-*.md`, `AGENTS.md` | Modify (Task 9) |

---

### Task 1: Seam — `SubagentTranscript`, optional member, capability

**Files:**
- Modify: `packages/transport/src/types.ts` (near `SubagentRun`, L153-213), `packages/transport/src/runtime.ts` (L62-71), `packages/transport/src/index.ts` (L22-36)
- Modify: `packages/transport-openclaw/src/binding.ts` (L60-66), `packages/transport-dsh/src/binding.ts` (L88-100)
- Modify: `packages/contract-tests/src/runtime-factory.ts` (L57-66), `packages/contract-tests/test/conformance.test.ts` (L75-85)
- Modify: `services/transport-service/test/injected-plugins.test.ts` (L15-18), `services/transport-service/test/composition-settings.test.ts` (L32-38), `services/transport-service/test/fixtures/per-project-runtime.ts` (L42-48)

**Interfaces:**
- Consumes: `Id`, `RunStatus`, `Message` (all already in `packages/transport`).
- Produces: `SubagentTranscript` (importable from `@gps/transport`), `RuntimeAdapter.subagentTranscript?(sessionKey: string, childId: string): Promise<SubagentTranscript | null>`, `RuntimeCapabilities.subagentTranscript: boolean` (required field — every capability literal in the repo compiles against it, so ALL of them are updated in THIS task).

- [ ] **Step 1: Add the seam type and optional member**

In `packages/transport/src/types.ts`, replace the `SubagentRun` doc comment block (L153-157) with:

```ts
/**
 * One delegated (subagent) run as a runtime reports it. Best-effort live
 * state, assembled by the adapter from runtime events — a runtime MAY keep a
 * durable ledger of it (dsh does, per-Session; the ADR 0016 addendum), but it
 * never enters the record: `Run` stays the record's atomic unit
 * (docs/adr/0002, docs/adr/0007).
 */
```

After the `SubagentRun` interface (L174), add:

```ts
/**
 * One delegated session's readable record, as a runtime that keeps one serves
 * it (dsh: the harness's own durable child-session log). A `null` answer means
 * "the runtime has no record for this child" — the log is absent, unreadable,
 * or in a format this build does not read.
 */
export interface SubagentTranscript {
  /** The child session id — the same identity as `SubagentRun.id`. */
  id: Id;
  /** The Generative Protein System Session this run was delegated from. */
  parentId: Id;
  /** The child's descriptor label, when one exists. */
  label?: string;
  /** The provider name that established the child (dsh: "spawn" | "fork"). */
  provider?: string;
  /** The child's model routing, when the descriptor recorded it. */
  agentProvider?: string;
  agentModel?: string;
  /** The stored session's creation time, when the log carries one. */
  startedAt?: string;
  /** The last recorded turn-end time, when the log ends one. */
  finishedAt?: string;
  /** The child's terminal outcome, when the recorded log ends one. */
  status?: RunStatus;
  /** The child's conversation in the canonical `Message`/`MessagePart` vocabulary. */
  messages: Message[];
}
```

Update the `subagents?` member's doc (L208-213) to:

```ts
  /**
   * Subagent runs delegated from one canonical session key. OPTIONAL: gate on
   * `capabilities.subagents` rather than forcing a no-op on every runtime.
   * The list is best-effort live state, not a persisted record — a runtime MAY
   * remember it durably (dsh does; never a record).
   */
  subagents?(sessionKey: string): Promise<SubagentRun[]>;
  /**
   * One delegated session's readable record. OPTIONAL: gate on
   * `capabilities.subagentTranscript`. Resolves to `null` — never throws —
   * when the runtime has no record for this child (absent, unreadable, or an
   * unrecognized format).
   */
  subagentTranscript?(sessionKey: string, childId: string): Promise<SubagentTranscript | null>;
```

- [ ] **Step 2: Add the capability and update every declaration**

`packages/transport/src/runtime.ts` — after the `subagents: boolean;` line (L70) add:

```ts
  /** `RuntimeAdapter.subagentTranscript()` is available (a child-session record read). */
  subagentTranscript: boolean;
```

`packages/transport-openclaw/src/binding.ts` — after `subagents: false,` (L64):

```ts
  subagentTranscript: false,
```

`packages/transport-dsh/src/binding.ts` — after `subagents: true,` (L99) — **`false` here; it flips to `true` in Task 5** when the adapter implements the method:

```ts
  subagents: true,
  subagentTranscript: false,
```

The three service test fixtures (`services/transport-service/test/injected-plugins.test.ts`, `services/transport-service/test/composition-settings.test.ts`, `services/transport-service/test/fixtures/per-project-runtime.ts`) and `packages/contract-tests/test/conformance.test.ts` — each has a capabilities object with `subagents: false,`; after that line add:

```ts
        subagentTranscript: false,
```

`packages/transport/src/index.ts` — in the L22-36 `export type { … } from "./seams.js"` list, after `SubagentRun,` add:

```ts
  SubagentTranscript,
```

- [ ] **Step 3: Pin the capability/method match in the factory conformance suite**

`packages/contract-tests/src/runtime-factory.ts` — after the existing `subagents` assertion (L62-66) add:

```ts
    assert.equal(
      factory.capabilities.subagentTranscript,
      typeof adapter.subagentTranscript === "function",
      "capabilities.subagentTranscript must match whether the adapter implements subagentTranscript()",
    );
```

- [ ] **Step 4: Build to verify the seam compiles repo-wide**

Run: `npm run build`
Expected: full chain green (record → transport → … → service, then `typecheck:tests`), including the conformance-package tests compiling against the new required capability field.

- [ ] **Step 5: Run the conformance + dsh tests**

Run: `npm run test -w @gps/contract-tests && npm run test -w @gps/transport-dsh`
Expected: PASS (dsh capability `false` matches its absent method; openclaw `false` likewise).

- [ ] **Step 6: Commit**

```bash
git add packages/transport/src packages/transport-openclaw/src packages/contract-tests packages/transport-dsh/src/binding.ts services/transport-service/test
git commit -m "feat(seam): add the optional subagentTranscript member and capability"
```

---

### Task 2: Durable subagent registry (ledger store seam + file ledger)

**Files:**
- Modify: `packages/transport-dsh/src/subagents.ts` (whole-module rewrite of the class; keep the exported `SubagentDescriptorInfo`/`SubagentFinishedInfo` names)
- Create: `packages/transport-dsh/src/ledger.ts`
- Test: `packages/transport-dsh/test/subagents.test.ts` (extend)
- Modify: `packages/transport-dsh/src/index.ts` (export the ledger)

**Interfaces:**
- Consumes: `SubagentRun` (Task 1's package), `FileSubagentLedger` (Step 3).
- Produces: `SubagentLedgerStore` (`listKeys(): Promise<string[]>`, `load(key): Promise<SubagentLedgerEntry[] | null>`, `save(key, entries): Promise<void>`); `SubagentRegistry.attachStore(store)`, `flush(): Promise<void>`; `SubagentFinishedInfo.parentSessionId?`; `FileSubagentLedger(dir).listKeys/load/save`.

- [ ] **Step 1: Extend the registry tests (they fail first)**

Append to `packages/transport-dsh/test/subagents.test.ts`:

```ts
import { SubagentLedgerEntry } from "../src/subagents.js";

/** An in-memory store the registry persists into (the seam's test shape). */
class FakeLedgerStore {
  readonly files = new Map<string, SubagentLedgerEntry[]>();
  async listKeys() {
    return [...this.files.keys()];
  }
  async load(key: string) {
    return this.files.get(key) ?? null;
  }
  async save(key: string, entries: readonly SubagentLedgerEntry[]) {
    this.files.set(key, [...entries]);
  }
}

test("a store persists per session key on every mutation", () => {
  const store = new FakeLedgerStore();
  const reg = new SubagentRegistry((root) => (root === "root-1" ? "sess-1" : undefined), () => `t${Math.random()}`);
  reg.attachStore(store);
  reg.noteStarted("root-1", "child-1");
  reg.noteDescriptor("child-1", { label: "Literature review", provider: "spawn" });
  reg.noteFinished("child-1", { status: "ok", stopReason: "completed" });
  return reg.flush().then(() => {
    const rows = store.files.get("sess-1")!;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "child-1");
    assert.equal(rows[0]!.status, "completed");
    assert.equal(rows[0]!.sessionKey, "sess-1");
    assert.equal(store.files.has("sess-2"), false, "only the owning key is ever written");
  });
});

test("a restored ledger keeps finished runs and settles stale ones to aborted", async () => {
  const store = new FakeLedgerStore();
  store.files.set("sess-1", [
    { id: "old-done", parentHarnessId: "root-old", status: "completed", startedAt: "t0", finishedAt: "t1" },
    { id: "old-run", parentHarnessId: "root-old", status: "running", startedAt: "t2" },
  ]);
  const reg = new SubagentRegistry(() => undefined, () => "now");
  reg.attachStore(store);
  await reg.ready();
  const runs = reg.list("sess-1");
  assert.equal(runs.length, 2);
  assert.equal(runs.find((r) => r.id === "old-done")!.status, "completed");
  const stale = runs.find((r) => r.id === "old-run")!;
  assert.equal(stale.status, "aborted", "a restored running entry is settled");
  assert.equal(stale.finishedAt, "now");
});

test("a finished run without a started notification is recorded from its own parent", () => {
  const store = new FakeLedgerStore();
  const reg = new SubagentRegistry((root) => (root === "root-1" ? "sess-1" : undefined), () => "t0");
  reg.attachStore(store);
  reg.noteFinished("child-x", { status: "ok", stopReason: "completed", parentSessionId: "root-1" });
  const [run] = reg.list("sess-1");
  assert.ok(run, "a finished run is recorded under its own parent key");
  assert.equal(run.id, "child-x");
  assert.equal(run.status, "completed");
  assert.equal(run.startedAt, "t0", "startedAt is stamped at observation (the wire carries none)");
});

test("a live entry wins over a restored duplicate", async () => {
  const store = new FakeLedgerStore();
  store.files.set("sess-1", [
    { id: "child-1", parentHarnessId: "root-old", status: "completed", startedAt: "t0" },
  ]);
  const reg = new SubagentRegistry((root) => (root === "root-1" ? "sess-1" : undefined), () => "t9");
  reg.attachStore(store);
  reg.noteStarted("root-1", "child-1");
  await reg.ready();
  const [run] = reg.list("sess-1");
  assert.ok(run, "a live entry is listed under the session key");
  assert.equal(run.status, "running", "the live in-memory entry is not clobbered by a restore");
});
```

`reg.flush()` awaits queued saves; `reg.ready()` awaits the one restore (both are new methods this task adds).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm run test -w @gps/transport-dsh`
Expected: the four new subagents tests FAIL (`attachStore is not a function` / property absent); the pre-existing registry tests PASS.

- [ ] **Step 3: Implement the durable registry**

Replace `packages/transport-dsh/src/subagents.ts` with:

```ts
/**
 * The adapter-side subagent ledger. It folds the harness child's
 * `subagent.started` / `subagent.finished` notifications and its child-session
 * `subagent/descriptor` events into one live view per Generative Protein System Session.
 *
 * DURABLE (optional): without a store the ledger is live-only and dropped
 * with the adapter — and keying never mutates one (there is no file to place
 * rows in), so an entry whose root stops resolving is skipped while it does
 * not and returns once it resolves (the live-only invariant, pinned by the
 * pre-existing registry tests). When the adapter attaches a
 * `SubagentLedgerStore` (it does, in `init`), entries are stamped with their
 * resolved Generative Protein System session key and saved per key, so finished runs survive the adapter
 * generation — the panel's history across service restarts (ADR 0016
 * addendum). A restored entry that was still `running` is settled to
 * `aborted`: its harness child died with the previous process, so listing it
 * as running would be a lie.
 *
 * The wire carries no timestamps, so the adapter stamps them on arrival. The
 * SDK's completion `status` is a coarse ok/error; the richer `stopReason` is
 * what the status is derived from.
 *
 * This module stays structural: it imports no `@deepseek-ai/*` value, so a
 * harness pin that moves a payload shape degrades to an unlabeled entry rather
 * than a crash (the same rule as the child bridge plugin).
 */
import type { SubagentRun } from "@gps/transport";

export interface SubagentDescriptorInfo {
  label?: string;
  provider?: string;
}

export interface SubagentFinishedInfo {
  provider?: string;
  status: "ok" | "error";
  stopReason?: string;
  /** The delegating session (harness id) `subagent.finished` reports itself. */
  parentSessionId?: string;
}

/** One persisted ledger row (JSON-safe; one file per session key). */
export interface SubagentLedgerEntry {
  id: string;
  parentHarnessId: string;
  /** Stamped once resolvable; stable across harness generations. */
  sessionKey?: string;
  label?: string;
  provider?: string;
  status: SubagentRun["status"];
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * The registry's durability seam. The adapter hosts a file-backed
 * implementation (ledger.ts); tests host in-memory ones.
 */
export interface SubagentLedgerStore {
  /** Every session key that holds a saved ledger. */
  listKeys(): Promise<string[]>;
  /** The ledger saved under one key, or `null` when absent/unreadable. */
  load(sessionKey: string): Promise<SubagentLedgerEntry[] | null>;
  /** Atomically replace every ledger row saved under one key. */
  save(sessionKey: string, entries: readonly SubagentLedgerEntry[]): Promise<void>;
}

type Entry = SubagentLedgerEntry;

/** The Run status a finished subagent settles to. The stop reason wins over
 *  the coarse SDK status: `max-tokens` and `refusal` are completed runs. */
function settleStatus(status: "ok" | "error", stopReason?: string): SubagentRun["status"] {
  switch (stopReason) {
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    default:
      return status === "error" ? "error" : "completed";
  }
}

/** A restored row is structural: keep only what is well-formed. */
function isLedgerEntry(value: unknown): value is SubagentLedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["id"] === "string" &&
    typeof e["parentHarnessId"] === "string" &&
    (e["status"] === "running" ||
      e["status"] === "completed" ||
      e["status"] === "aborted" ||
      e["status"] === "error") &&
    typeof e["startedAt"] === "string"
  );
}

export class SubagentRegistry {
  private readonly entries = new Map<string, Entry>();
  private store: SubagentLedgerStore | null = null;
  /** Chains saves so two concurrent saves never interleave their writes. */
  private saving: Promise<void> = Promise.resolve();
  /** The one restore in flight (or settled). */
  private restoring: Promise<void> | null = null;

  constructor(
    /** Map a ROOT harness session id back to its Generative Protein System session key. */
    private readonly resolveSessionKey: (rootHarnessId: string) => string | undefined,
    /** Clock seam for deterministic tests. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Attach durable storage (the adapter does this in `init`). Loads whatever
   * ledgers exist ONCE; settles restored `running` entries to `aborted` (theirs
   * harness child died with the previous process). A live in-memory entry
   * always wins over a duplicate restored row.
   */
  attachStore(store: SubagentLedgerStore): void {
    if (this.store !== null) return;
    this.store = store;
    this.restoring = this.restoreAll().catch((err) => {
      console.warn("[dsh] subagent ledger restore failed", err);
    });
  }

  /** Await the one-time restore (tests and graceful reads). */
  async ready(): Promise<void> {
    await this.restoring;
  }

  /** Await every queued save (tests and graceful shutdown). */
  async flush(): Promise<void> {
    await this.saving;
  }

  noteStarted(parentSessionId: string, childSessionId: string): void {
    if (parentSessionId === childSessionId || this.entries.has(childSessionId)) return;
    const entry: Entry = {
      id: childSessionId,
      parentHarnessId: parentSessionId,
      status: "running",
      startedAt: this.now(),
    };
    this.entries.set(childSessionId, entry);
    const key = this.resolveKey(entry);
    if (key !== undefined && this.store !== null) entry.sessionKey = key;
    this.persist(entry.sessionKey);
  }

  noteDescriptor(childSessionId: string, info: SubagentDescriptorInfo): void {
    const entry = this.entries.get(childSessionId);
    if (!entry) return;
    if (info.label !== undefined) entry.label = info.label;
    if (info.provider !== undefined) entry.provider = info.provider;
    if (entry.sessionKey === undefined) {
      const key = this.resolveKey(entry);
      if (key !== undefined && this.store !== null) entry.sessionKey = key;
    }
    this.persist(entry.sessionKey);
  }

  noteFinished(childSessionId: string, info: SubagentFinishedInfo): void {
    let entry = this.entries.get(childSessionId);
    if (entry === undefined) {
      // A `subagent.started` that was never observed (a dropped notification,
      // a service restart between start and finish) still leaves a finished
      // record: the payload carries its own parent. `startedAt` is stamped at
      // observation — the wire carries no timestamps (best-effort).
      if (info.parentSessionId === undefined) return;
      entry = {
        id: childSessionId,
        parentHarnessId: info.parentSessionId,
        status: "running",
        startedAt: this.now(),
      };
      this.entries.set(childSessionId, entry);
    }
    entry.status = settleStatus(info.status, info.stopReason);
    if (info.provider !== undefined) entry.provider = info.provider;
    if (info.stopReason !== undefined) entry.stopReason = info.stopReason;
    entry.finishedAt = this.now();
    if (entry.sessionKey === undefined) {
      const key = this.resolveKey(entry);
      if (key !== undefined && this.store !== null) entry.sessionKey = key;
    }
    this.persist(entry.sessionKey);
  }

  /** The live runs for one Session, newest first. Non-destructive: an entry
   *  whose root does not currently resolve (a `/new` remint, a mapping not
   *  published yet) is SKIPPED, never dropped, so it appears again once the
   *  root resolves. */
  list(sessionKey: string): SubagentRun[] {
    const out: SubagentRun[] = [];
    for (const entry of this.entries.values()) {
      const key = this.resolveKey(entry);
      if (key === undefined) continue;
      if (key !== sessionKey) continue;
      if (entry.sessionKey !== key && this.store !== null) {
        // Keying settles here (the first listed read after a root resolve).
        entry.sessionKey = key;
        this.persist(key);
      }
      out.push({
        id: entry.id,
        parentId: key,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(entry.provider === undefined ? {} : { provider: entry.provider }),
        status: entry.status,
        ...(entry.stopReason === undefined ? {} : { stopReason: entry.stopReason }),
        startedAt: entry.startedAt,
        ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
      });
    }
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return out;
  }

  private async restoreAll(): Promise<void> {
    const store = this.store!;
    const keys = await store.listKeys();
    for (const key of keys) {
      const rows = await store.load(key);
      if (rows === null) continue;
      for (const row of rows) {
        if (!isLedgerEntry(row) || this.entries.has(row.id)) continue;
        const entry: Entry = { ...row };
        if (entry.status === "running" && entry.finishedAt === undefined) {
          entry.status = "aborted";
          entry.finishedAt = this.now();
          if (entry.stopReason === undefined) entry.stopReason = "aborted";
        }
        if (entry.sessionKey === undefined) entry.sessionKey = key;
        this.entries.set(entry.id, entry);
      }
    }
  }

  private persist(key: string | undefined): void {
    if (key === undefined || this.store === null) return;
    const store = this.store;
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        const rows = [...this.entries.values()].filter((e) => e.sessionKey === key);
        await store.save(key, rows);
      })
      .catch((err) => {
        console.warn("[dsh] subagent ledger save failed", err);
      });
  }

  /** The Session key an entry belongs to: the nearest stamped ancestor wins;
   *  otherwise the ROOT (the first untracked ancestor in the parent chain) is
   *  resolved. `undefined` = not resolvable yet (the entry is skipped, not
   *  dropped, by `list`). */
  private resolveKey(entry: Entry): string | undefined {
    if (entry.sessionKey !== undefined) return entry.sessionKey;
    const seen = new Set<string>([entry.id]);
    let harnessId = entry.parentHarnessId;
    while (!seen.has(harnessId)) {
      seen.add(harnessId);
      const ancestor = this.entries.get(harnessId);
      if (ancestor === undefined) return this.resolveSessionKey(harnessId);
      if (ancestor.sessionKey !== undefined) return ancestor.sessionKey;
      harnessId = ancestor.parentHarnessId;
    }
    return this.resolveSessionKey(entry.parentHarnessId);
  }
}
```

- [ ] **Step 4: Create the file-backed ledger**

Create `packages/transport-dsh/src/ledger.ts`:

```ts
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SubagentLedgerEntry, SubagentLedgerStore } from "./subagents.js";

/**
 * The file-backed subagent ledger: one JSON file per Generative Protein System Session
 * key under one directory — the same one-file-per-session placement as the
 * transcript mirror, so a shared transcript dir never mixes two Projects'
 * rows into one file. Writes are atomic (a temp file renamed into place),
 * never interleaving, and unreadable content reads as ABSENT rather than
 * corrupt — the durable list degrades to empty, the live one stays good.
 */
export interface LedgerFile {
  v: 1;
  sessionId: string;
  entries: SubagentLedgerEntry[];
}

export class FileSubagentLedger implements SubagentLedgerStore {
  constructor(private readonly dir: string) {}

  private fileFor(sessionKey: string): string {
    return join(resolve(this.dir), `${encodeURIComponent(sessionKey)}.json`);
  }

  async listKeys(): Promise<string[]> {
    try {
      const names = await fs.readdir(this.dir);
      const keys: string[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          keys.push(decodeURIComponent(name.slice(0, -5)));
        } catch {
          // A name that cannot decode: skip it, keep the rest.
        }
      }
      return keys;
    } catch {
      return [];
    }
  }

  async load(sessionKey: string): Promise<SubagentLedgerEntry[] | null> {
    try {
      const raw = await fs.readFile(this.fileFor(sessionKey), "utf8");
      const parsed = JSON.parse(raw) as LedgerFile;
      if (parsed?.v !== 1 || !Array.isArray(parsed.entries)) return null;
      return parsed.entries;
    } catch {
      return null;
    }
  }

  async save(sessionKey: string, entries: readonly SubagentLedgerEntry[]): Promise<void> {
    const file = this.fileFor(sessionKey);
    try {
      await fs.mkdir(dirname(file), { recursive: true });
      const payload: LedgerFile = { v: 1, sessionId: sessionKey, entries: [...entries] };
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn("[dsh] subagent ledger save failed", err);
    }
  }
}
```

- [ ] **Step 5: Export the ledger**

In `packages/transport-dsh/src/index.ts`, after the `TranscriptMirror` lines (L11-12) add:

```ts
export { FileSubagentLedger } from "./ledger.js";
export type { LedgerFile } from "./ledger.js";
export type { SubagentLedgerEntry, SubagentLedgerStore } from "./subagents.js";
```

(And `SubagentDescriptorInfo`/`SubagentFinishedInfo` were already exported from `./subagents.js` — verify; if not, export them here too.)

- [ ] **Step 6: Run the registry tests**

Run: `npm run test -w @gps/transport-dsh`
Expected: ALL subagents tests pass, including the four new ones; pre-existing tests (stop-reason mapping, grandchild walk, unresolvable-root skip) still pass.

- [ ] **Step 7: Type-check the package**

Run: `npm run build -w @gps/transport-dsh`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/transport-dsh/src/subagents.ts packages/transport-dsh/src/ledger.ts packages/transport-dsh/src/index.ts packages/transport-dsh/test/subagents.test.ts
git commit -m "feat(dsh): make the subagent ledger durable per Session"
```

---

### Task 3: Adapter wiring — attach the store, restart-survival test

**Files:**
- Modify: `packages/transport-dsh/src/adapter.ts` (`initialize()` near `this.mirror = …` L319; `captureSubagent` L492-500; new `flushSubagents`)
- Test: `packages/transport-dsh/test/adapter.test.ts`

**Interfaces:**
- Consumes: `FileSubagentLedger` (Task 2), `SubagentRegistry.attachStore/flush` (Task 2).
- Produces: `DshRuntimeAdapter.flushSubagents(): Promise<void>` (test/seam hook for a quiesced save); the adapter now persists to `<transcript dir>/subagents/`.

- [ ] **Step 1: Write the restart-survival test (fails first)**

Append to `packages/transport-dsh/test/adapter.test.ts` (imports `mkdtemp`, `rm`, `tmpdir`, `join` are already present there):

```ts
test("a finished subagent run belongs to the session's ledger across an adapter restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-subagents-persist-"));
  const now = () => "2026-09-18T00:00:00.000Z";
  const store = new FakeRecordStore();
  const client = new FakeDshClient(() => completedReply("am1", "Hello from dsh."));
  try {
    const first = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir, now });
    await first.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    await collect(first.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "delegate" } },
    ]));
    const parent = client.sessionIds[0]!;
    client.emit({ method: "subagent.started", params: { parentSessionId: parent, childSessionId: "child-1" } });
    client.emit({
      method: "session.event",
      params: { sessionId: "child-1", event: { type: "subagent/descriptor", data: { label: "收集足球类24小时体育新闻", provider: "spawn" } } },
    });
    client.emit({
      method: "subagent.finished",
      params: { parentSessionId: parent, childSessionId: "child-1", provider: "spawn", status: "ok", stopReason: "completed" },
    });
    await first.flushSubagents();
    const done = await first.subagents("sess-1");
    assert.equal(done.length, 1);
    assert.equal(done[0]!.status, "completed");
    await first.abort();

    // A SECOND adapter generation over the SAME transcript dir must still list
    // the finished run (the panel's history across service restarts).
    const restarted = new DshRuntimeAdapter({
      createClient: () => new FakeDshClient(() => completedReply("am2", "Hello again.")),
      transcriptDir: dir,
      now,
    });
    await restarted.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    const restored = await restarted.subagents("sess-1");
    await restarted.abort();
    assert.equal(restored.length, 1, "a finished subagent run survives an adapter restart");
    assert.equal(restored[0]!.id, "child-1");
    assert.equal(restored[0]!.status, "completed");
    assert.equal(restored[0]!.label, "收集足球类24小时体育新闻");
    assert.equal(await restarted.subagents("other").then((l) => l.length), 0, "only the owning Session lists it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm run test -w @gps/transport-dsh -- adapter.test.ts`
Expected: FAIL — `flushSubagents is not a function` (and, once that is added, the restored list would be empty without the attach).

- [ ] **Step 3: Wire the adapter**

`packages/transport-dsh/src/adapter.ts`:

1. Import the ledger (next to the `TranscriptMirror` import, L38):

```ts
import { FileSubagentLedger } from "./ledger.js";
```

2. In `initialize()`, directly after `this.mirror = new TranscriptMirror(dir);` (L319) add:

```ts
    // The subagent ledger gains durability in the SAME place as the transcript
    // mirror: one file per Session key under the shared transcript dir
    // (docs/adr/0016 addendum) — a restart restores the session's finished
    // runs instead of emptying the panel.
    this.subagentRegistry.attachStore(new FileSubagentLedger(join(dir, "subagents")));
```

3. In `captureSubagent`'s finished branch (L495-499), pass the parent through:

```ts
      this.subagentRegistry.noteFinished(child, {
        status: params["status"] === "error" ? "error" : "ok",
        ...(typeof params["provider"] === "string" ? { provider: params["provider"] } : {}),
        ...(typeof params["stopReason"] === "string" ? { stopReason: params["stopReason"] } : {}),
        ...(typeof params["parentSessionId"] === "string" ? { parentSessionId: params["parentSessionId"] } : {}),
      });
```

4. Next to `subagents(sessionKey)` (L513-517) add:

```ts
  /** Quiesce in-flight ledger saves (tests and graceful shutdown). */
  async flushSubagents(): Promise<void> {
    await this.subagentRegistry.flush();
  }
```

5. Make `subagents()` (L513-517) await the one-time restore before listing. Without this, the restart test races: `attachStore` starts `restoreAll()` fire-and-forget and the synchronous `list()` reads an empty registry before the file load lands. `ready()` never hangs (the restore promise always settles; before `attachStore` it is `null`), so the existing "a read is always answerable" guarantee holds:

```ts
  async subagents(sessionKey: string): Promise<SubagentRun[]> {
    // No init wait: the registry is constructor-owned and empty before init, so
    // a read is always answerable (the seam read must not hang a cold adapter).
    // It DOES await the one-time ledger restore, so a first read right after a
    // restart lists the previous generation's finished runs instead of racing
    // the file load (docs/adr/0016 addendum).
    await this.subagentRegistry.ready();
    return this.subagentRegistry.list(sessionKey);
  }
```

- [ ] **Step 4: Run the adapter tests**

Run: `npm run test -w @gps/transport-dsh`
Expected: ALL pass, including the two pre-existing live-subagent tests (no store-attach regression) and the new restart test.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-dsh/src/adapter.ts packages/transport-dsh/test/adapter.test.ts
git commit -m "feat(dsh): persist the subagent ledger across adapter generations"
```

---

### Task 4: Child-session transcript reader

**Files:**
- Create: `packages/transport-dsh/src/child-transcript.ts`
- Test: `packages/transport-dsh/test/child-transcript.test.ts`
- Modify: `packages/transport-dsh/src/index.ts` (export)

**Interfaces:**
- Consumes: `SubagentTranscript` (Task 1), `contentToParts`/`extractResultText`/`findToolCallMessage` from `./mapping.js` (existing), type-only `ContentBlock` from `@deepseek-ai/dsh-llm` (existing dep).
- Produces: `projectKey(cwd: string): string` (exported, pure), `readChildTranscript(source: { home, cwd, sessionKey, childId }): Promise<SubagentTranscript | null>` (exported), `ChildTranscriptSource` type.

- [ ] **Step 1: Write the tests (fail first)**

Create `packages/transport-dsh/test/child-transcript.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { projectKey, readChildTranscript } from "../src/child-transcript.js";

// `zstdCompressSync` is present at runtime (Node >= 23.8) but not declared in
// this repo's pinned @types/node — reached the same way as the production module.
const zstdCompressSync = (zlib as unknown as {
  zstdCompressSync: (buf: string | Buffer) => Buffer;
}).zstdCompressSync;

const CHILD = "f625a7c7-8708-431e-a380-0a52729da6af";
const CWD = "/home/zhonghua/dsh-workspace/project-1";

function logLines(over: Array<Record<string, unknown>> = []): string[] {
  return [
    { type: "session", version: 3, id: CHILD, createdAt: 1789655889309, cwd: CWD, parentSession: "sess-1", isSeeded: false, origin: "subagent", delegationDepth: 1 },
    { type: "subagent/descriptor", seq: 0, time: 1789655889320, data: { version: 3, mode: "continuable", provider: "spawn", label: "收集足球类24小时体育新闻", agentProvider: "ollama-local", agentModel: "qwen3.8:latest" } },
    { type: "user/message", seq: 8, time: 1789655889575, data: { content: [{ type: "text", text: "收集足球新闻。" }] } },
    { type: "assistant/message", seq: 14, time: 1789655911253, data: { turn: 1, step: 1, message: { role: "assistant", id: "m-a1", content: [{ type: "reasoning", text: "plan" }, { type: "text", text: "我先查当前时间。" }] } } },
    { type: "tool/call", seq: 15, time: 1789655911258, data: { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: '{"command":"date"}' } },
    { type: "tool/result", seq: 16, time: 1789655911535, data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: "call-1" }, content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "Thu Sep 17 2026" }], isError: false }], role: "user", id: "m-tool-1" } } },
    { type: "turn/end", seq: 80, time: 1789656491505, data: { turn: 1, reason: { kind: "completed" } } },
    ...over,
  ].map((row) => JSON.stringify(row));
}

async function homeWith(logs: Array<{ name: string; text: string }>, cwd = CWD): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "dsh-child-transcript-"));
  const dir = join(home, "sessions", projectKey(cwd), CHILD);
  await mkdir(dir, { recursive: true });
  for (const { name, text } of logs) {
    await writeFile(join(dir, name), text, "utf8");
  }
  return home;
}

test("projectKey matches the harness's session-root directory encoding", () => {
  assert.equal(
    projectKey("/home/zhonghua/dsh-workspace/project-default"),
    "--home-zhonghua-dsh-workspace-project-default--",
  );
  assert.equal(projectKey("C:\\proj\\x"), "--C-proj-x--");
  assert.equal(projectKey("/a//b"), "--a-b--");
});

test("readChildTranscript folds a full child log into the seam shape", async () => {
  const home = await homeWith([
    { name: "session.v3.jsonl.zstd", text: "" },
  ]);
  // Overwrite with the real zstd payload (writeFile above just creates it).
  const dir = join(home, "sessions", projectKey(CWD), CHILD);
  await writeFile(join(dir, "session.v3.jsonl.zstd"), zstdCompressSync(logLines().join("\n")), "utf8");
  try {
    const t = await readChildTranscript({ home, cwd: CWD, sessionKey: "sess-1", childId: CHILD });
    assert.ok(t, "the record must be found");
    assert.equal(t!.id, CHILD);
    assert.equal(t!.parentId, "sess-1");
    assert.equal(t!.label, "收集足球类24小时体育新闻");
    assert.equal(t!.provider, "spawn");
    assert.equal(t!.agentProvider, "ollama-local");
    assert.equal(t!.agentModel, "qwen3.8:latest");
    assert.equal(t!.status, "completed");
    assert.equal(t!.startedAt, "2026-09-17T14:38:09.309Z");
    assert.equal(t!.finishedAt, "2026-09-17T14:48:11.505Z");

    const roles = t!.messages.map((m) => m.role);
    assert.deepEqual(roles, ["user", "assistant"], "user row, then ONE assistant row with the tool work merged");
    const assistant = t!.messages[1]!;
    const tool = assistant.parts.find((p) => p.type === "tool-call") as { type: "tool-call"; name: string; result?: string };
    assert.equal(tool.name, "bash");
    assert.equal(tool.result, "Thu Sep 17 2026", "the tool result merges into the call");
    assert.ok(assistant.parts.some((p) => p.type === "text" && p.text.includes("我先查当前时间。")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a newer format generation wins over an older one", async () => {
  const home = await homeWith([]);
  const dir = join(home, "sessions", projectKey(CWD), CHILD);
  await writeFile(join(dir, "session.v2.jsonl"), logLines([{ type: "turn/end", seq: 1, time: 1, data: { turn: 1, reason: { kind: "error", error: { message: "old" } } } }]).join("\n"), "utf8");
  await writeFile(join(dir, "session.v3.jsonl.zstd"), zstdCompressSync(logLines().join("\n")), "utf8");
  try {
    const t = await readChildTranscript({ home, cwd: CWD, sessionKey: "sess-1", childId: CHILD });
    assert.equal(t!.status, "completed", "v3 (newer) wins over v2");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("absences and malformed content all answer null, never throw", async () => {
  const cases = [
    readChildTranscript({ home: join(tmpdir(), "no-such-home"), cwd: CWD, sessionKey: "s", childId: CHILD }),
    readChildTranscript({ home: join(tmpdir(), "x"), cwd: CWD, sessionKey: "s", childId: "../escape" }),
  ];
  for (const p of cases) {
    assert.equal(await p, null);
  }
  // A home whose child dir exists but holds no session log.
  const home = await homeWith([{ name: "session.lock", text: "" }]);
  try {
    assert.equal(await readChildTranscript({ home, cwd: CWD, sessionKey: "s", childId: CHILD }), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  // A decodable log whose header names a DIFFERENT session is not this record.
  const other = ["{" + '"type":"session","id":"other",' + '"version":3,"createdAt":1,"cwd":"/x","delegationDepth":0,"isSeeded":false' + "}"].map((s) => s);
  const home2 = await homeWith([]);
  const dir = join(home2, "sessions", projectKey(CWD), CHILD);
  await writeFile(join(dir, "session.v3.jsonl"), other[0]!, "utf8");
  try {
    assert.equal(await readChildTranscript({ home: home2, cwd: CWD, sessionKey: "s", childId: CHILD }), null, "a header id mismatch is not this record");
  } finally {
    await rm(home2, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Verify they fail**

Run: `npm run test -w @gps/transport-dsh -- child-transcript.test.ts`
Expected: FAIL — module `../src/child-transcript.js` not found.

- [ ] **Step 3: Implement the reader**

Create `packages/transport-dsh/src/child-transcript.ts`:

```ts
import { promises as fs } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Message, SubagentTranscript } from "@gps/transport";
import { contentToParts, extractResultText, findToolCallMessage } from "./mapping.js";

// `zstdDecompressSync` is present at runtime (Node >= 23.8) but not yet declared in
// this repo's pinned @types/node, so it is reached without bumping the types.
const zstdDecompressSync = (zlib as unknown as {
  zstdDecompressSync: (buf: Buffer) => Buffer;
}).zstdDecompressSync;

/**
 * The harness's session-root directory key for a project path —
 * re-implemented (rather than imported) from
 * `@deepseek-ai/dsh-session-persistence-jsonl`: separators and drive
 * separators collapse to a single `-`, unsafe code units escape as `~XXXX`
 * (upper-case, 4-digit hex), the key is bracketed `--…--` and bounded to 251
 * characters. The key is a stable, version-observed path contract; the
 * adapter must not depend on the harness's plugin internals.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

export interface ChildTranscriptSource {
  /** The harness home the adapter's children launch into. */
  home: string;
  /** The launch working directory recorded on the child's session header. */
  cwd: string;
  /** The Generative Protein System Session key the child was delegated from. */
  sessionKey: string;
  /** The child (harness) session id. */
  childId: string;
}

/**
 * Read one dsh child's durable session (the harness's own event log) and fold
 * it into the seam's `SubagentTranscript`. FAIL-SOFT end to end: an absent
 * home/dir/log, an undecodable frame, and a torn trailing line all resolve to
 * `null` (or keep what already decoded) — the surface degrades to "no record"
 * rather than throwing (docs/adr/0016 addendum).
 *
 * The fold mirrors the behavior's live rules over the SAME vocabulary:
 * `user/message`/`assistant/message` rows become messages; a `tool/call`
 * upserts a `tool-call` part into the latest assistant message; a
 * `tool/result` merges its text into that call; `turn/end` settles the status
 * and `finishedAt`; `subagent/descriptor` carries the label/model fields; the
 * `session` header carries `startedAt` (and must name THIS child).
 */
export async function readChildTranscript(source: ChildTranscriptSource): Promise<SubagentTranscript | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(source.childId)) return null;
  const dir = join(source.home, "sessions", projectKey(source.cwd), source.childId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  // The newest format generation wins (a bump in v leaves older artifacts).
  const gens = names
    .map((name) => {
      const match = /^session\.v([0-9]+)\.jsonl(?:\.zstd)?$/.exec(name);
      if (match === null) return null;
      return { version: Number(match[1]), zstd: name.endsWith(".zstd"), name };
    })
    .filter((g): g is { version: number; zstd: boolean; name: string } => g !== null)
    .sort((a, b) => b.version - a.version);
  if (gens.length === 0) return null;

  let text: string;
  try {
    const bytes = await fs.readFile(join(dir, gens[0]!.name));
    text = gens[0]!.zstd ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
  } catch {
    return null;
  }

  let startedAt: string | undefined;
  let headerId: string | undefined;
  let label: string | undefined;
  let provider: string | undefined;
  let agentProvider: string | undefined;
  let agentModel: string | undefined;
  let status: SubagentTranscript["status"];
  let finishedAt: string | undefined;
  const messages: Message[] = [];
  let minted = 0;
  const nextId = (): string => `child-${++minted}`;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // a torn tail keeps the already-folded prefix
    }
    if (typeof row !== "object" || row === null) continue;
    const rec = row as Record<string, unknown>;
    const type = typeof rec["type"] === "string" ? rec["type"] : null;
    if (type === null) continue;
    const data = (rec["data"] ?? {}) as Record<string, unknown>;
    const timeIso = typeof rec["time"] === "number" ? new Date(rec["time"]).toISOString() : undefined;

    const blocksOf = (value: unknown): readonly ContentBlock[] =>
      Array.isArray(value) ? (value as readonly ContentBlock[]) : [];

    switch (type) {
      case "session":
        headerId = typeof rec["id"] === "string" ? rec["id"] : undefined;
        if (typeof rec["createdAt"] === "number" && Number.isFinite(rec["createdAt"])) {
          startedAt = new Date(rec["createdAt"]).toISOString();
        }
        break;

      case "subagent/descriptor": {
        if (typeof data["label"] === "string") label = data["label"];
        if (typeof data["provider"] === "string") provider = data["provider"];
        if (typeof data["agentProvider"] === "string") agentProvider = data["agentProvider"];
        if (typeof data["agentModel"] === "string") agentModel = data["agentModel"];
        break;
      }

      case "user/message": {
        const parts = contentToParts(blocksOf(data["content"]));
        if (parts.length > 0) messages.push({ id: nextId(), role: "user", parts });
        break;
      }

      case "assistant/message": {
        const message = (data["message"] ?? {}) as Record<string, unknown>;
        if (message["role"] !== "assistant") break;
        const id = typeof message["id"] === "string" ? message["id"] : nextId();
        if (messages.some((m) => m.id === id)) break; // committed once per id (live rule)
        messages.push({ id, role: "assistant", parts: contentToParts(blocksOf(message["content"])) });
        break;
      }

      case "tool/call": {
        // The owning assistant message is the latest; the tool-call part may
        // already exist from the assistant row (upsert, not append-twice).
        const owner = [...messages].reverse().find((m) => m.role === "assistant");
        if (owner === undefined) break;
        const existing = owner.parts.find((p) => p.type === "tool-call" && p.id === data["callId"]);
        if (existing === undefined && typeof data["name"] === "string") {
          owner.parts.push({
            type: "tool-call",
            id: typeof data["callId"] === "string" ? data["callId"] : nextId(),
            name: data["name"],
            args: typeof data["arguments"] === "string" ? data["arguments"] : "",
          });
        }
        break;
      }

      case "tool/result": {
        const message = (data["message"] ?? {}) as Record<string, unknown>;
        const blocks = blocksOf(message["content"]);
        for (const block of blocks as unknown as Array<Record<string, unknown>>) {
          if (block["type"] !== "tool-result" || typeof block["toolCallId"] !== "string") continue;
          const target = findToolCallMessage(messages, block["toolCallId"]);
          if (target === null) continue;
          for (const part of target.parts) {
            if (part.type === "tool-call" && part.id === block["toolCallId"]) {
              part.result = extractResultText(blocks as Array<ContentBlock>);
              part.isError = block["isError"] === true;
            }
          }
        }
        break;
      }

      case "turn/end": {
        const reason = (data["reason"] ?? {}) as Record<string, unknown>;
        const kind = reason["kind"];
        status = kind === "completed" ? "completed" : kind === "error" ? "error" : "aborted";
        if (timeIso !== undefined) finishedAt = timeIso;
        break;
      }

      default:
        // system/message, step/*, request/*, sandbox/mode, approval/policy,
        // agent/inbox/*: structural, never rendered.
        break;
    }
  }

  // A header that names a different session is not this record.
  if (headerId !== undefined && headerId !== source.childId) return null;

  return {
    id: source.childId,
    parentId: source.sessionKey,
    ...(label === undefined ? {} : { label }),
    ...(provider === undefined ? {} : { provider }),
    ...(agentProvider === undefined ? {} : { agentProvider }),
    ...(agentModel === undefined ? {} : { agentModel }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(status === undefined ? {} : { status }),
    messages,
  };
}
```

- [ ] **Step 4: Export**

`packages/transport-dsh/src/index.ts` — after the ledger exports (Task 2 Step 5) add:

```ts
export { projectKey, readChildTranscript } from "./child-transcript.js";
export type { ChildTranscriptSource } from "./child-transcript.js";
```

- [ ] **Step 5: Run the reader tests**

Run: `npm run test -w @gps/transport-dsh -- child-transcript.test.ts`
Expected: ALL pass — including the real-machine `projectKey` vector and the zstd fold.

- [ ] **Step 6: Commit**

```bash
git add packages/transport-dsh/src/child-transcript.ts packages/transport-dsh/src/index.ts packages/transport-dsh/test/child-transcript.test.ts
git commit -m "feat(dsh): read a child session's durable log into the seam shape"
```

---

### Task 5: Adapter `subagentTranscript()` + capability flip

**Files:**
- Modify: `packages/transport-dsh/src/adapter.ts` (new private fields, `initialize()` assignments, new method), `packages/transport-dsh/src/binding.ts` (capability)
- Test: `packages/transport-dsh/test/adapter.test.ts`

**Interfaces:**
- Consumes: `readChildTranscript` (Task 4), the ledger list from `subagents()` (membership gate).
- Produces: `DshRuntimeAdapter.subagentTranscript(sessionKey, childId): Promise<SubagentTranscript | null>`; `DSH_CAPABILITIES.subagentTranscript` becomes `true`.

- [ ] **Step 1: Write the tests (fail first)**

Append to `packages/transport-dsh/test/adapter.test.ts`:

```ts
test("subagentTranscript serves the child's record and null for a foreign child", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const zlib = await import("node:zlib");
  // `zstdCompressSync` is present at runtime (Node >= 23.8) but not declared in
  // this repo's pinned @types/node — reached the same way as the production module.
  const zstdCompressSync = (zlib as unknown as {
    zstdCompressSync: (buf: string | Buffer) => Buffer;
  }).zstdCompressSync;
  const { projectKey } = await import("../src/child-transcript.js");
  const dir = await mkdtemp(join(tmpdir(), "dsh-subagent-transcript-"));
  const store = new FakeRecordStore();
  const client = new FakeDshClient(() => completedReply("am1", "Hello from dsh."));
  const adapter = new DshRuntimeAdapter({
    createClient: () => client,
    transcriptDir: dir,
    bindingDshHome: dir, // test seam (added by this task)
  });
  try {
    await adapter.init({
      binding: { runtime: "dsh", config: {} },
      recordStore: store,
      workspace: { toAgentPath: () => "/proj/one", root: "/proj/one" } as never,
    });
    // Lay a child log down where the harness would store it.
    const childDir = join(dir, "sessions", projectKey("/proj/one"), "sub-child-1");
    await (await import("node:fs/promises")).mkdir(childDir, { recursive: true });
    const log = JSON.stringify({ type: "session", id: "sub-child-1", version: 3, createdAt: 1789655889309, cwd: "/proj/one", delegationDepth: 1, isSeeded: false, origin: "subagent" })
      + "\n"
      + JSON.stringify({ type: "assistant/message", seq: 1, time: 1789655911253, data: { turn: 1, step: 1, message: { role: "assistant", id: "m1", content: [{ type: "text", text: "child says hi" }] } } })
      + "\n"
      + JSON.stringify({ type: "turn/end", seq: 2, time: 1789656491505, data: { turn: 1, reason: { kind: "completed" } } });
    await writeFile(join(childDir, "session.v3.jsonl.zstd"), zstdCompressSync(log), "utf8");

    const run: SubagentRun = {
      id: "sub-child-1",
      parentId: "sess-1",
      provider: "spawn",
      status: "running",
      startedAt: "2026-09-17T14:38:09.309Z",
    };
    client.emit({ method: "subagent.started", params: { parentSessionId: client.sessionIds[0] ?? "root-x", childSessionId: "sub-child-1" } });
    void run;

    const t = await adapter.subagentTranscript("sess-1", "sub-child-1");
    assert.ok(t, "the adapter must serve the child's record");
    assert.equal(t!.id, "sub-child-1");
    assert.equal(t!.status, "completed");
    assert.equal(t!.messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "child says hi")), true);

    assert.equal(await adapter.subagentTranscript("sess-1", "not-in-the-ledger"), null, "a child outside the session's ledger is not served");
  } finally {
    await adapter.abort();
    await rm(dir, { recursive: true, force: true });
  }
});
```

Note: the parent for the membership check — after `client.emit({method:"subagent.started", params:{parentSessionId, childSessionId}})`, the registry must resolve the parent to `sess-1`. The fake client's `sessionIds[0]` IS the harness session id `driveTurn` minted for `sess-1` ONLY if a run happened first — so the test MUST drive one turn before emitting:

Add BEFORE the `client.emit` line (inside the same test):

```ts
    await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "delegate" } },
    ]));
```

- [ ] **Step 2: Verify it fails**

Run: `npm run test -w @gps/transport-dsh -- adapter.test.ts`
Expected: FAIL — `bindingDshHome is not an option` / `subagentTranscript is not a function` / capability mismatch in conformance once flipped.

- [ ] **Step 3: Implement on the adapter**

`packages/transport-dsh/src/adapter.ts`:

1. Add to the constructor options (after `now?: () => string;`, L91) the test seam:

```ts
  /** Test seam: the harness home (`dshHome`) for child-session transcript reads. */
  bindingDshHome?: string;
```

2. Add private fields (near `private client: DshTurnClient | null = null;`, L121):

```ts
  private dshHome: string | undefined = undefined;
  private launchCwd: string | undefined = undefined;
```

3. At the top of the constructor body (before `this.initialized = …`) set the seam:

```ts
    this.dshHome = options.bindingDshHome;
```

4. In `initialize()`, after the cwd/model resolution and the `const dir = …` line (L241-245), set the authoritative home. Precedence: an explicit binding/env home wins, then the constructor seam, then the default directory — the local `dshHome` is `binding.home ?? env("DSH_HOME") ?? undefined`:

```ts
    this.dshHome = dshHome ?? this.dshHome ?? join(homedir(), ".dsh");
    this.launchCwd = cwd;
```

and change the two later uses of the local `dshHome` to `this.dshHome!`:
- `applyRouteSettings({ home: this.dshHome, … })` (L296-297)
- `this.client = this.createClient({ profile, dshHome: this.dshHome, … })` (L309-311)

5. Add the method next to `subagents()` (after L517):

```ts
  /**
   * One delegated session's readable record: the child's own durable log in
   * the harness home (docs/adr/0016 addendum). The LEDGER is the membership
   * gate — a child id that is not one of this Session's runs is not served —
   * and the read is fail-soft (absent/mismatched/unreadable logs are `null`,
   * never a throw).
   */
  async subagentTranscript(sessionKey: string, childId: string): Promise<SubagentTranscript | null> {
    if (this.dshHome === undefined || this.launchCwd === undefined) return null;
    const runs = await this.subagents(sessionKey);
    if (!runs.some((r) => r.id === childId)) return null;
    return readChildTranscript({ home: this.dshHome, cwd: this.launchCwd, sessionKey, childId });
  }
```

6. Imports: `SubagentTranscript` into the `@gps/transport` import list (L4-18) and from `./child-transcript.js` only `readChildTranscript` (projectKey is internal to that module, not re-exported):

```ts
import { readChildTranscript } from "./child-transcript.js";
```

7. Flip the capability in `packages/transport-dsh/src/binding.ts` (L99): `subagentTranscript: false,` → `subagentTranscript: true,`.

- [ ] **Step 4: Run the dsh + conformance tests**

Run: `npm run test -w @gps/transport-dsh && npm run test -w @gps/contract-tests`
Expected: ALL pass — the factory conformance assertion now sees `subagentTranscript: true` matching the implemented method.

- [ ] **Step 5: Build (type gate)**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/transport-dsh/src/adapter.ts packages/transport-dsh/src/binding.ts packages/transport-dsh/test/adapter.test.ts
git commit -m "feat(dsh): serve child-session transcripts and advertise the capability"
```

---

### Task 6: Service transcript route

**Files:**
- Modify: `services/transport-service/src/server.ts` (after the subagents route, L376-391)
- Test: `services/transport-service/test/subagents.test.ts`

**Interfaces:**
- Consumes: `adapter.subagentTranscript?` (Task 1 method), `scope.acquire`, `canonicalSessionKey` (existing).
- Produces: `GET /api/transport/subagents/:childId/transcript?projectId&threadId` → `200 {"transcript": SubagentTranscript}` | `404` (no surface / `null` / unknown child) | `400` (unsafe childId).

- [ ] **Step 1: Write the route tests (fail first)**

Append to `services/transport-service/test/subagents.test.ts` (adding `SubagentTranscript` to the file's existing `@gps/transport` import):

```ts
test("GET /api/transport/subagents/:childId/transcript serves the adapter's record", async () => {
  const transcript: SubagentTranscript = { id: "child-1", parentId: "sess-1", messages: [] };
  const adapter: RuntimeAdapter = {
    ...emptyAdapter,
    subagentTranscript: async (sessionKey, childId) =>
      sessionKey === "sess-1" && childId === "child-1" ? transcript : null,
  };
  await withAdapter(adapter, async (base) => {
    const ok = await fetch(`${base}/api/transport/subagents/child-1/transcript?projectId=p1&threadId=sess-1`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { transcript });
    const missing = await fetch(`${base}/api/transport/subagents/nobody/transcript?projectId=p1&threadId=sess-1`);
    assert.equal(missing.status, 404, "a null answer is a 404");
  });
});

test("GET .../transcript answers 404 when the runtime has no surface and 400 on an unsafe id", async () => {
  await withAdapter(emptyAdapter, async (base) => {
    const res = await fetch(`${base}/api/transport/subagents/child-1/transcript?projectId=p1&threadId=sess-1`);
    assert.equal(res.status, 404, "no subagentTranscript member → 404");
    const unsafe = await fetch(`${base}/api/transport/subagents/child.1/transcript?projectId=p1&threadId=sess-1`);
    assert.equal(unsafe.status, 400, "a path-unsafe id is 400");
  });
});
```

- [ ] **Step 2: Verify they fail**

Run: `npm run test -w @gps/transport-service -- subagents.test.ts`
Expected: FAIL — the 200 case gets 404 (no route), the surface-less case passes vacuously.

- [ ] **Step 3: Add the route**

`services/transport-service/src/server.ts` — after the subagents route (L391), insert:

```ts
  // -- Subagent child-session records (adapter-owned, optional surface) -----
  app.get("/api/transport/subagents/:childId/transcript", async (request, reply) => {
    // The record belongs to the Project's OWN adapter (docs/adr/0008), like
    // the list. A runtime without the surface (or a child it has no record
    // for) answers 404 — the panel degrades to a friendly state.
    const { environment, threadId } = await scope.acquire(request);
    const adapter = environment.adapter;
    const childId = (request.params as { childId?: string }).childId ?? "";
    if (!/^[A-Za-z0-9_-]+$/.test(childId)) {
      return reply.code(400).send({ error: "childId must be a single safe path segment" });
    }
    const sessionId = canonicalSessionKey(adapter, threadId);
    if (typeof adapter.subagentTranscript !== "function") {
      return reply.code(404).send({ error: `runtime "${adapter.runtime}" has no subagent records` });
    }
    let transcript: unknown;
    try {
      transcript = await adapter.subagentTranscript(sessionId, childId);
    } catch (err) {
      console.error("[transport-service] subagent transcript read failed", err);
      return reply.code(404).send({ error: "the subagent record is not available" });
    }
    if (transcript === null) {
      return reply.code(404).send({ error: "the subagent record is not available" });
    }
    return { transcript };
  });
```

- [ ] **Step 4: Run the service tests**

Run: `npm run test -w @gps/transport-service`
Expected: ALL pass (including the two new transcript tests and the pre-existing subagents tests).

- [ ] **Step 5: Commit**

```bash
git add services/transport-service/src/server.ts services/transport-service/test/subagents.test.ts
git commit -m "feat(service): serve subagent child-session records over one GET route"
```

---

### Task 7: Client fetch hook

**Files:**
- Modify: `packages/transport-client/src/subagents.ts` (append), `packages/transport-client/src/index.ts` (exports near L101)
- Test: `packages/transport-client/test/subagents.test.ts` (create)

**Interfaces:**
- Consumes: `SubagentTranscript` from `@gps/transport` (Task 1).
- Produces: `fetchSubagentTranscript(api, project, childId, threadId?, signal?): Promise<SubagentTranscript>`; `useSubagentTranscript({ api?, project, threadId?, childId, enabled }): { transcript, isLoading, error }`; index re-exports the two functions (the `SubagentTranscript` seam type stays imported by consumers from `@gps/transport`, like `SubagentRun`).

- [ ] **Step 1: Write the hook test (fail first)**

Create `packages/transport-client/test/subagents.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSubagentTranscript } from "../src/subagents.js";

test("fetchSubagentTranscript targets the per-child route and parses the body", async () => {
  const transcript = { id: "child-1", parentId: "s1", messages: [] };
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ transcript }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const got = await fetchSubagentTranscript("/api/transport", "p1", "child-1", "s1");
    assert.deepEqual(got, transcript);
    assert.match(calls[0]!, /\/api\/transport\/subagents\/child-1\/transcript\?projectId=p1&threadId=s1/);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchSubagentTranscript throws on a 404 (a missing record)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(() => fetchSubagentTranscript("/api/transport", "p1", "child-x"));
  } finally {
    globalThis.fetch = original;
  }
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm run test -w @gps/transport-client`
Expected: the new file FAILS (function missing); existing client tests pass.

- [ ] **Step 3: Implement**

Append to `packages/transport-client/src/subagents.ts`:

```ts

/**
 * One delegated session's readable record. Throws on a non-2xx response —
 * the hook below turns that into its `error` state (the UI's friendly
 * "record unavailable").
 */
export async function fetchSubagentTranscript(
  api: string,
  project: string | null,
  childId: string,
  threadId?: string | null,
  signal?: AbortSignal,
): Promise<SubagentTranscript> {
  const query = new URLSearchParams();
  if (project) query.set("projectId", project);
  if (threadId) query.set("threadId", threadId);
  const res = await fetch(`${api}/subagents/${encodeURIComponent(childId)}/transcript?${query.toString()}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`subagent transcript ${res.status}`);
  const body = (await res.json()) as { transcript?: SubagentTranscript };
  if (body.transcript === undefined) throw new Error("subagent transcript body missing");
  return body.transcript;
}

export interface UseSubagentTranscriptOptions {
  /** Transport base; defaults to the same-origin `/api/transport`. */
  api?: string;
  project: string | null;
  threadId?: string | null;
  childId: string;
  /** False (or no project) makes NO request. */
  enabled: boolean;
}

/**
 * Fetch ONE child session's record. A failed fetch (404 / offline) lands in
 * the `error` state — the panel renders a friendly "not available"; the
 * request is aborted on unmount or a scope change.
 */
export function useSubagentTranscript(options: UseSubagentTranscriptOptions): {
  transcript: SubagentTranscript | null;
  isLoading: boolean;
  error: string | null;
} {
  const { api = DEFAULT_TRANSPORT_API, project, threadId, childId, enabled } = options;
  const [transcript, setTranscript] = useState<SubagentTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled || project === null) return;
    let active = true;
    const controller = new AbortController();
    setIsLoading(true);
    fetchSubagentTranscript(api, project, childId, threadId, controller.signal)
      .then((next) => {
        if (active) {
          setTranscript(next);
          setError(null);
        }
      })
      .catch(() => {
        if (active) {
          setTranscript(null);
          setError("unavailable");
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, project, threadId, childId, enabled]);

  return { transcript, isLoading, error };
}
```

And at the top of `subagents.ts`, extend the type import:

```ts
import type { SubagentRun, SubagentTranscript } from "@gps/transport";
```

- [ ] **Step 4: Export**

`packages/transport-client/src/index.ts` — in the existing `./subagents.js` export block (L95-101) insert `fetchSubagentTranscript` and `useSubagentTranscript` next to `fetchSubagents`/`useSubagents` and `type UseSubagentTranscriptOptions` next to `type UseSubagentsOptions`. Do NOT re-export the `SubagentTranscript` seam type: the house pattern (see `SubagentRun` — index never re-exports it; `apps/web/components/studio/subagents-view.tsx:5` imports it from `@gps/transport`) is that consumers take seam types from `@gps/transport` directly.

- [ ] **Step 5: Run the client tests + build the package**

Run: `npm run test -w @gps/transport-client && npm run build -w @gps/transport-client`
Expected: pass (the build emits the dist the web app imports).

- [ ] **Step 6: Commit**

```bash
git add packages/transport-client/src packages/transport-client/test/subagents.test.ts
git commit -m "feat(client): add the subagent transcript fetch hook"
```

---

### Task 8: Workbench — toggle, names, drill-in tab

**Files:**
- Modify: `apps/web/store/studio-store.ts`, `apps/web/components/studio/subagents-view.tsx`, `apps/web/components/studio/file-utils.ts`, `apps/web/components/studio/file-icons.tsx`, `apps/web/components/studio/tab-strip.tsx`, `apps/web/components/studio/file-preview-pane.tsx`
- Create: `apps/web/components/studio/renderers/SubagentRenderer.tsx`, `apps/web/app/api/transport/subagents/[childId]/transcript/route.ts`
- Test: `apps/web/test/subagents-panel.test.mjs` (extend)

**Interfaces:**
- Consumes: `fetchSubagentTranscript`/`useSubagentTranscript` (Task 7), `SubagentTranscript` (Task 1).
- Produces: store `subagentsShowHistory` + `setSubagentsShowHistory(show)` + `openSubagent(childId, name)`; tab id `subagent:<childId>`; `isSubagentTab(path)`/`subagentTabChildId(path)` in `file-utils.ts`; `subagentIcon()` in `file-icons.tsx`; `TranscriptBody` renderer.

- [ ] **Step 1: Extend the e2e test (it fails first)**

In `apps/web/test/subagents-panel.test.mjs`, after the generic subagents route mock (L71-78), register the transcript mock (later-registered playwright routes match FIRST, so it intercepts the drill-in fetch):

```js
      await page.route("**/api/transport/subagents/child-2/transcript*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            transcript: {
              id: "child-2",
              parentId: "s1",
              provider: "fork",
              startedAt: "2026-09-17T00:00:00.000Z",
              finishedAt: "2026-09-17T00:01:00.000Z",
              status: "completed",
              messages: [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "Child transcript body." }] }],
            },
          }),
        }),
      );
```

And replace the render assertions (L93-98) with:

```js
      // Expanding starts polling; the DEFAULT view is running-only.
      await subagents.getByRole("button", { name: "Subagents" }).click();
      await subagents.getByText("Literature review").waitFor({ timeout: 10_000 });
      await subagents.getByText("Running").waitFor({ timeout: 10_000 });
      assert.equal(await subagents.getByText("Completed", { exact: true }).count(), 0, "history is hidden by default");
      assert.ok(requests >= 1, "an open Subagents module polls");

      // The History toggle reveals past runs, with a friendly name for the
      // unlabeled child.
      await subagents.getByLabel("Show past subagent runs").click();
      await subagents.getByText("Completed", { exact: true }).waitFor({ timeout: 10_000 });
      const friendly = subagents.getByText("Subagent B", { exact: true });
      await friendly.waitFor({ timeout: 10_000 });

      // Double-clicking a row opens the child session in the tab system.
      await friendly.dblclick();
      await page.getByText("Child transcript body.").waitFor({ timeout: 10_000 });
```

- [ ] **Step 2: Verify it fails**

Run (from the repo root; targeting the ONE test file — the `-- subagents-panel` positional does NOT filter, it runs the whole suite because `node --test` treats positionals as file paths): `npm run build -w @gps/transport-client` then `cd apps/web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 test/subagents-panel.test.mjs`
Expected: FAIL (toggle button absent, hidden-default assertion fails) — or SKIP if no Chromium (in which case the later assertions are the gate on a machine that has one).

- [ ] **Step 3: Store**

`apps/web/store/studio-store.ts`:

State (after `rightHeights`, L66):

```ts
  /** The Subagents panel's History toggle — finished runs, not only running. */
  subagentsShowHistory: boolean;
```

Actions (after `setRightHeights`, L115):

```ts
  setSubagentsShowHistory: (show: boolean) => void;
  /** Open (or refocus) one subagent child session in the tab system. */
  openSubagent: (childId: string, name: string) => void;
```

Initial value (after `rightHeights: …`, L136):

```ts
  subagentsShowHistory: false,
```

Implementation (after `setRightHeights`, L250):

```ts
  setSubagentsShowHistory: (subagentsShowHistory) => set({ subagentsShowHistory }),
  openSubagent: (childId, name) =>
    set((s) => {
      const id = `subagent:${childId}`;
      const exists = s.tabs.some((t) => t.id === id);
      const tabs = exists ? s.tabs : [...s.tabs, { id, path: id, name }];
      return { tabs, activeTabPath: id };
    }),
```

- [ ] **Step 4: File helpers + icon**

`apps/web/components/studio/file-utils.ts` — append:

```ts
/**
 * A subagent child-session tab lives in its OWN namespace (`subagent:<id>`)
 * — a real workspace path can never collide with it, and the preview pane
 * dispatches it before any file logic.
 */
export function isSubagentTab(path: string): boolean {
  return path.startsWith("subagent:");
}

export function subagentTabChildId(path: string): string {
  return isSubagentTab(path) ? path.slice("subagent:".length) : "";
}
```

`apps/web/components/studio/file-icons.tsx` — add `Bot` to the lucide import and, after `cronIcon()`:

```tsx
export function subagentIcon(): ReactNode {
  return <Bot className="size-3.5 texture-violet-500 text-violet-500" />;
```

(no — plain):

```tsx
export function subagentIcon(): ReactNode {
  return <Bot className="size-3.5 text-violet-500" />;
}
```

`apps/web/components/studio/tab-strip.tsx` L43 — replace:

```tsx
            {isCronTaskPath(tab.path) ? cronIcon() : fileIcon(kindFor(tab.name))}
```

with:

```tsx
            {isCronTaskPath(tab.path) ? cronIcon() : isSubagentTab(tab.path) ? subagentIcon() : fileIcon(kindFor(tab.name))}
```

and add to the imports: `isSubagentTab` (from `./file-utils`) and `subagentIcon` (from `./file-icons`).

- [ ] **Step 5: Panel — toggle, running-only default, names, double-click**

Replace `apps/web/components/studio/subagents-view.tsx` with:

```tsx
"use client";

import { Bot, History } from "lucide-react";
import { useSubagents } from "@gps/transport-client";
import type { SubagentRun } from "@gps/transport";
import { Button } from "@/components/ui/button";
import { ModuleEmptyState, SidebarSection } from "./sidebar-section";
import { useStudioStore } from "@/store/studio-store";

const STATUS_LABEL: Record<SubagentRun["status"], string> = {
  running: "Running",
  completed: "Completed",
  aborted: "Aborted",
  error: "Error",
};

const STATUS_CLASS: Record<SubagentRun["status"], string> = {
  running: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  aborted: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  error: "bg-destructive/15 text-destructive",
};

/** How long a run has been (or was) active, in a compact form. */
function elapsed(run: SubagentRun): string {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A label is a display name only when it reads like one. Anything that is
 * itself an id (a UUID, or a long opaque token with no whitespace) falls back
 * to an ordinal — the raw id stays in the tooltip and on the wire.
 */
function looksLikeId(value: string): boolean {
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) return true;
  return value.replace(/\s+/g, "").length > 24;
}

function displayName(run: SubagentRun, index: number): string {
  const label = run.label?.trim();
  if (label !== undefined && label.length > 0 && !looksLikeId(label)) return label;
  return `Subagent ${String.fromCharCode(65 + (index % 26))}`;
}

function SubagentRow({ run, index, open }: { run: SubagentRun; index: number; open: (run: SubagentRun) => void }) {
  return (
    <li
      className="border-border/60 hover:bg-accent/40 flex cursor-default flex-col gap-1 rounded-md border px-2 py-1.5"
      title={`${displayName(run, index)} — ${run.label ?? run.id}${run.label ? "" : " (id)"}`}
      onDoubleClick={() => open(run)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">{displayName(run, index)}</span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[run.status]}`}
        >
          {STATUS_LABEL[run.status]}
        </span>
      </div>
      <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
        {run.provider ? <span>{run.provider}</span> : null}
        {run.stopReason ? <span>{run.stopReason}</span> : null}
        <span className="ml-auto tabular-nums">{elapsed(run)}</span>
      </div>
    </li>
  );
}

/**
 * The Subagents module: the active Session's live dsh subagent runs
 * (running by default), with the finished history behind the History toggle —
 * both durable across service restarts (docs/adr/0016 addendum). A row is
 * double-clicked to open the child's own session record in a tab.
 */
export function SubagentsView() {
  const open = useStudioStore((s) => s.rightSections.subagents);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.subagents);
  const projectId = useStudioStore((s) => s.projectId);
  const activeSessionId = useStudioStore((s) => s.activeSessionId);
  const showHistory = useStudioStore((s) => s.subagentsShowHistory);
  const setShowHistory = useStudioStore((s) => s.setSubagentsShowHistory);
  const openSubagent = useStudioStore((s) => s.openSubagent);

  const enabled = open && projectId !== null && activeSessionId !== null;
  const { subagents } = useSubagents({ projectId, threadId: activeSessionId, enabled });

  const visible = showHistory ? subagents : subagents.filter((run) => run.status === "running");
  const hidden = subagents.length - visible.length;

  const openTranscript = (run: SubagentRun): void => {
    openSubagent(run.id, run.label?.trim() || "Subagent");
  };

  return (
    <SidebarSection
      section="subagents"
      title="Subagents"
      icon={Bot}
      open={open}
      onOpenChange={() => toggleRightSection("subagents")}
      className={open ? "shrink-0" : undefined}
      style={open ? { height } : undefined}
      actions={
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6"
          title={showHistory ? "Hide past subagent runs" : "Show past subagent runs"}
          aria-label={showHistory ? "Hide past subagent runs" : "Show past subagent runs"}
          aria-pressed={showHistory}
          onClick={() => setShowHistory(!showHistory)}
        >
          <History className="size-3.5" />
        </Button>
      }
    >
      {visible.length === 0 ? (
        hidden > 0 ? (
          <ModuleEmptyState
            icon={Bot}
            message="No subagents running."
            hint={`${hidden} past run${hidden === 1 ? "" : "s"} hidden — use the history button to see them.`}
          />
        ) : (
          <ModuleEmptyState icon={Bot} message="No subagents yet." hint="Subagent runs will appear here." />
        )
      ) : (
        <ul className="flex h-full flex-col gap-1 overflow-auto p-2" aria-label="Subagent runs">
          {visible.map((run, index) => (
            <SubagentRow key={run.id} run={run} index={index} open={openTranscript} />
          ))}
        </ul>
      )}
    </SidebarSection>
  );
}
```

- [ ] **Step 6: Proxy hop**

Create `apps/web/app/api/transport/subagents/[childId]/transcript/route.ts`:

```ts
/**
 * Proxy for the subagent child-session record endpoint.
 *
 * The transport-service serves ONE delegated session's readable record at
 * `GET /api/transport/subagents/:childId/transcript` (JSON). The proxy
 * relays verbatim (same one policy as every other hop) — a 404 (absent,
 * unreadable, or no-surface record) is the expected shape, which the
 * SubagentRenderer renders as its friendly "not available" state.
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ childId: string }> },
): Promise<NextResponse> {
  const { childId } = await ctx.params;
  const { search } = new URL(request.url);
  return proxyToService(request, {
    path: `/api/transport/subagents/${encodeURIComponent(childId)}/transcript${search}`,
    headers: { accept: "application/json" },
  });
}
```

- [ ] **Step 7: Tab dispatch + renderer**

`apps/web/components/studio/file-preview-pane.tsx` — in `FilePreviewPane`'s `tabs.map` (L62-65), dispatch the synthetic kind before the file preview:

```tsx
        <TabPanel key={tab.id} active={tab.path === activeTabPath}>
          {isSubagentTab(tab.path) ? (
            <SubagentPreview path={tab.path} name={tab.name} />
          ) : (
            <Preview path={tab.path} name={tab.name} />
          )}
        </TabPanel>
```

(imports: `isSubagentTab`, `subagentTabChildId` from `./file-utils`; add `useSubagentTranscript` and `useTransportApi` to the existing `@gps/transport-client` import block at L6-11. `useTransportApi()` — NOT `useWorkspaceApi()` — hands out `{ api: "/api/transport", project }` (the transcript route lives under the TRANSPORT base; the workspace hook would produce `/api/workspace/subagents/…`, a path that exists nowhere — the e2e mock in Step 1 targets `/api/transport/…`). The existing `Preview` component keeps its `useWorkspaceApi()` call unchanged; the file imports both hooks. Also add `TranscriptBody` from `./renderers/SubagentRenderer` to the imports.)

Below `FilePreviewPane`, add the subagent preview (own header — NO download affordance):

```tsx
function SubagentPreview({ path, name }: { path: string; name: string }) {
  const { api, project } = useTransportApi();
  const activeSessionId = useStudioStore((s) => s.activeSessionId);
  const closeTab = useStudioStore((s) => s.closeTab);
  const childId = subagentTabChildId(path);
  const { transcript, isLoading, error } = useSubagentTranscript({
    api,
    project,
    threadId: activeSessionId,
    childId,
    enabled: project !== null,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={path}>
          {name}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6"
          onClick={() => closeTab(path)}
          aria-label="Close tab"
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && (
          <div className="flex justify-center p-4">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        )}
        {!isLoading && error && (
          <p className="text-muted-foreground p-4 text-sm">
            The record for this subagent session is not available.
          </p>
        )}
        {!isLoading && !error && transcript && <TranscriptBody transcript={transcript} />}
      </div>
    </div>
  );
}
```

Create `apps/web/components/studio/renderers/SubagentRenderer.tsx`:

```tsx
"use client";

import { Bot } from "lucide-react";
import type { Message, MessagePart, SubagentTranscript } from "@gps/transport";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./MarkdownRenderer";

/**
 * One delegated session's record: the child's own conversation folded from
 * the harness's durable log (docs/adr/0016 addendum). Text renders as
 * markdown; tool calls as compact collapsible rows — the workbench's
 * vocabulary, not the harness's.
 */
export function TranscriptBody({ transcript }: { transcript: SubagentTranscript }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
        <Bot className="size-3.5" />
        {transcript.provider ? <span>{transcript.provider}</span> : null}
        {transcript.agentProvider && transcript.agentModel ? (
          <span>
            {transcript.agentProvider}/{transcript.agentModel}
          </span>
        ) : null}
        {transcript.startedAt ? <span>started {new Date(transcript.startedAt).toLocaleString()}</span> : null}
        {transcript.finishedAt ? <span>ended {new Date(transcript.finishedAt).toLocaleString()}</span> : null}
        {transcript.status ? <span>{transcript.status}</span> : null}
      </div>
      {transcript.messages.map((message) => (
        <TranscriptMessage key={message.id} message={message} />
      ))}
    </div>
  );
}

function TranscriptMessage({ message }: { message: Message }) {
  return (
    <section
      className={cn(
        "border-border/60 rounded-md border p-2",
        message.role === "user" && "border-accent/60",
      )}
    >
      <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase tracking-wide">
        {message.role}
      </div>
      <div className="flex flex-col gap-2">
        {message.parts.map((part, index) => (
          <TranscriptPart key={partKey(part, index)} part={part} />
        ))}
      </div>
    </section>
  );
}

function partKey(part: MessagePart, index: number): string {
  return part.type === "tool-call" ? part.id : `${part.type}-${index}`;
}

function TranscriptPart({ part }: { part: MessagePart }) {
  switch (part.type) {
    case "text":
      return (
        <div>
          <MarkdownRenderer content={part.text} />
        </div>
      );
    case "reasoning":
      return (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer text-[11px]">Reasoning</summary>
          <div className="mt-1 text-xs opacity-80">
            <MarkdownRenderer content={part.text} />
          </div>
        </details>
      );
    case "tool-call":
      return (
        <details className="bg-muted/40 rounded border border-border/50 p-1.5 text-xs">
          <summary className="cursor-pointer font-medium">{part.name}</summary>
          {part.args ? (
            <pre className="mt-1 max-h-40 overflow-auto text-[11px]">{part.args}</pre>
          ) : null}
          {part.result !== undefined ? (
            <pre className="mt-1 max-h-40 overflow-auto text-[11px]">{part.result}</pre>
          ) : null}
        </details>
      );
    default:
      return null;
  }
}
```

- [ ] **Step 8: Build the web app**

Run: `npm run build -w @gps/web`
Expected: Next build PASSES (catches the new route, store, and component wiring).

- [ ] **Step 9: Run the web e2e panel test**

Run (single test file — see Step 2's note on why not the positional form): `npm run build -w @gps/transport-client` (repo root) then `cd apps/web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 test/subagents-panel.test.mjs`
Expected: PASS (on a Chromium host) — default-running view, toggle reveal, friendly name, double-click tab with the mocked transcript body; on a Chromium-less host: SKIP (record it and move on).

- [ ] **Step 10: Run the other panel-pinned e2e tests**

Run: `npm run test:e2e -w @gps/web`
Expected: PASS/SKIP across the board — `right-panel-sections` (collapse/empty-state invariants), `tab-state`, `scope-switch-sockets` all still green.

- [ ] **Step 11: Commit**

```bash
git add apps/web
git commit -m "feat(web): subagent history toggle, friendly names, and child-session tabs"
```

---

### Task 9: Docs — ADR addendum + AGENTS.md

**Files:**
- Modify: `docs/adr/0016-subagent-activity-is-an-optional-adapter-surface.md`, `AGENTS.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: an ADR addendum superseding the "live-only, in memory" decision (dsh-specific) and an AGENTS.md line that names the ledger, toggle, drill-in route.

- [ ] **Step 1: ADR addendum**

Append to `docs/adr/0016-…` (after its **Consequences** paragraph):

```markdown
## Addendum (2026-09-18)

The **dsh-specific durability decision** is re-scoped: "live-only, in memory"
held when the panel needed *a* data source; in practice the only useful
moment to read it is *after the fact*, usually after a restart. The dsh
adapter now keeps a durable per-Session subagent ledger — one JSON file per
session key under its transcript dir (the `TranscriptMirror` placement
pattern), restored on every adapter generation, with a restored `running`
entry settled to `aborted` (its child died with the previous process). What
is UNCHANGED: the surface stays the optional `subagents?`/`subagentTranscript?`
adapter methods; nothing enters the record (v1's `Project`/`Session`/`Run`
vocabulary is untouched); other runtimes may stay live-only (openclaw does).

The same addendum introduces a drill-in: a delegated session's readable
record is served by the *owning* runtime — dsh reads the harness's own
durable child-session log (zstd JSONL, decoded with Node's built-in `zlib`),
exposed as `GET /api/transport/subagents/:childId/transcript` under the
existing Project scope claim — and the workbench opens it as a synthetic
tab. The read is fail-soft: absent/mismatched/unreadable logs answer `null`
(404 / a friendly state), never an error.
```

- [ ] **Step 2: AGENTS.md**

In `AGENTS.md`, the `components/studio` line currently ends with:

```
the Subagents module reads the active Session's LIVE delegated-agent runs (the optional `RuntimeAdapter.subagents?` surface; dsh implements it live-only from the child's `subagent.*` notifications) by polling `/api/transport/subagents` through `useSubagents`, and never persists them
```

Replace that clause (keep the rest of the line) with:

```
the Subagents module reads the active Session's delegated-agent runs (the optional `RuntimeAdapter.subagents?` surface; dsh implements it from the child's `subagent.*` notifications into a DURABLE per-Session ledger under the transcript dir, so finished runs survive service restarts — restored `running` rows settle to `aborted`) by polling `/api/transport/subagents` through `useSubagents`; the panel shows running runs by default with a History toggle for the finished ones, rows double-click into the child's own session record (`RuntimeAdapter.subagentTranscript?` — dsh reads the harness's durable child log — over `GET /api/transport/subagents/:childId/transcript`, opened as a synthetic `subagent:<childId>` tab)
```

Also, in the `docs/adr/` list at the top of AGENTS.md, extend the 0016 entry: `0016 subagent activity is an optional adapter surface (dsh keeps a durable ledger; addendum)`.

- [ ] **Step 3: Final gate**

Run: `npm run build && npm run test`
Expected: full type chain + every package's suite green (the root `test` includes transport, transport-openclaw, transport-client, transport-dsh, transport-service, workspace; contract-tests conformance; the web dev-only suite is separate and already exercised in Task 8).

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0016-subagent-activity-is-an-optional-adapter-surface.md AGENTS.md docs/superpowers/specs/2026-09-18-subagent-history-design.md docs/superpowers/plans/2026-09-18-subagent-history.md
git commit -m "docs: record the subagent ledger durability addendum and drill-in"
```

---

## Self-review

1. **Spec coverage.** D1 → Tasks 2-3 (+T5 membership). D2 → Task 8 Step 5. D3 → Task 8 Step 5 (`looksLikeId`/`displayName`). D4 → seams T1, reader T4, adapter T5, route T6, client T7, UI T8. D5 → T1 types, T1/T7/T8 consumers. Error handling → T4 (fail-soft reader), T6 (404 ladder), T7 (error state), T8 (friendly copy). Tests → each task carries its own; web e2e extended in T8. Docs → T9. No gaps.
2. **Placeholder scan.** None — every step carries its code/commands; the one deliberate mid-step correction (T2 Step 1 `flush`/`ready` awkwardness) is written as a self-resolving replacement, and the final code is the "use THIS version" block.
3. **Type consistency.** `SubagentTranscript` (T1) used by T4/T5/T6/T7/T8; `attachStore`/`ready`/`flush` (T2) used by T3 tests and `flushSubagents` (T3); `projectKey`/`readChildTranscript` (T4) used by T5; `openSubagent`/`subagentsShowHistory` (T8 Step 3) used by the panel (T8 Step 5); `isSubagentTab`/`subagentTabChildId` (T8 Step 4) used by tab-strip/preview-pane (T8 Step 4-7); `useSubagentTranscript` (T7) used by SubagentPreview (T8 Step 7). Capability `subagentTranscript` flips `false` (T1) → `true` (T5) — never a gap where it claims a method that does not exist.
