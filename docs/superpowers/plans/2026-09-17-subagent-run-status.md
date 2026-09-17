# Subagent (DSH) Run Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the live status of dsh subagent runs in the workbench's Subagents panel, fed by a standing SDK notification subscription in the adapter and read through a polled HTTP route.

**Architecture:** The dsh adapter keeps an in-memory `SubagentRegistry` fed by `HarnessClient.subscribe()` (child-wide, so background subagents keep updating after the parent turn settles). The seam gains one optional `RuntimeAdapter.subagents?(sessionKey)` method and a normalized `SubagentRun` type; the service exposes a read route, the web proxies it, and `useSubagents` polls it while the module is open.

**Tech Stack:** TypeScript (npm workspaces), `node:test` + `node:assert/strict` with `tsx`, Fastify, Next.js App Router, React, `@deepseek-ai/dsh-sdk-client@0.1.5-alpha.1`.

## Global Constraints

- Artifacts (commits, docs, comments) are written in **English**; conversation is Chinese.
- Package exports are **explicit** — never `export *`. New symbols must be added to `packages/transport/src/seams.ts` AND `packages/transport/src/index.ts`.
- Keep `packages/transport` and `packages/transport-client` logic React-free where they already are (`transport-client` may use hooks; `transport` must not).
- The dsh adapter parses harness notification payloads **structurally** and fails soft; it imports no `@deepseek-ai/*` type into the registry.
- Tests: `node --import tsx --test test/*.test.ts`; use `node:test` and `node:assert/strict`.
- `@science-studio/*` resolves to built `dist` types, so run `npm run build` before running a dependent package's tests.
- The web e2e suite is Chromium-gated and requires `npm run build -w @science-studio/transport-client` first.
- Commit style: lowercase conventional prefixes (`feat:`, `test:`, `docs:`).

---

## File Structure

- `packages/transport/src/types.ts` — add `SubagentRun`; add optional `RuntimeAdapter.subagents?`.
- `packages/transport/src/runtime.ts` — add `RuntimeCapabilities.subagents`.
- `packages/transport/src/seams.ts`, `packages/transport/src/index.ts` — export `SubagentRun`.
- `packages/transport-openclaw/src/binding.ts` — `subagents: false`.
- `packages/transport-dsh/src/subagents.ts` (new) — the `SubagentRegistry`.
- `packages/transport-dsh/src/client.ts` — add `subscribeNotifications`.
- `packages/transport-dsh/src/adapter.ts` — construct/feed the registry, attach after start, implement `subagents()`, advertise the capability.
- `packages/transport-dsh/src/binding.ts` — `subagents: true`.
- `packages/transport-dsh/src/index.ts` — export registry types as needed.
- `packages/contract-tests/src/subagents.ts` (new) + `src/index.ts` — the optional suite.
- `services/transport-service/src/server.ts` — `GET /api/transport/subagents`.
- `services/transport-service/test/*` — capability literals + route tests.
- `apps/web/app/api/transport/subagents/route.ts` (new) — proxy.
- `packages/transport-client/src/subagents.ts` (new) + `src/index.ts` — fetch + hook.
- `apps/web/components/studio/subagents-view.tsx` — the panel.
- `apps/web/test/subagents-panel.test.mjs` (new) — regression.
- `docs/adr/0016-subagent-activity-is-an-optional-adapter-surface.md` (new), `AGENTS.md` — docs.

---

### Task 1: Seam vocabulary — `SubagentRun` + capability

**Files:**
- Modify: `packages/transport/src/types.ts`, `packages/transport/src/runtime.ts`, `packages/transport/src/seams.ts`, `packages/transport/src/index.ts`
- Modify: `packages/transport-openclaw/src/binding.ts:57-64`, `packages/transport-dsh/src/binding.ts:88-99`
- Modify: `packages/contract-tests/test/conformance.test.ts:75-82`, `services/transport-service/test/injected-plugins.test.ts:13-17`, `services/transport-service/test/composition-settings.test.ts:32-36`, `services/transport-service/test/fixtures/per-project-runtime.ts:39-46`
- Test: `packages/transport/test/seams.test.ts`

**Interfaces:**
- Produces:
  - `type SubagentRun = { id: string; parentId: string; label?: string; provider?: string; status: RunStatus; stopReason?: string; startedAt: string; finishedAt?: string }`
  - `RuntimeAdapter.subagents?(sessionKey: string): Promise<SubagentRun[]>`
  - `RuntimeCapabilities.subagents: boolean`

- [ ] **Step 1: Add the type and interface**

In `packages/transport/src/types.ts`, change the import line to include `RunStatus`:

```ts
import type { Id, Run, RunStatus } from "@science-studio/record";
```

Above `RuntimeAdapter` (after `CommandDescriptor`), add:

```ts
/**
 * One delegated (subagent) run as a runtime reports it. LIVE state: assembled
 * by the adapter from runtime events and never persisted, so it is gone when
 * the adapter (or the process) is.
 */
export interface SubagentRun {
  /** Runtime-assigned child identity (dsh: the child session id). */
  id: string;
  /** The Science Studio Session this run was delegated from. */
  parentId: Id;
  /** Best-effort display label (dsh: the child's descriptor label). */
  label?: string;
  /** Spawn mechanism / provider name (dsh: "spawn" | "fork"). */
  provider?: string;
  /** Reuses the record's Run status vocabulary. */
  status: RunStatus;
  /** Richer runtime stop reason when one exists (dsh: max-tokens, refusal, …). */
  stopReason?: string;
  /** ISO timestamps stamped by the adapter (the wire carries none). */
  startedAt: string;
  finishedAt?: string;
}
```

In the same file's `RuntimeAdapter` interface, after `listCommands?` add:

```ts
  /**
   * Live subagent runs delegated from one canonical session key. OPTIONAL:
   * gate on `capabilities.subagents` rather than forcing a no-op on every
   * runtime. The list is best-effort live state, not a persisted record.
   */
  subagents?(sessionKey: string): Promise<SubagentRun[]>;
```

In `packages/transport/src/runtime.ts`, add to `RuntimeCapabilities` after `perSessionCwd`:

```ts
  /** `RuntimeAdapter.subagents()` is available (live subagent activity). */
  subagents: boolean;
```

