# Worktree Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a worktree a first-class workbench scope: a `Project → Worktree → Session` tree, a worktree-aware URL and scope memory, and `worktreeId` on every transport/workspace request.

**Architecture:** The scope store gains `activeWorktreeId`; `setScope` moves store, memory and URL together. The `StudioPage` boot resolves the worktree against the Project's worktree list (claim → remembered → `main`). The active worktree's workspace is what the file tree and previews read; `SessionView` re-keys on `(projectId, worktreeId, sessionId)`.

**Tech Stack:** Next.js App Router, zustand, React, Tailwind/shadcn, assistant-ui client (`@science-studio/transport-client`), `node:test` for pure modules and the browser e2e suite.

**Spec:** `docs/superpowers/specs/2026-09-23-dsh-worktree-plugin-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-23-worktree-backend.md` (routes + worktree scope).

## Global Constraints

- **Do not make the `useTransport` host re-render:** `SessionView` must stay state-free and memoized; all UI state lives below it (docs/adr/0009, `workspace-panel-history.test.mjs`).
- **The URL is mirrored with `history.replaceState`, never navigated.**
- **A scope claim is trusted only after the record lists it:** an unknown worktree falls back to `main`; a fetch failure changes nothing.
- **Open tabs stay mounted;** a worktree switch clears them (same as a Project switch).
- **`main` is protected in the UI:** no rename/archive/delete affordance on its row.
- **All requests relay same-origin through the app's `/api` proxies.**
- **Final gate:** `npm run test:e2e -w @science-studio/web` and `npm run build` green.

## Review Focus

- **Reload while scoped to a linked worktree** → the boot must restore the same worktree, or fall back to `main`; never open a fabricated worktree.
- **Switching worktrees repeatedly** → no leaked watch sockets (the `scope-switch-sockets` regression guard must stay green).
- **Creating a Session while a linked worktree is active** → it is created under that worktree, not `main`.
- **Deleting/archiving the active worktree** → the scope moves to `main` and the tabs clear.
- **A Project-level panel action (cron/HPC)** → still works, unaffected by `worktreeId`.

---

### Task 1: `Worktree` client type and API module

**Files:**
- Create: `packages/transport-client/src/worktrees.ts`
- Modify: `packages/transport-client/src/index.ts`
- Test: `packages/transport-client/test/worktrees.test.ts`

**Interfaces:**
- Consumes: `/api/worktrees*` (backend plan).
- Produces:
  - `export interface Worktree { id: string; projectId: string; name: string; branch: string; createdAt: string; archivedAt?: string; exists?: boolean }`
  - `export const DEFAULT_WORKTREE_ID = "main"`
  - `fetchWorktrees(api, projectId, opts?: { includeArchived?: boolean }): Promise<Worktree[]>`
  - `createWorktree(api, projectId, input: { name: string; branch?: string; base?: string }): Promise<Worktree>`
  - `renameWorktree(api, projectId, id, name): Promise<Worktree>`
  - `archiveWorktree(api, projectId, id): Promise<Worktree>`
  - `unarchiveWorktree(api, projectId, id): Promise<Worktree>`
  - `deleteWorktree(api, projectId, id): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/transport-client/test/worktrees.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorktree,
  DEFAULT_WORKTREE_ID,
  deleteWorktree,
  fetchWorktrees,
} from "../src/worktrees.js";

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; json: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const res = handler(String(input), init);
    return new Response(JSON.stringify(res.json), { status: res.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("fetchWorktrees scopes by projectId", async () => {
  const stub = stubFetch(() => ({ status: 200, json: { worktrees: [{ id: "main", projectId: "p1", name: "main", branch: "main", createdAt: "x" }] } }));
  try {
    const list = await fetchWorktrees("/api/worktrees", "p1");
    assert.equal(list[0]?.id, DEFAULT_WORKTREE_ID);
    assert.ok(stub.calls[0]?.url.includes("/api/worktrees?projectId=p1"));
  } finally {
    stub.restore();
  }
});

test("createWorktree POSTs the body and returns the row", async () => {
  const stub = stubFetch(() => ({ status: 201, json: { worktree: { id: "exp-a", projectId: "p1", name: "Experiment A", branch: "exp-a", createdAt: "x" } } }));
  try {
    const wt = await createWorktree("/api/worktrees", "p1", { name: "Experiment A" });
    assert.equal(wt.id, "exp-a");
    assert.equal(stub.calls[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(stub.calls[0]?.init?.body)), { name: "Experiment A" });
  } finally {
    stub.restore();
  }
});

test("deleteWorktree POSTs the delete action", async () => {
  const stub = stubFetch(() => ({ status: 200, json: { ok: true } }));
  try {
    await deleteWorktree("/api/worktrees", "p1", "exp-a");
    assert.ok(stub.calls[0]?.url.includes("/api/worktrees/exp-a/delete?projectId=p1"));
  } finally {
    stub.restore();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test packages/transport-client/test/worktrees.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/transport-client/src/worktrees.ts` mirroring `projects.ts`'s `request<T>` helper style (read it first and reuse its error handling). Use `new URLSearchParams({ projectId })` for queries. Export it from `packages/transport-client/src/index.ts`.

- [ ] **Step 4: Run the test and the package build**

Run: `npx tsx --test packages/transport-client/test/worktrees.test.ts && npm run build -w @science-studio/transport-client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-client/src/worktrees.ts packages/transport-client/src/index.ts packages/transport-client/test/worktrees.test.ts
git commit -m "feat(client): worktree record API"
```

---

### Task 2: Scope memory carries the worktree

**Files:**
- Modify: `apps/web/lib/scope-memory.ts`
- Modify: `apps/web/test/scope-memory.test.mjs`
- Test: `apps/web/test/scope-memory.test.mjs`

**Interfaces:**
- Consumes: `Worktree` (Task 1).
- Produces:
  - `Scope { projectId; worktreeId; sessionId }`
  - `ScopeMemory { version: 1; lastProjectId; worktrees: Record<string, string>; sessions: Record<string, string> }` — `worktrees` is keyed by projectId, `sessions` by `${projectId}\u0000${worktreeId}`.
  - `resolveWorktree(input: { projectId; claimedWorktreeId; memory; worktrees }): { worktreeId; memory }` — claim if listed, else remembered-for-project if listed, else `main`.
  - `scopePath(scope)` → `/projects/<projectId>/worktrees/<worktreeId>/sessions/<sessionId>`.

- [ ] **Step 1: Extend the failing test**

In `apps/web/test/scope-memory.test.mjs`, add cases:

```js
test("resolveWorktree claims the URL's worktree when listed, else main", () => {
  const worktrees = [{ id: "main" }, { id: "exp-a" }];
  const empty = parseScopeMemory(null);
  assert.equal(resolveWorktree({ projectId: "p1", claimedWorktreeId: "exp-a", memory: empty, worktrees }).worktreeId, "exp-a");
  assert.equal(resolveWorktree({ projectId: "p1", claimedWorktreeId: "nope", memory: empty, worktrees }).worktreeId, "main");
});

test("scopePath nests the worktree segment", () => {
  assert.equal(
    scopePath({ projectId: "p1", worktreeId: "exp-a", sessionId: "s1" }),
    "/projects/p1/worktrees/exp-a/sessions/s1",
  );
});
```