- [ ] **Step 2: Export the type from both entries**

In `packages/transport/src/seams.ts`, add `SubagentRun,` to the `from "./types.js"` export list (next to `CommandDescriptor`).
In `packages/transport/src/index.ts`, add `SubagentRun,` to the same `from "./seams.js"` list.

- [ ] **Step 3: Write the failing type-usage test**

Append to `packages/transport/test/seams.test.ts`:

```ts
import type { SubagentRun } from "../src/seams.js";

test("the SubagentRun view type is importable and usable", () => {
  const run: SubagentRun = {
    id: "child-1",
    parentId: "sess-1",
    label: "Literature review",
    provider: "spawn",
    status: "running",
    startedAt: "2026-09-17T00:00:00.000Z",
  };
  assert.equal(run.status, "running");
});
```

(Move the `import type` to the top with the other imports if the linter complains about import order.)

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -w @science-studio/transport`
Expected: FAIL — `Module '"../src/seams.js"' has no exported member 'SubagentRun'` (or build error).

- [ ] **Step 5: Update every capability literal**

Add `subagents: false,` (or `true` for dsh) to each `RuntimeCapabilities` literal:
- `packages/transport-openclaw/src/binding.ts` → `false`
- `packages/transport-dsh/src/binding.ts` (`DSH_CAPABILITIES`) → `true`
- `packages/contract-tests/test/conformance.test.ts` (fake factory) → `false`
- `services/transport-service/test/injected-plugins.test.ts` → `false`
- `services/transport-service/test/composition-settings.test.ts` → `false`
- `services/transport-service/test/fixtures/per-project-runtime.ts` → `false`

- [ ] **Step 6: Build and run the tests**

Run: `npm run build -w @science-studio/transport && npm test -w @science-studio/transport`
Expected: PASS. Then `npm run build` (the whole chain) to confirm no literal was missed.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/transport packages/transport-openclaw/src/binding.ts packages/transport-dsh/src/binding.ts packages/contract-tests/test/conformance.test.ts services/transport-service/test
git commit -m "feat(transport): add the optional SubagentRun seam surface"
```

---

### Task 2: `SubagentRegistry`

**Files:**
- Create: `packages/transport-dsh/src/subagents.ts`
- Test: `packages/transport-dsh/test/subagents.test.ts`

**Interfaces:**
- Consumes: `SubagentRun` (Task 1).
- Produces:
  - `class SubagentRegistry`
    - `constructor(resolveSessionKey: (rootHarnessId: string) => string | undefined, now?: () => string)`
    - `noteStarted(parentSessionId: string, childSessionId: string): void`
    - `noteDescriptor(childSessionId: string, info: { label?: string; provider?: string }): void`
    - `noteFinished(childSessionId: string, info: { provider?: string; status: "ok" | "error"; stopReason?: string }): void`
    - `list(sessionKey: string): SubagentRun[]`

- [ ] **Step 1: Write the failing test**

Create `packages/transport-dsh/test/subagents.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SubagentRegistry } from "../src/subagents.js";

function registry(resolve: (id: string) => string | undefined) {
  let tick = 0;
  return new SubagentRegistry(resolve, () => `t${tick++}`);
}

test("a started child is running until finished", () => {
  const reg = registry((root) => (root === "root-1" ? "sess-1" : undefined));
  reg.noteStarted("root-1", "child-1");
  const [run] = reg.list("sess-1");
  assert.equal(run?.id, "child-1");
  assert.equal(run?.parentId, "sess-1");
  assert.equal(run?.status, "running");
  assert.equal(run?.startedAt, "t0");
  assert.equal(run?.finishedAt, undefined);

  reg.noteFinished("child-1", { provider: "spawn", status: "ok", stopReason: "completed" });
  const [done] = reg.list("sess-1");
  assert.equal(done?.status, "completed");
  assert.equal(done?.stopReason, "completed");
  assert.equal(done?.provider, "spawn");
  assert.equal(done?.finishedAt, "t1");
});

test("a descriptor enriches the entry with a label", () => {
  const reg = registry(() => "sess-1");
  reg.noteStarted("root-1", "child-1");
  reg.noteDescriptor("child-1", { label: "Literature review", provider: "fork" });
  const [run] = reg.list("sess-1");
  assert.equal(run?.label, "Literature review");
  assert.equal(run?.provider, "fork");
});

test("stop reasons map onto the Run status vocabulary", () => {
  const cases: Array<[string, "ok" | "error", string]> = [
    ["completed", "ok", "completed"],
    ["aborted", "ok", "aborted"],
    ["error", "ok", "error"],
    ["max-tokens", "ok", "completed"],
    ["refusal", "ok", "completed"],
  ];
  for (const [stopReason, status, expected] of cases) {
    const reg = registry(() => "sess-1");
    reg.noteStarted("root-1", "child-1");
    reg.noteFinished("child-1", { status, stopReason });
    assert.equal(reg.list("sess-1")[0]?.status, expected, `stopReason ${stopReason}`);
  }
  const reg = registry(() => "sess-1");
  reg.noteStarted("root-1", "child-1");
  reg.noteFinished("child-1", { status: "error" });
  assert.equal(reg.list("sess-1")[0]?.status, "error", "an error status with no reason is an error");
});

test("a grandchild walks its lineage to the root session", () => {
  const reg = registry((root) => (root === "root-1" ? "sess-1" : undefined));
  reg.noteStarted("root-1", "child-1");
  reg.noteStarted("child-1", "grandchild-1");
  assert.deepEqual(
    reg.list("sess-1").map((run) => run.id).sort(),
    ["child-1", "grandchild-1"],
  );
  assert.deepEqual(reg.list("sess-2"), []);
});

test("entries are scoped to their session and newest-first", () => {
  const reg = new SubagentRegistry(
    (root) => (root === "root-1" ? "sess-1" : root === "root-2" ? "sess-2" : undefined),
    () => `t${Math.random()}`,
  );
  reg.noteStarted("root-1", "a");
  reg.noteStarted("root-2", "b");
  assert.deepEqual(reg.list("sess-1").map((r) => r.id), ["a"]);
  assert.deepEqual(reg.list("sess-2").map((r) => r.id), ["b"]);
});

test("an unresolvable root is not listed but is not destroyed", () => {
  let live = true;
  const reg = registry((root) => (live && root === "root-1" ? "sess-1" : undefined));
  reg.noteStarted("root-1", "child-1");
  assert.equal(reg.list("sess-1").length, 1);
  live = false;
  assert.deepEqual(reg.list("sess-1"), [], "an unresolved root is skipped, never shown as an orphan");
  live = true;
  assert.equal(reg.list("sess-1").length, 1, "a read must not delete — it raced the first turn");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build -w @science-studio/transport && npm test -w @science-studio/transport-dsh`
Expected: FAIL — `Cannot find module '../src/subagents.js'`.

- [ ] **Step 3: Implement the registry**

Create `packages/transport-dsh/src/subagents.ts`:

```ts
/**
 * The adapter-side, in-memory subagent ledger. It folds the harness child's
 * `subagent.started` / `subagent.finished` notifications and its child-session
 * `subagent/descriptor` events into one live view per Science Studio Session.
 *
 * LIVE-ONLY: nothing is persisted; the ledger is dropped with the adapter (and
 * the child generation it observed). The harness wire carries no timestamps, so
 * the adapter stamps them on arrival. The SDK's completion `status` is a coarse
 * ok/error; the richer `stopReason` is what the status is derived from.
 *
 * This module stays structural: it imports no `@deepseek-ai/*` type, so a
 * harness pin that moves a payload shape degrades to an unlabeled entry rather
 * than a crash (the same rule as the child bridge plugin).
 */
import type { SubagentRun } from "@science-studio/transport";

export interface SubagentDescriptorInfo {
  label?: string;
  provider?: string;
}

export interface SubagentFinishedInfo {
  provider?: string;
  status: "ok" | "error";
  stopReason?: string;
}

interface Entry {
  id: string;
  parentHarnessId: string;
  label?: string;
  provider?: string;
  status: SubagentRun["status"];
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
}

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

export class SubagentRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    /** Map a ROOT harness session id back to its Science Studio session key. */
    private readonly resolveSessionKey: (rootHarnessId: string) => string | undefined,
    /** Clock seam for deterministic tests. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  noteStarted(parentSessionId: string, childSessionId: string): void {
    if (parentSessionId === childSessionId || this.entries.has(childSessionId)) return;
    this.entries.set(childSessionId, {
      id: childSessionId,
      parentHarnessId: parentSessionId,
      status: "running",
      startedAt: this.now(),
    });
  }

  noteDescriptor(childSessionId: string, info: SubagentDescriptorInfo): void {
    const entry = this.entries.get(childSessionId);
    if (!entry) return;
    if (info.label !== undefined) entry.label = info.label;
    if (info.provider !== undefined) entry.provider = info.provider;
  }

  noteFinished(childSessionId: string, info: SubagentFinishedInfo): void {
    const entry = this.entries.get(childSessionId);
    if (!entry) return;
    entry.status = settleStatus(info.status, info.stopReason);
    if (info.provider !== undefined) entry.provider = info.provider;
    if (info.stopReason !== undefined) entry.stopReason = info.stopReason;
    entry.finishedAt = this.now();
  }

  /** The live runs for one Session, newest first. A read is NON-destructive:
   *  an entry whose root does not currently resolve (a `/new` remint, or the
   *  brief window before `driveTurn` publishes a freshly minted harness id) is
   *  skipped, never deleted — a destructive read raced the first turn and threw
   *  an entry away before its `finished` arrived. */
  list(sessionKey: string): SubagentRun[] {
    const out: SubagentRun[] = [];
    for (const entry of this.entries.values()) {
      const root = this.rootOf(entry);
      const key = this.resolveSessionKey(root);
      if (key === undefined || key !== sessionKey) continue;
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

  /** Walk parent links until one is not itself a tracked child; that parent is
   *  the root session the delegation belongs to. */
  private rootOf(entry: Entry): string {
    let root = entry.id;
    let parent = entry.parentHarnessId;
    const seen = new Set<string>([root]);
    while (!seen.has(parent)) {
      seen.add(parent);
      const parentEntry = this.entries.get(parent);
      if (!parentEntry) return parent;
      root = parent;
      parent = parentEntry.parentHarnessId;
    }
    return root;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @science-studio/transport-dsh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-dsh/src/subagents.ts packages/transport-dsh/test/subagents.test.ts
git commit -m "feat(dsh): fold subagent notifications into a live registry"
```

---

### Task 3: Wire the registry into the adapter

**Files:**
- Modify: `packages/transport-dsh/src/client.ts`, `packages/transport-dsh/src/adapter.ts`, `packages/transport-dsh/src/index.ts`
- Test: `packages/transport-dsh/test/adapter.test.ts` (add a case and extend the fakes)

**Interfaces:**
- Consumes: `SubagentRegistry` (Task 2), `SubagentRun` (Task 1).
- Produces:
  - `DshTurnClient.subscribeNotifications?(listener: (notification: HarnessNotification) => void): () => void`
  - `DshRuntimeAdapter.subagents(sessionKey: string): Promise<SubagentRun[]>`
  - `DshRuntimeAdapterOptions.now?: () => string`

- [ ] **Step 1: Write the failing test**

In `packages/transport-dsh/test/adapter.test.ts`, add the import at the top:

```ts
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
```

Extend `FakeDshClient` with a notification seam:

```ts
class FakeDshClient implements DshTurnClient {
  started = false;
  readonly prompts: string[] = [];
  readonly sessionIds: string[] = [];
  private listener: ((notification: HarnessNotification) => void) | null = null;
  constructor(private readonly script: (sessionId: string, text: string) => SessionEvent[]) {}
  async start(): Promise<void> {
    this.started = true;
  }
  async close(): Promise<void> {}
  subscribeNotifications(listener: (notification: HarnessNotification) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  emit(notification: HarnessNotification): void {
    this.listener?.(notification);
  }
  async runTurn(
    sessionId: string,
    text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    this.prompts.push(text);
    this.sessionIds.push(sessionId);
    for (const event of this.script(sessionId, text)) onEvent(event);
  }
}
```

Append the new test at the end of the file:

```ts
test("a standing subscription reports live subagent runs for the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-subagents-"));
  const store = new FakeRecordStore();
  const client = new FakeDshClient(() => completedReply("am1", "Hello from dsh."));
  const adapter = new DshRuntimeAdapter({
    createClient: () => client,
    transcriptDir: dir,
    now: () => "2026-09-17T00:00:00.000Z",
  });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "delegate" } },
    ]));
    const parent = client.sessionIds[0]!;
    assert.equal(await adapter.subagents("sess-1").then((l) => l.length), 0, "no subagents yet");

    client.emit({
      method: "subagent.started",
      params: { parentSessionId: parent, childSessionId: "child-1" },
    });
    client.emit({
      method: "session.event",
      params: {
        sessionId: "child-1",
        event: { type: "subagent/descriptor", data: { label: "Literature review", provider: "spawn" } },
      },
    });
    const running = await adapter.subagents("sess-1");
    assert.equal(running.length, 1);
    assert.equal(running[0]!.id, "child-1");
    assert.equal(running[0]!.parentId, "sess-1");
    assert.equal(running[0]!.label, "Literature review");
    assert.equal(running[0]!.status, "running");
    assert.equal(running[0]!.startedAt, "2026-09-17T00:00:00.000Z");
    assert.deepEqual(await adapter.subagents("other"), [], "only the owning session lists it");

    client.emit({
      method: "subagent.finished",
      params: {
        parentSessionId: parent,
        childSessionId: "child-1",
        provider: "spawn",
        status: "ok",
        stopReason: "completed",
      },
    });
    const done = await adapter.subagents("sess-1");
    assert.equal(done[0]!.status, "completed");
    assert.equal(done[0]!.stopReason, "completed");
    assert.equal(done[0]!.finishedAt, "2026-09-17T00:00:00.000Z");
  } finally {
    await adapter.abort();
    await rm(dir, { recursive: true, force: true });
  }
});
```

`subscribeNotifications` is OPTIONAL on `DshTurnClient` (the adapter gates on
`typeof === "function"`), so the other dsh test fakes that implement
`DshTurnClient` (`behavior.test.ts`, `launch-cwd.test.ts`, `lifecycle-case.ts`,
`command-case.ts`, `slash-command.test.ts`, `watch.test.ts`,
`project-launch.test.ts`) compile unchanged. Only the `FakeDshClient` above
needs the method, because it is the one that emits notifications.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @science-studio/transport-dsh`
Expected: FAIL — `subscribeNotifications` is not a member of `DshTurnClient` / `adapter.subagents is not a function`.