(Import `resolveWorktree` and `scopePath`; the existing file imports via Node type-stripping from `../lib/scope-memory.ts`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test apps/web/test/scope-memory.test.mjs`
Expected: FAIL — `resolveWorktree` is not exported / `scopePath` arity.

- [ ] **Step 3: Implement**

In `apps/web/lib/scope-memory.ts`:
- Add `worktreeId` to `Scope`.
- Add `worktrees: Record<string, string>` to `ScopeMemory` (PER PROJECT, like `sessions` — a global `lastWorktreeId` would let a Project switch adopt another Project's same-named checkout); update `parseScopeMemory` (default `{}`), `rememberScope` (set `worktrees[projectId]` when the scope names a worktree), `pruneScopeMemory` (drop entries whose Project is gone).
- Key `sessions` by `${projectId}\u0000${worktreeId}`; update `writeSession`/`resolveSession` to take the worktreeId and key accordingly.
- Define `export const DEFAULT_WORKTREE_ID = "main";` LOCALLY in scope-memory.ts. This module must stay React-free and artifact-independent: keep the `@science-studio/transport-client` import TYPE-ONLY (it erases under Node type stripping), and do NOT value-import the client package — its runtime entry pulls React/assistant-ui. A local constant (with the comment that the value mirrors the record/client constant) keeps `node --test apps/web/test/scope-memory.test.mjs` runnable without a built `dist`.
- Add `resolveWorktree`:

```ts
export function resolveWorktree(input: {
  projectId: string | null;
  claimedWorktreeId: string | null;
  memory: ScopeMemory;
  worktrees: Worktree[];
}): { worktreeId: string; memory: ScopeMemory } {
  const listed = new Set(input.worktrees.map((w) => w.id));
  const rememberedForProject = input.projectId ? input.memory.worktrees[input.projectId] : undefined;
  const claimed =
    input.claimedWorktreeId !== null && listed.has(input.claimedWorktreeId) ? input.claimedWorktreeId : null;
  const remembered =
    rememberedForProject !== undefined && listed.has(rememberedForProject) ? rememberedForProject : null;
  const worktreeId = claimed ?? remembered ?? DEFAULT_WORKTREE_ID;
  const worktrees = { ...input.memory.worktrees };
  if (input.projectId) worktrees[input.projectId] = worktreeId;
  return { worktreeId, memory: { ...input.memory, worktrees } };
}
```

- Update `scopePath`:

```ts
export function scopePath(scope: Scope): string {
  return scope.projectId && scope.worktreeId && scope.sessionId
    ? `/projects/${encodeURIComponent(scope.projectId)}/worktrees/${encodeURIComponent(scope.worktreeId)}/sessions/${encodeURIComponent(scope.sessionId)}`
    : "/";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test apps/web/test/scope-memory.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/scope-memory.ts apps/web/test/scope-memory.test.mjs
git commit -m "feat(web): scope memory carries the worktree"
```

---

### Task 3: Workspace scope threads `worktree`

**Files:**
- Modify: `packages/transport-client/src/workspace.tsx`
- Modify: `packages/transport-client/src/index.ts` (no new export expected)
- Test: `packages/transport-client/test/workspace-worktree.test.ts`

**Interfaces:**
- Consumes: the service's `worktreeId` claim.
- Produces: `WorkspaceScope { api; project; worktree }`; `WorkspaceApiProvider` accepts `worktree?`; every workspace URL carries `&worktreeId=`; `useWorkspaceRoot` keys by `(api, project, worktree)`; `workspaceFileUrl(api, path, { project, worktree })`.

- [ ] **Step 1: Write the failing test**

Create `packages/transport-client/test/workspace-worktree.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceFileUrl } from "../src/workspace.js";

test("workspaceFileUrl carries the worktree claim", () => {
  const url = workspaceFileUrl("/api/workspace", "data/x.csv", { project: "p1", worktree: "exp-a" });
  assert.match(url, /project=p1/);
  assert.match(url, /worktreeId=exp-a/);
});

test("workspaceFileUrl omits the worktree claim when not scoped", () => {
  const url = workspaceFileUrl("/api/workspace", "data/x.csv", { project: "p1" });
  assert.ok(!url.includes("worktreeId="));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test packages/transport-client/test/workspace-worktree.test.ts`
Expected: FAIL — `worktree` is not accepted.

- [ ] **Step 3: Implement**

In `packages/transport-client/src/workspace.tsx`:
- Add `worktree: string | null` to `WorkspaceScope`; default `null` in the context; add to `WorkspaceApiProvider` props and its `useMemo` deps.
- Add `function worktreeParam(worktree: string | null | undefined): string { return worktree ? \`&worktreeId=${encodeURIComponent(worktree)}\` : ""; }`
- Append `worktreeParam(...)` to every URL builder (`fetchWorkspaceEntries`, `fetchWorkspaceStat`, `workspaceFileUrl`, `uploadWorkspaceFile`, `deleteWorkspaceEntry`). For functions taking a bare `project` argument, add an optional `worktree: string | null = null` parameter after it.
- Thread `worktree` through `useWorkspaceBrowser`, `useWorkspaceRoot`, `useWorkspaceFile`, `useWorkspaceAvailability` (each already reads `useWorkspaceApi()`; add `worktree` the same way `project` is read, and add it to effect deps and to `rootKey(api, project, worktree)`).
- Update every call site of the changed functions across `apps/web` (the file tree, preview pane, mentions picker) to pass the active `worktreeId` from the store/props.

- [ ] **Step 4: Run the test and build**

Run: `npx tsx --test packages/transport-client/test/workspace-worktree.test.ts && npm run build -w @science-studio/transport-client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-client/src/workspace.tsx packages/transport-client/test/workspace-worktree.test.ts
git commit -m "feat(client): workspace scope carries the worktree"
```

---

### Task 4: Transport scope threads `worktree`

**Files:**
- Modify: `packages/transport-client/src/catalog.tsx` (`TransportScope`/`TransportApiProvider`)
- Modify: the `useTransport` options + the transport POST/watch query construction (find it via `grep -rn "threadId" packages/transport-client/src`)
- Modify: `apps/web/app/api/transport/watch/route.ts` (add `worktreeId` to the query whitelist)
- Modify: `apps/web/components/session-view.tsx`
- Modify: `apps/web/components/studio/host.tsx`
- Test: covered by the e2e suite (Task 9)

**Interfaces:**
- Consumes: `Worktree` (Task 1).
- Produces: `TransportScope { api; project; worktree }`; `useTransport({ api, projectId, worktreeId, threadId })` sends `worktreeId` in the query; `SessionView` accepts `worktreeId` and provides it to both providers.

- [ ] **Step 1: Thread the scope object**

In `packages/transport-client/src/catalog.tsx` add `worktree: string | null` to `TransportScope`, its context default and the provider's props/`useMemo`. In the module that builds the `/api/transport` and `/api/transport/watch` URLs, add `worktreeId` to the query alongside `projectId` (query-first, matching the service's claim order).

In `packages/transport-client/src/`'s `useTransport` options type, add `worktreeId?: string | null` and pass it into the request builder.

- [ ] **Step 2: Update the watch proxy whitelist**

In `apps/web/app/api/transport/watch/route.ts`, add `"worktreeId"` to the whitelisted query keys so the watch hop relays it (it whitelists rather than relays the whole query).

- [ ] **Step 3: Update the app providers and key**

In `apps/web/components/session-view.tsx`: add a `worktreeId: string | null` prop; pass `worktree={worktreeId}` to `TransportApiProvider` and `WorkspaceApiProvider`; pass `worktreeId` to `useTransport`. In `apps/web/components/studio/host.tsx`: read `activeWorktreeId` from the store and include it in the `SessionView` `key` (`${projectId}/${worktreeId}/${sessionId}`) and prop.

- [ ] **Step 4: Verify the build**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: clean (fix any call site that omitted the new required prop).

- [ ] **Step 5: Commit**

```bash
git add packages/transport-client/src apps/web/app/api/transport/watch/route.ts apps/web/components/session-view.tsx apps/web/components/studio/host.tsx
git commit -m "feat(client): transport scope carries the worktree"
```

---

### Task 5: Store worktree state and a three-part scope

**Files:**
- Modify: `apps/web/store/studio-store.ts`
- Test: `apps/web/test/scope-restore.test.mjs` (Task 9 extends it) and store behavior is exercised by the panel tests.

**Interfaces:**
- Consumes: `Worktree` (Task 1), `Scope` (Task 2).
- Produces:
  - state `worktrees: Worktree[] | null`, `activeWorktreeId: string | null`
  - `setWorktrees(list: Worktree[]): void`
  - `upsertWorktree(w: Worktree): void`, `removeWorktree(id: string): void`
  - `setScope(scope: Scope, memory?: ScopeMemory)` — `Scope` now includes `worktreeId`; a worktree switch clears `tabs`.

- [ ] **Step 1: Add state and actions**

In `apps/web/store/studio-store.ts`:
- Add `worktrees: Worktree[] | null` (null = not loaded) and `activeWorktreeId: string | null` (initial null).
- Import `Worktree` from `@science-studio/transport-client`.
- Add `setWorktrees`, `upsertWorktree`, `removeWorktree`.
- Change `setScope` to destructure `{ projectId, worktreeId, sessionId }` and treat a worktree change like a project change: when `state.activeWorktreeId !== worktreeId`, clear `tabs`/`activeTabPath`; when the project changes, also reset `worktrees` to `null` and `sessions` as today.
- `removeWorktree(id)`: drop it from `worktrees`; if it was active, the CALLER re-resolves scope (the store never invents a session), matching `removeProject`'s contract.

- [ ] **Step 2: Update every `setScope` caller**

Search: `grep -rn "setScope(" apps/web`. Update each to pass a `worktreeId` (the current `activeWorktreeId` or `DEFAULT_WORKTREE_ID`) — `project-panel.tsx`, `components/studio/page.tsx`, and any status-bar/top-bar call. A `null` session with a real worktree is valid (browsing a worktree before creating a session).

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/store/studio-store.ts apps/web/components/studio apps/web/app/page.tsx
git commit -m "feat(web): worktree in the workbench scope store"
```

---

### Task 6: Boot resolution and the deep-link route

**Files:**
- Modify: `apps/web/components/studio/page.tsx`
- Modify: `apps/web/app/projects/[projectId]/sessions/[sessionId]/page.tsx`
- Create: `apps/web/app/projects/[projectId]/worktrees/[worktreeId]/sessions/[sessionId]/page.tsx`
- Test: `apps/web/test/scope-restore.test.mjs` (Task 9)

**Interfaces:**
- Consumes: `resolveWorktree` (Task 2), `fetchWorktrees` (Task 1), the store (Task 5).
- Produces: `StudioPage` accepts `routeWorktreeId = null`; it fetches the Project's worktrees, resolves one, then resolves the Session inside the `(project, worktree)` pair.
- **Prerequisite:** apply Task 8's `projects.ts` change first — this task calls `fetchProjectSessions(api, projectId, { worktreeId })`, which only exists after it.

- [ ] **Step 1: Extend `StudioPage`**

Change its props to `{ routeProjectId?, routeWorktreeId?, routeSessionId? }`. After `resolveProject`, when a Project is chosen:
1. `const worktrees = await fetchWorktrees(api, project.projectId);`
2. `const resolved = resolveWorktree({ projectId: project.projectId, claimedWorktreeId: routeWorktreeId, memory: project.memory, worktrees });` (keep `project.memory` pruned with worktrees — add an optional `worktrees` argument to `resolveProject` or fold the prune into `resolveWorktree`).
3. `const sessions = await fetchProjectSessions(api, project.projectId, { worktreeId: resolved.worktreeId });` (Task 8 adds the query).
4. Resolve the Session, then `s().setScope({ projectId, worktreeId: resolved.worktreeId, sessionId }, session.memory); s().setWorktrees(worktrees);`

- [ ] **Step 2: Update the routes**

- Rewrite `apps/web/app/projects/[projectId]/sessions/[sessionId]/page.tsx`: keep it as a compatibility pass-through that renders `StudioPage` with `routeWorktreeId={DEFAULT_WORKTREE_ID}` (the pre-worktree deep link is `main`-scoped; a `null` claim would fall through to the REMEMBERED worktree and could open a different session).
- Create the new nested route `apps/web/app/projects/[projectId]/worktrees/[worktreeId]/sessions/[sessionId]/page.tsx` whose `params` are passed as `routeProjectId`/`routeWorktreeId`/`routeSessionId`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/studio/page.tsx apps/web/app/projects
git commit -m "feat(web): resolve and deep-link the worktree scope"
```

---

### Task 7: `Project → Worktree → Session` panel

**Files:**
- Modify: `apps/web/components/studio/project-panel.tsx`
- Create: `apps/web/components/studio/worktree-create-dialog.tsx`
- Test: the e2e panel tests (Task 9)

**Interfaces:**
- Consumes: the worktree API (Task 1), the store (Task 5).
- Produces: the panel tree and worktree management.

- [ ] **Step 1: Extend panel state**

In `project-panel.tsx`:
- Read `worktrees`/`activeWorktreeId` from the store.
- Add `worktreesFor: Record<string, Worktree[]>` (per Project) and an expand set; a Project expand loads worktrees via `fetchWorktrees` in addition to Sessions.
- Add `Renaming`/`Deleting` variants `{ kind: "worktree"; projectId; id; value/name }`.
- `loadSessions(projectId, worktreeId)` calls `fetchProjectSessions(PROJECTS_API, projectId, { worktreeId })`; the pane tracks the `(projectId, worktreeId)` it is expanded on.

- [ ] **Step 2: Render the tree**

Under an expanded Project, render a `WorktreeList`: one row per worktree (name + branch badge; the active one highlighted) with a `RowMenu` (rename/archive/delete) — OMITTED for `main`. Single-clicking a worktree selects it (`setScope({ projectId, worktreeId, sessionId: null })` and `setWorktrees`), which drives the file tree. Under an expanded worktree, render the existing `SessionList` filtered to that worktree; the "New session" action passes `worktreeId`.

- [ ] **Step 3: Create dialog and mutations**

Create `worktree-create-dialog.tsx` (name, optional branch, optional base; shadcn `Dialog`/`Input`) calling `createWorktree`. Add handlers in the panel for rename/archive/unarchive/delete via the Task 1 API; delete's confirm dialog warns that the worktree's Sessions are deleted too. Archiving/deleting the ACTIVE worktree re-resolves to `main` (fetch its worktrees, `setScope({ projectId, worktreeId: "main", sessionId: null })`, clear tabs). When dropping a worktree from the store, call `removeWorktree(id)` ONLY when the pane's Project is the store's active Project (`store.projectId === projectId`) — `store.worktrees` holds only the active Project's list, so an unguarded removal would delete another Project's same-slug entry (a worktree id is unique only WITHIN a Project).

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/studio/project-panel.tsx apps/web/components/studio/worktree-create-dialog.tsx
git commit -m "feat(web): project/worktree/session panel"
```

---

### Task 8: Session creation picks a worktree

**Files:**
- Modify: `packages/transport-client/src/projects.ts`
- Modify: `apps/web/components/studio/project-panel.tsx`
- Test: `packages/transport-client/test/worktrees.test.ts` (extend)

**Interfaces:**
- Consumes: the service's `worktreeId` claim on sessions.
- Produces: `fetchProjectSessions(api, projectId, opts?: { includeArchived?: boolean; worktreeId?: string })`; `createSession(api, projectId, opts?: { agentId?; title?; worktreeId? })`.

- [ ] **Step 1: Extend the client functions**

In `packages/transport-client/src/projects.ts`, add `worktreeId` to both functions' `opts` and include it in the query/body (`new URLSearchParams`).

- [ ] **Step 2: Pass it from the panel**

In `project-panel.tsx`, `addSession` passes the expanded worktree's id; `loadSessions` passes it; the expanded-worktree header's "New session" uses that worktree.

- [ ] **Step 3: Verify**

Run: `npx tsx --test packages/transport-client/test/worktrees.test.ts && npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/transport-client/src/projects.ts apps/web/components/studio/project-panel.tsx
git commit -m "feat(client): sessions are created under a worktree"
```

---

### Task 9: Regression tests for the worktree scope

**Files:**
- Modify: `apps/web/test/scope-memory.test.mjs` (Task 2 already)
- Modify: `apps/web/test/scope-restore.test.mjs`
- Modify: `apps/web/test/scope-switch-sockets.test.mjs`
- Modify: `apps/web/test/workspace-panel-history.test.mjs`
- Modify: `apps/web/test/tab-state.test.mjs`

**Interfaces:** none (test-only).

- [ ] **Step 1: Extend `scope-restore.test.mjs`**

Mock `/api/worktrees` alongside the existing `/api/projects` and `/api/projects/:id/sessions` mocks. Assert:
- A boot with a remembered `exp-a` worktree restores it.
- A remembered worktree the record no longer lists falls back to `main`.
- A claim for a fabricated worktree id is never opened (no session fetch for it).

- [ ] **Step 2: Extend `scope-switch-sockets.test.mjs`**

Switch worktrees (not only Projects) repeatedly and assert a same-origin request still starts (the leaked-socket guard).

- [ ] **Step 3: Extend `workspace-panel-history.test.mjs` and `tab-state.test.mjs`**

- The `SessionView` history invariant must survive the extra `worktreeId` key.
- A worktree switch clears the open tabs; a same-worktree Session switch preserves them.

- [ ] **Step 4: Run the e2e suite**

Run: `npm run build -w @science-studio/transport-client && npm run test:e2e -w @science-studio/web`
Expected: PASS (Chromium auto-detected; the suite skips browser tests without one — ensure one is present).

- [ ] **Step 5: Commit**

```bash
git add apps/web/test
git commit -m "test(web): worktree-aware scope, sockets and tabs"
```

---

### Task 10: Final build gate

**Files:** none.

- [ ] **Step 1: Run the root build and the full test suite**

Run: `npm run build && npm run test`
Expected: PASS.

- [ ] **Step 2: Commit any generated-file churn**

The web e2e run rewrites `next-env.d.ts`/`tsconfig.json` to match `.next-test`; if the running `next build`/`dev` flips them back, commit only a clean state:

```bash
git status --short
git add -A && git commit -m "chore: restore generated config after the e2e run" # only if dirty
```

---

## Plan complete — what ships

The workbench lists `Project → Worktree → Session`, lets a researcher create/rename/archive/delete worktrees (with `main` protected), resolves and remembers the worktree in the URL and memory, creates Sessions under the active worktree, and reads that worktree's files — with the existing remount/socket/tab invariants intact.