- [ ] **Step 3: Add the client subscription**

In `packages/transport-dsh/src/client.ts`, keep the existing value import
(`import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";`) and add a
type-only import next to it:

```ts
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
```

Add to the `DshTurnClient` interface (OPTIONAL — a test fake, or a runtime
without the surface, may omit it; the adapter gates on the method's presence):

```ts
  /**
   * Subscribe to this child's notifications for the WHOLE runtime (every
   * session), independent of any run. This is what keeps a background
   * subagent's status live after the parent turn has gone idle, when the
   * per-run stream has already closed. Returns an unsubscribe.
   * OPTIONAL: gate on method presence, not on a capability flag.
   */
  subscribeNotifications?(listener: (notification: HarnessNotification) => void): () => void;
```

Add the implementation to `SdkDshTurnClient`:

```ts
  subscribeNotifications(listener: (notification: HarnessNotification) => void): () => void {
    const subscription = this.harness.client.subscribe();
    void (async () => {
      try {
        for await (const notification of subscription) listener(notification);
      } catch {
        /* the runtime closed: the adapter is being torn down too */
      }
    })();
    return () => subscription.close();
  }
```

- [ ] **Step 4: Wire the adapter**

Also fix `packages/transport-dsh/src/behavior.ts` `driveTurn`: it currently
writes `harnessSessions.set(sessionKey, harnessSessionId)` only AFTER
`client.runTurn` resolves, so a poll during the first turn cannot resolve a
just-spawned subagent's parent and (with the old destructive read) dropped it
for good. Publish the mapping BEFORE the prompt, restore the previous mapping on
a non-collision failure, and update it again on the collision retry:

```ts
    const previous = harnessSessions.get(sessionKey);
    let harnessSessionId = previous ?? nextHarnessSessionId(sessionKey);
    // Publish the mapping for the WHOLE turn: subagent notifications arrive
    // DURING the prompt, and the live registry resolves their parent root to
    // this Session while it runs.
    harnessSessions.set(sessionKey, harnessSessionId);
    try {
      await client.runTurn(harnessSessionId, text, (event) => run.ingest(event));
    } catch (err) {
      if (!isSessionAlreadyExists(err)) {
        if (previous === undefined) harnessSessions.delete(sessionKey);
        else harnessSessions.set(sessionKey, previous);
        throw err;
      }
      const collided = harnessSessionId;
      harnessSessionId = `${collided}-retry`;
      harnessSessions.set(sessionKey, harnessSessionId);
      log(
        `harness session "${collided}" is already taken in this harness home; continuing on "${harnessSessionId}" (the agent does not carry the prior conversation across restarts — the Science Studio transcript mirror still does)`,
        err,
      );
      await client.runTurn(harnessSessionId, text, (event) => run.ingest(event));
    }
    harnessSessions.set(sessionKey, harnessSessionId);
```

Add a regression test that emits `subagent.started` DURING the first `run()` and
asserts both the mid-run read and the post-run read list it.

In `packages/transport-dsh/src/adapter.ts`:
- Add `SubagentRun` to the `@science-studio/transport` type imports.
- Add `import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";` and `import { SubagentRegistry } from "./subagents.js";`.
- Add `now?: () => string;` to `DshRuntimeAdapterOptions` with the doc "Test seam: deterministic timestamps for the subagent registry."
- Add fields:

```ts
  private readonly subagentRegistry: SubagentRegistry;
  private subagentWatchAttached = false;
```

- In the constructor, after `this.createBridge = ...`, add:

```ts
    this.subagentRegistry = new SubagentRegistry(
      (harnessId) => this.sessionKeyForHarnessId(harnessId),
      options.now,
    );
```

- Add the methods:

```ts
  /** The Science Studio session key a harness session id belongs to, if known. */
  private sessionKeyForHarnessId(harnessId: string): string | undefined {
    for (const [key, id] of this.harnessSessions) if (id === harnessId) return key;
    return undefined;
  }

  /** Attach the child-wide notification subscription ONCE per child generation.
   *  The method is optional, so a client without it simply reports nothing. */
  private attachSubagents(): void {
    const client = this.client;
    if (this.subagentWatchAttached || !client || typeof client.subscribeNotifications !== "function") return;
    this.subagentWatchAttached = true;
    client.subscribeNotifications((notification) => this.captureSubagent(notification));
  }

  /**
   * Fold one harness notification into the registry. Structural and total: an
   * unrecognized shape is ignored, never thrown — this listener sits beside the
   * run stream and must not break a turn.
   */
  private captureSubagent(notification: HarnessNotification): void {
    const params = (notification.params ?? {}) as Record<string, unknown>;
    if (notification.method === "subagent.started") {
      const parent = params["parentSessionId"];
      const child = params["childSessionId"];
      if (typeof parent === "string" && typeof child === "string") {
        this.subagentRegistry.noteStarted(parent, child);
      }
      return;
    }
    if (notification.method === "subagent.finished") {
      const child = params["childSessionId"];
      if (typeof child !== "string") return;
      this.subagentRegistry.noteFinished(child, {
        status: params["status"] === "error" ? "error" : "ok",
        ...(typeof params["provider"] === "string" ? { provider: params["provider"] } : {}),
        ...(typeof params["stopReason"] === "string" ? { stopReason: params["stopReason"] } : {}),
      });
      return;
    }
    if (notification.method !== "session.event") return;
    const child = params["sessionId"];
    const event = params["event"] as { type?: unknown; data?: unknown } | undefined;
    if (typeof child !== "string" || event?.type !== "subagent/descriptor") return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    this.subagentRegistry.noteDescriptor(child, {
      ...(typeof data["label"] === "string" ? { label: data["label"] } : {}),
      ...(typeof data["provider"] === "string" ? { provider: data["provider"] } : {}),
    });
  }

  async subagents(sessionKey: string): Promise<SubagentRun[]> {
    // No init wait: the registry is constructor-owned and empty before init, so
    // a read is always answerable (the seam read must not hang a cold adapter).
    return this.subagentRegistry.list(sessionKey);
  }
```

- Replace `ensureStarted` with an async form that attaches the subscription after a successful start and clears the flag on failure:

```ts
  private ensureStarted(): Promise<void> {
    if (!this.client) return Promise.reject(new Error("dsh adapter not initialized"));
    if (!this.ready) {
      this.ready = (async () => {
        try {
          await this.client!.start();
          this.attachSubagents();
        } catch (err) {
          this.ready = null;
          this.subagentWatchAttached = false;
          console.error("[dsh] runtime start failed (check DSH_HOME/DSH_PROFILE and the LLM credentials)", err);
          throw new Error(`dsh runtime not ready: ${String(err)}`);
        }
      })();
    }
    return this.ready;
  }
```

In `packages/transport-dsh/src/binding.ts`, ensure `subagents: true` was added in Task 1.

- [ ] **Step 5: Export what the tests need**

No new runtime exports are required (`subagents.ts` is internal); if the test imports `SubagentRegistry`, it does so by relative path. Confirm `packages/transport-dsh/src/index.ts` still builds.

- [ ] **Step 6: Run the tests**

Run: `npm run build -w @science-studio/transport && npm test -w @science-studio/transport-dsh`
Expected: PASS (including the new adapter case).

- [ ] **Step 7: Commit**

```bash
git add packages/transport-dsh/src packages/transport-dsh/test/adapter.test.ts
git commit -m "feat(dsh): report live subagent runs from a standing subscription"
```

---

### Task 4: The shared contract suite

**Files:**
- Create: `packages/contract-tests/src/subagents.ts`
- Modify: `packages/contract-tests/src/index.ts`, `packages/transport-dsh/test/conformance.test.ts`
- Test: `packages/contract-tests/test/conformance.test.ts` (optional self-check)

**Interfaces:**
- Consumes: `RuntimeAdapter` (seams), `SubagentRun` (Task 1).
- Produces: `testSubagents(name: string, make: () => SubagentsCase | Promise<SubagentsCase>): void` and `type SubagentsCase = { adapter: RuntimeAdapter; sessionKey: string }`.

- [ ] **Step 1: Write the suite**

Create `packages/contract-tests/src/subagents.ts`:

```ts
/**
 * Conformance suite for `RuntimeAdapter.subagents` — the OPTIONAL live subagent
 * surface. A runtime that advertises `capabilities.subagents` must implement the
 * method, and a read must always be answerable: the list is either empty or made
 * of well-formed `SubagentRun`s, never a throw and never a hang.
 *
 * The suite cannot fabricate runtime activity, so it asserts the shape and the
 * empty case; a runtime's own tests pin its mapping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeAdapter } from "@science-studio/transport/seams";

export interface SubagentsCase {
  /** The adapter under test, already constructed the way its runtime needs. */
  adapter: RuntimeAdapter;
  /** A session key the adapter could serve. */
  sessionKey: string;
}

export function testSubagents(
  name: string,
  make: () => SubagentsCase | Promise<SubagentsCase>,
): void {
  test(`${name}: an advertised subagent surface answers a well-formed list`, async () => {
    const { adapter, sessionKey } = await make();
    assert.equal(
      typeof adapter.subagents,
      "function",
      "capabilities.subagents is true, so RuntimeAdapter.subagents must be implemented",
    );
    const runs = await adapter.subagents!(sessionKey);
    assert.ok(Array.isArray(runs), "subagents() must resolve to an array");
    for (const run of runs) {
      assert.equal(typeof run.id, "string");
      assert.equal(typeof run.parentId, "string");
      assert.ok(
        run.status === "running" ||
          run.status === "completed" ||
          run.status === "aborted" ||
          run.status === "error",
        `unexpected subagent status: ${String(run.status)}`,
      );
      assert.equal(typeof run.startedAt, "string");
    }
  });

  test(`${name}: an unknown session lists nothing`, async () => {
    const { adapter } = await make();
    assert.deepEqual(await adapter.subagents!("__no_such_session__"), []);
  });
}
```

- [ ] **Step 2: Pin capability agreement in the factory suite**

In `packages/contract-tests/src/runtime-factory.ts`, inside the "creates an adapter for its own runtime" test, after the existing `capabilities.approvals` assertion, add:

```ts
    assert.equal(
      factory.capabilities.subagents,
      typeof adapter.subagents === "function",
      "capabilities.subagents must match whether the adapter implements subagents()",
    );
```

This keeps every implementation honest about the optional surface (dsh advertises `true` and implements it; openclaw and the fakes advertise `false` and omit it).

- [ ] **Step 3: Export the suite**

In `packages/contract-tests/src/index.ts`, add:

```ts
export { testSubagents, type SubagentsCase } from "./subagents.js";
```

- [ ] **Step 4: Run it from the dsh package**

In `packages/transport-dsh/test/conformance.test.ts`, add `testSubagents` to the import and register it:
```ts
import {
  testAdapterLifecycle,
  testResolveSessionKey,
  testRuntimeFactory,
  testSubagents,
} from "@science-studio/contract-tests";
```

```ts
/**
 * …and the SHARED optional subagent surface: an advertised capability must be a
 * real method that always answers an array (dsh implements it live-only).
 */
testSubagents("dsh adapter subagents", () => ({
  adapter: new DshRuntimeAdapter(),
  sessionKey: "sess-1",
}));
```

- [ ] **Step 5: Run the tests**

Run: `npm run build -w @science-studio/contract-tests && npm run build -w @science-studio/transport-dsh && npm test -w @science-studio/contract-tests && npm test -w @science-studio/transport-dsh`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contract-tests packages/transport-dsh/test/conformance.test.ts
git commit -m "test(contract-tests): pin the optional subagent surface"
```

---

### Task 5: Service route

**Files:**
- Modify: `services/transport-service/src/server.ts` (after the commands route, around line 370)
- Test: `services/transport-service/test/subagents.test.ts` (new)

**Interfaces:**
- Consumes: `RuntimeAdapter.subagents?` (Task 1), `canonicalSessionKey` + `scope.acquire` (existing).
- Produces: `GET /api/transport/subagents?projectId=&threadId=` → `{ subagents: SubagentRun[] }`.

- [ ] **Step 1: Write the failing test**

Create `services/transport-service/test/subagents.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { RuntimeAdapter, SessionState, SubagentRun, TransportCommand } from "@science-studio/transport";
import { createTransportService } from "../src/index.js";

async function withAdapter<T>(adapter: RuntimeAdapter, fn: (base: string) => Promise<T>): Promise<T> {
  const app = await createTransportService({ adapters: [adapter] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(base);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

const emptyAdapter: RuntimeAdapter = {
  runtime: "fake",
  init: async () => {},
  run: async function* (_session: SessionState, _commands: TransportCommand[]) {},
  abort: () => {},
};

test("GET /api/transport/subagents returns the Project adapter's live list", async () => {
  const run: SubagentRun = {
    id: "child-1",
    parentId: "sess-1",
    label: "Literature review",
    provider: "spawn",
    status: "running",
    startedAt: "2026-09-17T00:00:00.000Z",
  };
  const adapter: RuntimeAdapter = { ...emptyAdapter, subagents: async () => [run] };
  await withAdapter(adapter, async (base) => {
    const res = await fetch(`${base}/api/transport/subagents?projectId=p1&threadId=sess-1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { subagents: [run] });
  });
});

test("GET /api/transport/subagents answers empty when the runtime has no surface", async () => {
  await withAdapter(emptyAdapter, async (base) => {
    const res = await fetch(`${base}/api/transport/subagents?projectId=p1&threadId=sess-1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { subagents: [] });
  });
});

test("GET /api/transport/subagents degrades to empty when the adapter throws", async () => {
  const adapter: RuntimeAdapter = {
    ...emptyAdapter,
    subagents: async () => {
      throw new Error("boom");
    },
  };
  await withAdapter(adapter, async (base) => {
    const res = await fetch(`${base}/api/transport/subagents?projectId=p1&threadId=sess-1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { subagents: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build -w @science-studio/transport && npm test -w @science-studio/transport-service`
Expected: FAIL — the route answers 404, so `res.status !== 200` (or the deep-equal fails).

- [ ] **Step 3: Add the route**

In `services/transport-service/src/server.ts`, import `canonicalSessionKey` is already imported (line 36). Add `SubagentRun` to the transport type imports at the top. Insert after the commands route:

```ts
  // -- Live subagent activity (the dsh adapter's optional surface) -----------
  app.get("/api/transport/subagents", async (request) => {
    // Like the catalog, the subagent ledger belongs to the Project's OWN
    // adapter (one per Project, docs/adr/0008). A runtime without the surface
    // answers empty so the panel needs no runtime-specific branch.
    const { environment, threadId } = await scope.acquire(request);
    const adapter = environment.adapter;
    if (typeof adapter.subagents !== "function") return { subagents: [] };
    const sessionId = canonicalSessionKey(adapter, threadId);
    try {
      return { subagents: await adapter.subagents(sessionId) };
    } catch (err) {
      console.error("[transport-service] subagents.list failed", err);
      return { subagents: [] };
    }
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @science-studio/transport-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/transport-service/src/server.ts services/transport-service/test/subagents.test.ts
git commit -m "feat(service): read the adapter's live subagent list"
```

---

### Task 6: Web proxy route

**Files:**
- Create: `apps/web/app/api/transport/subagents/route.ts`
- Test: covered by the Task 9 e2e.

**Interfaces:**
- Consumes: `proxyToService` (`apps/web/lib/service-proxy.ts`).
- Produces: `GET /api/transport/subagents` (relayed).

- [ ] **Step 1: Create the proxy**

Create `apps/web/app/api/transport/subagents/route.ts`, mirroring `transport/commands/route.ts`:

```ts
/**
 * Proxy for the live subagent-activity endpoint.
 *
 * The transport-service serves the Project adapter's live subagent list at
 * `/api/transport/subagents` (JSON). The Subagents panel polls it while open.
 * A failed upstream degrades to an EMPTY list so the panel shows its neutral
 * empty state rather than an error.
 */
import { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const { search } = new URL(request.url);
  const response = await proxyToService(request, {
    path: `/api/transport/subagents${search}`,
    headers: { accept: "application/json" },
  });

  if (response.status < 200 || response.status >= 300) {
    return NextResponse.json({ subagents: [] });
  }
  return response;
}
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck -w @science-studio/web`
Expected: PASS (the e2e in Task 9 exercises the behavior).

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/transport/subagents/route.ts
git commit -m "feat(web): proxy the live subagent endpoint"
```

---

### Task 7: Client fetch + polling hook

**Files:**
- Create: `packages/transport-client/src/subagents.ts`
- Modify: `packages/transport-client/src/index.ts`

**Interfaces:**
- Consumes: `SubagentRun` (Task 1).
- Produces:
  - `DEFAULT_TRANSPORT_API = "/api/transport"`
  - `fetchSubagents(api: string, scope: { projectId: string | null; threadId: string | null }, signal?: AbortSignal): Promise<SubagentRun[]>`
  - `useSubagents(options: { api?: string; projectId: string | null; threadId: string | null; enabled: boolean; intervalMs?: number }): { subagents: SubagentRun[] }`

- [ ] **Step 1: Create the module**

Create `packages/transport-client/src/subagents.ts`:

```ts
"use client";

import { useEffect, useState } from "react";
import type { SubagentRun } from "@science-studio/transport";

/** The same-origin transport base (the web proxy path). */
export const DEFAULT_TRANSPORT_API = "/api/transport";

export interface SubagentScope {
  projectId: string | null;
  threadId: string | null;
}

/** The Project adapter's live subagent list. Throws on a non-2xx response. */
export async function fetchSubagents(
  api: string,
  scope: SubagentScope,
  signal?: AbortSignal,
): Promise<SubagentRun[]> {
  const query = new URLSearchParams();
  if (scope.projectId) query.set("projectId", scope.projectId);
  if (scope.threadId) query.set("threadId", scope.threadId);
  const res = await fetch(`${api}/subagents?${query.toString()}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`subagents ${res.status}`);
  const body = (await res.json()) as { subagents?: SubagentRun[] };
  return body.subagents ?? [];
}

export interface UseSubagentsOptions {
  /** Transport base; defaults to the same-origin `/api/transport`. */
  api?: string;
  projectId: string | null;
  threadId: string | null;
  /** False makes NO request (module collapsed, or no active session). */
  enabled: boolean;
  /** Poll cadence in ms (default 1500). */
  intervalMs?: number;
}

/**
 * Polls the live subagent list while enabled. A failed poll keeps the last good
 * list instead of blanking the panel; an in-flight request is aborted on
 * unmount or a scope change so a stale response cannot overwrite a newer scope.
 */
export function useSubagents(options: UseSubagentsOptions): { subagents: SubagentRun[] } {
  const { api = DEFAULT_TRANSPORT_API, projectId, threadId, enabled, intervalMs = 1500 } = options;
  const [subagents, setSubagents] = useState<SubagentRun[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const next = await fetchSubagents(api, { projectId, threadId }, controller.signal);
        if (active) setSubagents(next);
      } catch {
        // Transient failure (or abort): keep the previous list.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [api, projectId, threadId, enabled, intervalMs]);

  return { subagents };
}
```

- [ ] **Step 2: Export it**

In `packages/transport-client/src/index.ts`, add:

```ts
export {
  DEFAULT_TRANSPORT_API,
  fetchSubagents,
  useSubagents,
  type SubagentScope,
  type UseSubagentsOptions,
} from "./subagents.js";
```

- [ ] **Step 3: Build**

Run: `npm run build -w @science-studio/transport-client`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/transport-client/src
git commit -m "feat(transport-client): poll the live subagent list"
```

---

### Task 8: The Subagents panel

**Files:**
- Modify: `apps/web/components/studio/subagents-view.tsx`

**Interfaces:**
- Consumes: `useSubagents` (Task 7), `studio-store` (`projectId`, `activeSessionId`, `rightSections`, `rightHeights`).

- [ ] **Step 1: Replace the skeleton**

Replace the whole of `apps/web/components/studio/subagents-view.tsx` with:

```tsx
"use client";

import { Bot } from "lucide-react";
import { useSubagents } from "@science-studio/transport-client";
import type { SubagentRun } from "@science-studio/transport";
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

/** A short, human-scannable child id when no label was reported. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function SubagentRow({ run }: { run: SubagentRun }) {
  return (
    <li className="border-border/60 flex flex-col gap-1 rounded-md border px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium" title={run.label ?? run.id}>
          {run.label ?? shortId(run.id)}
        </span>
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

/** The Subagents module: the active Session's live dsh subagent runs. */
export function SubagentsView() {
  const open = useStudioStore((s) => s.rightSections.subagents);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.subagents);
  const projectId = useStudioStore((s) => s.projectId);
  const activeSessionId = useStudioStore((s) => s.activeSessionId);

  const enabled = open && projectId !== null && activeSessionId !== null;
  const { subagents } = useSubagents({ projectId, threadId: activeSessionId, enabled });

  return (
    <SidebarSection
      section="subagents"
      title="Subagents"
      icon={Bot}
      open={open}
      onOpenChange={() => toggleRightSection("subagents")}
      style={open ? { height } : undefined}
    >
      {subagents.length === 0 ? (
        <ModuleEmptyState
          icon={Bot}
          message="No subagents yet."
          hint="Subagent runs will appear here."
        />
      ) : (
        <ul
          className="flex h-full flex-col gap-1 overflow-auto p-2"
          aria-label="Subagent runs"
        >
          {subagents.map((run) => (
            <SubagentRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </SidebarSection>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck -w @science-studio/web`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/studio/subagents-view.tsx
git commit -m "feat(web): show live subagent runs in the Subagents panel"
```

---

### Task 9: Web regression test

**Files:**
- Create: `apps/web/test/subagents-panel.test.mjs`

**Interfaces:**
- Consumes: the harness helpers (`apps/web/test/harness.mjs`), the panel (Task 8).

- [ ] **Step 1: Write the test**

Create `apps/web/test/subagents-panel.test.mjs`:

```js
/**
 * Regression: the Subagents module renders the live subagent list polled from
 * `/api/transport/subagents`, shows its empty state when the list is empty, and
 * makes no request while collapsed.
 *
 * Prereq: `npm run build -w @science-studio/transport-client`.
 * Needs a Chromium; SKIPPED when none is found.
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

const ROWS = [
  {
    id: "child-1",
    parentId: "s1",
    label: "Literature review",
    provider: "spawn",
    status: "running",
    startedAt: "2026-09-17T00:00:00.000Z",
  },
  {
    id: "child-2",
    parentId: "s1",
    provider: "fork",
    status: "completed",
    stopReason: "completed",
    startedAt: "2026-09-17T00:00:00.000Z",
    finishedAt: "2026-09-17T00:01:00.000Z",
  },
];

test(
  "the Subagents panel renders live subagent runs and stays quiet while collapsed",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip(
        "no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one (e.g. `npx playwright install chromium`)",
      );
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

      let requests = 0;
      await page.route("**/api/transport/subagents*", (route) => {
        requests += 1;
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subagents: ROWS }),
        });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      const subagents = page.locator('[data-section="subagents"]');
      await subagents.waitFor({ timeout: 15_000 });

      // Collapsed: no empty state and NO polling request.
      assert.equal(await subagents.getByText("No subagents yet.").count(), 0);
      await page.waitForTimeout(2_500);
      assert.equal(requests, 0, "a collapsed Subagents module must not poll");

      // Expanding starts polling and renders the rows.
      await subagents.getByRole("button", { name: "Subagents" }).click();
      await subagents.getByText("Literature review").waitFor({ timeout: 10_000 });
      await subagents.getByText("Running").waitFor({ timeout: 10_000 });
      await subagents.getByText("Completed").waitFor({ timeout: 10_000 });
      assert.ok(requests >= 1, "an open Subagents module polls");
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
```

- [ ] **Step 2: Run the test**

Run: `npm run build -w @science-studio/transport-client && npm run test:e2e -w @science-studio/web`
Expected: PASS, or SKIP when no Chromium is installed (the suite reports the skip).

- [ ] **Step 3: Commit**

```bash
git add apps/web/test/subagents-panel.test.mjs
git commit -m "test(web): cover the live Subagents panel"
```

---

### Task 10: ADR + AGENTS note

**Files:**
- Create: `docs/adr/0016-subagent-activity-is-an-optional-adapter-surface.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0016-subagent-activity-is-an-optional-adapter-surface.md`:

```markdown
# Subagent activity is an optional adapter surface, live-only

The Subagents panel shows a runtime's LIVE delegated-agent runs through one new
OPTIONAL seam member, `RuntimeAdapter.subagents?(sessionKey)`, and a normalized
`SubagentRun` view. The dsh adapter assembles the list in memory from the
harness child's own notifications and never persists it; the service reads it
over `GET /api/transport/subagents`.

- **Status**: accepted
- **Context**: the pinned dsh SDK protocol already emits `subagent.started` and
  `subagent.finished`, and a child session's log carries a
  `subagent/descriptor`; every one was discarded at the adapter boundary, so
  the Subagents module had no data source. The record vocabulary for v1 is
  Project/Session/Run (docs/adr/0007) and has no place for a delegated run; a
  persist-first design would have to invent a record entity whose only reader is
  this panel. Meanwhile the transport kit's watch is a per-session transcript
  channel and does not own (or know about) adapter-global subagent state.
  *Considered and rejected*: extending `WatchSnapshot`/`StateDelta` with a
  subagent member. It would couple the shared kit and the watch protocol to a
  concept the kit does not own and force every watch consumer to understand it.
- **Decisions**:
  - **An optional method, not a new channel.** `subagents?` joins
    `listCommands?`/`subscribe?`/`approve?` as a capability the service branches
    on via `capabilities.subagents`. A runtime without it answers an empty list,
    so the route and panel stay runtime-agnostic.
  - **Live-only, in memory.** The adapter's registry is dropped with the child
    generation. No record field, no disk mirror. A restart empties the panel by
    design; the wire carries no timestamps, so the adapter stamps them.
  - **A child-wide standing subscription.** `HarnessClient.subscribe()` is
    attached once after `start()`, NOT per run: a background/continuable
    subagent can outlive the parent turn, and the per-run `session.run` channel
    closes at root idle. That is what keeps a long-lived child's status live.
  - **Structural payloads, fail soft.** The registry reads notification shapes
    structurally and never throws into the run stream (the child bridge plugin's
    rule), so a harness pin that moves a shape degrades to an unlabeled entry.
  - **Remote subagents are out of scope.** The harness only announces
    `subagent.finished` for LOCAL (in-process) children, so ACP/remote runs
    never appear. Recorded as a known limitation, not a bug.
- **Consequences**: the panel gains a live view without touching the record or
  the transcript watch. The list disappears on restart; a subagent whose
  `finished` never arrives reads `running` until the child goes away. If
  persistence or transcript drill-in is ever needed, a new record entity and a
  child-transcript capture path are the work — this decision should be revisited
  then.
```

- [ ] **Step 2: Add the AGENTS note**

In `AGENTS.md`, in the `apps/web` components bullet that describes `components/studio`, add a sentence after the Projects-pane description:

```
    the Subagents module reads the active Session's LIVE delegated-agent runs
    (the optional `RuntimeAdapter.subagents?` surface; dsh implements it live-only
    from the child's `subagent.*` notifications) by polling
    `/api/transport/subagents` through `useSubagents`, and never persists them.
```

In the `packages/transport` bullet, add `subagents?` to the parenthetical list of optional adapter methods if one exists there; otherwise no change.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0016-subagent-activity-is-an-optional-adapter-surface.md AGENTS.md
git commit -m "docs: record subagent activity as a live optional adapter surface"
```

---

### Task 11: Full verification

- [ ] **Step 1: Build the whole chain (the real type gate)**

Run: `npm run build`
Expected: PASS (including `typecheck:tests`).

- [ ] **Step 2: Run every package suite**

Run: `npm test`
Expected: PASS (113+ existing tests plus the new ones).

- [ ] **Step 3: Run the web e2e suite**

Run: `npm run build -w @science-studio/transport-client && npm run test:e2e -w @science-studio/web`
Expected: PASS, or the Chromium-gated tests report SKIP.

- [ ] **Step 4: Report**

Summarize the files changed, the commands run, and their output. Do not claim
success without the command output.
