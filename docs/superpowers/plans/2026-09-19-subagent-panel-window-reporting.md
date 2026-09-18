# Subagent list window, parent reporting, and drill-in result — impl plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three subagent-surface optimizations — a configurable "recent" window
(default 24h) for the subagent list, a best-effort prompt plugin that steers the
parent agent to report each subagent's result, and an enhanced drill-in that
surfaces a Details block and a Result section (plus `stopReason` on the
transcript).

**Architecture:**
- #1 window: a new `subagents` settings section (shared type + service
  parse/merge/view) is read by a client-side hook that returns the effective
  hours (default 24), which the web panel applies through a pure `isRecent`
  predicate in a dedicated `subagents-window.ts` helper.
- #2 parent reporting: a fourth dependency-free dsh child plugin registers a
  host-scope `systemPrompt.section` that reaches the MAIN agent, mounted
  unconditionally in `DshAdapter.init`.
- #3 drill-in: `SubagentTranscript` gains `stopReason?`; the adapter merges it
  from the registry's run before returning the child-log read; the web renderer
  shows the Details block + a "Result" section (the last assistant text) above
  the transcript.

**Tech Stack:** TypeScript npm workspaces; Next.js web; Fastify service; React
client (existing); dsh cordis plugin (dependency-free). No new runtime
dependencies.

## Global Constraints

- No new runtime dependencies. (The dsh plugin and the web helper are
  dependency-free by construction; the client hook uses the existing
  `fetchSettings`.)
- Artifacts (commit messages, docs, test names) in English.
- The type gate is `npm run build` (which runs `typecheck:tests` last).
  `npm run typecheck` is broken in transport-service (TS6310); do NOT cite it.
- The root test gate is `npm run test` (runs each package's `node --test` suite).
- Web e2e: `npm run test:e2e -w @science-studio/web` (or
  `node --test apps/web/test/<file>.test.mjs`); needs Chromium (auto-detected,
  self-skips without one). Prereq: `npm run build -w @science-studio/transport-client`.
- `tsconfig` base: `noUncheckedIndexedAccess` ON (every index returns
  `T | undefined`); test env `lib: ES2022`, `types: ["node"]` (NO DOM lib — in
  `.ts` TEST files avoid `RequestInfo` and use `Parameters<typeof fetch>[0]`).
- Settings window rules: `subagents.visibleWindowHours` integer `1–720`; `null`
  clears back to the default; the CLIENT defaults to 24 on absence/failure.
- The dsh subagent-reporting plugin is a dependency-free cordis plugin, host-scope
  `systemPrompt` section only, mounted unconditionally in `DshAdapter.init`.

---

### Task 1: Settings section (shared types + service)

**Files:**
- Modify: `packages/transport/src/settings.ts` (add types)
- Modify: `packages/transport/src/seams.ts:59-66` (re-export two new types)
- Modify: `packages/transport/src/index.ts:67-73` (re-export two new types)
- Modify: `services/transport-service/src/settings.ts` (parse/merge/view)
- Test: `services/transport-service/test/settings.test.ts`
- Test: `packages/transport/test/seams.test.ts:83` (the compile-time `RuntimeSettingsView` fixture gains the new required `subagents` field — add `subagents: {}`)

**Interfaces:**
- Consumes: none (pure types + service additions).
- Produces:
  - `SubagentSettings { visibleWindowHours?: number }`
  - `SubagentSettingsPatch { visibleWindowHours?: number | null }`
  - `RuntimeSettings.subagents?: SubagentSettings` (added)
  - `RuntimeSettingsPatch.subagents?: SubagentSettingsPatch` (added)
  - `RuntimeSettingsView.subagents: SubagentSettings` (added, always present)

- [ ] **Step 1: Add the types to `packages/transport/src/settings.ts`.**

Insert after `ModelSettings`:

```typescript
export interface SubagentSettings {
  /** How long a finished subagent stays in the default (non-history) view, in hours. */
  visibleWindowHours?: number;
}
```

Change `RuntimeSettings`:
```typescript
export interface RuntimeSettings {
  model: ModelSettings;
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
  subagents?: SubagentSettings;
}
```

Change `RuntimeSettingsView`:
```typescript
export interface RuntimeSettingsView {
  model: Omit<ModelSettings, "apiKey"> & { apiKeyConfigured: boolean };
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
  subagents: SubagentSettings;
  /** The active runtime product (`TRANSPORT_RUNTIME`). */
  runtime: string;
  /** The settings file the service read/wrote, for diagnosis. */
  settingsPath: string;
}
```

After `ModelSettingsPatch`, add `SubagentSettingsPatch`:
```typescript
export interface SubagentSettingsPatch {
  visibleWindowHours?: number | null;
}
```

Change `RuntimeSettingsPatch`:
```typescript
export interface RuntimeSettingsPatch {
  model?: ModelSettingsPatch;
  plugins?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  subagents?: SubagentSettingsPatch;
}
```

- [ ] **Step 2: Re-export the new types in `seams.ts` and `index.ts`.**

In both files, extend the `export type { ... } from "./settings.js";` block to
include `SubagentSettings` and `SubagentSettingsPatch` (alphabetical position
within the existing list). Example for `seams.ts`:

```typescript
export type {
  ModelSettings,
  ModelSettingsPatch,
  RuntimeSettings,
  RuntimeSettingsView,
  RuntimeSettingsPatch,
  SubagentSettings,
  SubagentSettingsPatch,
} from "./settings.js";
```

- [ ] **Step 3: Update the service `settings.ts` — four functions.**

Import the new types from `@science-studio/transport` (add to the existing
`{ ModelSettings, RuntimeSettings, ... }` import block).

Update `emptySettings()`:
```typescript
export function emptySettings(): RuntimeSettings {
  return { model: {}, plugins: {}, agent: {}, subagents: {} };
}
```

Update `loadSettings`'s return (the `if (!isPlainObject(parsed))` guard stays):
```typescript
return {
  model: isPlainObject(parsed.model) ? (parsed.model as ModelSettings) : {},
  plugins: isPlainObject(parsed.plugins) ? parsed.plugins : {},
  agent: isPlainObject(parsed.agent) ? parsed.agent : {},
  subagents: isPlainObject(parsed.subagents) ? (parsed.subagents as SubagentSettings) : {},
};
```

Update `mergeSettings`:
```typescript
export function mergeSettings(
  current: RuntimeSettings,
  patch: RuntimeSettingsPatch,
): RuntimeSettings {
  const model: ModelSettings = { ...current.model };
  if (patch.model) {
    // (unmodified — the existing apiKey/clear rule stays)
  }
  const subagents: SubagentSettings = { ...(current.subagents ?? {}) };
  if (patch.subagents !== undefined && "visibleWindowHours" in patch.subagents) {
    const value = patch.subagents.visibleWindowHours;
    if (value === null) delete subagents.visibleWindowHours;
    else if (value !== undefined) subagents.visibleWindowHours = value;
  }
  return {
    model,
    plugins: patch.plugins ? { ...current.plugins, ...patch.plugins } : current.plugins,
    agent: patch.agent ? { ...current.agent, ...patch.agent } : current.agent,
    subagents,
  };
}
```

Update `viewOf`:
```typescript
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
    subagents: { ...(settings.subagents ?? {}) },
    runtime: env.TRANSPORT_RUNTIME ?? "openclaw",
    settingsPath,
  };
}
```

Update `parseSettingsPatch` (add near the end, before `return { patch }`):
```typescript
if ("subagents" in body) {
  if (!isPlainObject(body.subagents)) return { error: "subagents must be an object" };
  const sub: SubagentSettingsPatch = {};
  if ("visibleWindowHours" in body.subagents) {
    const value = body.subagents.visibleWindowHours;
    if (value === null) sub.visibleWindowHours = null;
    else if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 720)
      sub.visibleWindowHours = value;
    else return { error: "subagents.visibleWindowHours must be an integer between 1 and 720" };
  }
  patch.subagents = sub;
}
```

- [ ] **Step 4: Add failing test cases to `services/transport-service/test/settings.test.ts`.**

Add three tests (near the existing `parseSettingsPatch` test):

```typescript
test("viewOf reports the subagents section (empty when unset)", () => {
  const view = viewOf({ model: {}, plugins: {}, agent: {} }, "/tmp/s.json", {});
  assert.deepEqual(view.subagents, {});
});

test("mergeSettings sets and clears subagents.visibleWindowHours", () => {
  const base = { model: {}, plugins: {}, agent: {} };
  const withHour = mergeSettings(base, { subagents: { visibleWindowHours: 48 } });
  assert.equal(withHour.subagents?.visibleWindowHours, 48);
  const cleared = mergeSettings(withHour, { subagents: { visibleWindowHours: null } });
  assert.equal(cleared.subagents?.visibleWindowHours, undefined);
  // An absent subagents patch leaves the stored value alone.
  const untouched = mergeSettings(withHour, {});
  assert.equal(untouched.subagents?.visibleWindowHours, 48);
});

test("parseSettingsPatch validates subagents.visibleWindowHours", () => {
  assert.deepEqual(parseSettingsPatch({ subagents: { visibleWindowHours: 48 } }), {
    patch: { subagents: { visibleWindowHours: 48 } },
  });
  assert.deepEqual(parseSettingsPatch({ subagents: { visibleWindowHours: null } }), {
    patch: { subagents: { visibleWindowHours: null } },
  });
  assert.equal(
    errorOf(parseSettingsPatch({ subagents: { visibleWindowHours: 0 } })),
    "subagents.visibleWindowHours must be an integer between 1 and 720",
  );
  assert.equal(
    errorOf(parseSettingsPatch({ subagents: { visibleWindowHours: 1000 } })),
    "subagents.visibleWindowHours must be an integer between 1 and 720",
  );
  assert.equal(
    errorOf(parseSettingsPatch({ subagents: { visibleWindowHours: "x" } })),
    "subagents.visibleWindowHours must be an integer between 1 and 720",
  );
  assert.equal(errorOf(parseSettingsPatch({ subagents: [] })), "subagents must be an object");
});
```

- [ ] **Step 5: Run the service settings test to verify it passes.**

Run: `npm test -w @science-studio/transport-service -- settings`
Expected: all cases (existing + new) PASS.

- [ ] **Step 6: Run the root build gate (type-checks the shared + service change).**

Run: `npm run build`
Expected: all packages build; `typecheck:tests` clean.

- [ ] **Step 7: Commit.**

```bash
git add packages/transport/src/settings.ts \
        packages/transport/src/seams.ts \
        packages/transport/src/index.ts \
        services/transport-service/src/settings.ts \
        services/transport-service/test/settings.test.ts
git commit -m "$(cat <<'EOF'
feat(settings): add the subagents.visibleWindowHours section

A new first-class `subagents` section on the shared settings contract
stores the subagent-list recent-window in hours (default 24h, 1-720 range).
The service's parse/merge/view round-trips it; `viewOf` always reports it
(presence + the stored value) so the client can apply its own default.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Client window hook (settings-derived)

**Files:**
- Modify: `packages/transport-client/src/settings.ts` (pure helper + hook)
- Modify: `packages/transport-client/src/index.ts:85-87` (re-export the new exports)
- Test: `packages/transport-client/test/settings.test.ts`

**Interfaces:**
- Consumes: `RuntimeSettingsView` from `@science-studio/transport` (Task 1).
- Produces:
  - `subagentWindowFromView(view: { subagents?: SubagentSettings }): number` —
    the effective hours (default 24 on absence / non-number / out of range).
  - `useSubagentsWindow(options?: { api?: string; enabled?: boolean }): { windowHours: number }`
    — reads `/api/settings` once (memoized per `api`), returns `windowHours`
    (24 on failure / absence).

- [ ] **Step 1: Write the failing test (pure helper + a hook wrapper smoke test).**

Add to `packages/transport-client/test/settings.test.ts`:

```typescript
import { subagentWindowFromView } from "../src/settings.js";

test("subagentWindowFromView applies the default and bounds", () => {
  assert.equal(subagentWindowFromView({}), 24);
  assert.equal(subagentWindowFromView({ subagents: {} }), 24);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: 48 } }), 48);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: 720 } }), 720);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: 721 } }), 720);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: 0 } }), 24);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: -1 } }), 24);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: "x" as never } }), 24);
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -w @science-studio/transport-client -- settings`
Expected: FAIL — `subagentWindowFromView` is not exported.

- [ ] **Step 3: Implement the helper + hook in `packages/transport-client/src/settings.ts`.**

Add to the top of the file (the file already starts with `"use client";` and imports
a couple of settings types from `@science-studio/transport`). Add the `SubagentSettings`
type to that import, and add the React hook imports:

```typescript
import { useEffect, useMemo, useState } from "react";
```

Add under the existing `DEFAULT_SETTINGS_API` declaration. The pure helper has NO
React dependency (so it is testable directly); the hook wraps it with the memoized
`/api/settings` fetch:

```typescript
/**
 * The effective subagent-list "recent window" hours. Pure: maps a (possibly
 * absent) subagents slice to the hours number the panel should use — default
 * 24 when absent, not a number, or out of range; clamped to 1..720.
 */
export function subagentWindowFromView(view: { subagents?: SubagentSettings }): number {
  const n = view?.subagents?.visibleWindowHours;
  if (typeof n !== "number" || !Number.isFinite(n)) return 24;
  return Math.max(1, Math.min(720, Math.trunc(n)));
}

export interface UseSubagentsWindowOptions {
  /** The settings API base; defaults to the same-origin `/api/settings`. */
  api?: string;
  /** False makes NO request (a collapsed module, or a test). */
  enabled?: boolean;
}

/**
 * Reads the settings view once and exposes its subagent recent-window as a
 * stable hours number. A fetch failure or an absent value leaves the panel at
 * the 24h default — the feature never wedges on the settings hop.
 */
export function useSubagentsWindow(options: UseSubagentsWindowOptions = {}): {
  windowHours: number;
} {
  const { api = DEFAULT_SETTINGS_API, enabled = true } = options;
  const [windowHours, setWindowHours] = useState(24);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    fetchSettings(api)
      .then((view) => {
        if (active) setWindowHours(subagentWindowFromView(view));
      })
      .catch(() => {
        if (active) setWindowHours(24);
      });
    return () => {
      active = false;
    };
  }, [api, enabled]);
  return useMemo(() => ({ windowHours }), [windowHours]);
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npm test -w @science-studio/transport-client -- settings`
Expected: PASS.

- [ ] **Step 5: Re-export from `packages/transport-client/src/index.ts`.**

Add `subagentWindowFromView` and `useSubagentsWindow` to the `./settings.js`
re-export block (lines 85-87):

```typescript
export {
  DEFAULT_SETTINGS_API,
  SettingsRequestError,
  fetchSettings,
  subagentWindowFromView,
  useSubagentsWindow,
  updateSettings,
} from "./settings.js";
```

(Adjust the existing re-export list to include the two new names; keep the
existing `DEFAULT_SETTINGS_API`, `SettingsRequestError`, `fetchSettings`,
`updateSettings`.)

- [ ] **Step 6: Run the client tests + build.**

Run: `npm test -w @science-studio/transport-client && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/transport-client/src/settings.ts \
        packages/transport-client/src/index.ts \
        packages/transport-client/test/settings.test.ts
git commit -m "$(cat <<'EOF'
feat(client): expose the subagent recent-window as a client hook

A pure helper (subagentWindowFromView) maps the settings view to the
effective hours (default 24, bounded 1..720), and useSubagentsWindow
wraps it with a memoized /api/settings fetch that stays at 24h on a
failed hop so the panel can never wedge on settings.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Web window predicate + unit test

**Files:**
- Create: `apps/web/components/studio/subagents-window.ts` (pure predicate)
- Test: `apps/web/test/subagents-window.test.mjs`

**Interfaces:**
- Consumes: `SubagentRun` from `@science-studio/transport`.
- Produces:
  - `DEFAULT_SUBAGENT_WINDOW_HOURS = 24`
  - `isRecent(run: SubagentRun, windowMs: number, now: number): boolean`
  - `windowMsFromHours(hours: number): number`

- [ ] **Step 1: Write the failing test — `apps/web/test/subagents-window.test.mjs`.**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SUBAGENT_WINDOW_HOURS,
  isRecent,
  windowMsFromHours,
} from "../components/studio/subagents-window.ts";

const H = 3_600_000;

test("a currently running row is always recent", () => {
  const run = {
    id: "x",
    parentId: "s",
    status: "running",
    startedAt: new Date(Date.now() - 10 * 24 * H).toISOString(),
  };
  assert.equal(isRecent(run, 24 * H, Date.now()), true, "a 10-day-old still-running row is recent");
});

test("a finished row is recent when its last activity falls within the window", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  const fresh = {
    id: "x",
    parentId: "s",
    status: "completed",
    startedAt: new Date(now - 2 * H).toISOString(),
    finishedAt: new Date(now - 1 * H).toISOString(),
  };
  const stale = {
    id: "y",
    parentId: "s",
    status: "completed",
    startedAt: new Date(now - 72 * H).toISOString(),
    finishedAt: new Date(now - 71 * H).toISOString(),
  };
  assert.equal(isRecent(fresh, 24 * H, now), true, "a 1-hour-ago completed row is recent within 24h");
  assert.equal(isRecent(stale, 24 * H, now), false, "a 71-hour-ago completed row is outside the 24h window");
});

test("the boundary (exactly windowMs ago) is included", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  const at = {
    id: "x",
    parentId: "s",
    status: "completed",
    startedAt: new Date(now - 24 * H).toISOString(),
    finishedAt: new Date(now - 24 * H).toISOString(),
  };
  assert.equal(isRecent(at, 24 * H, now), true, "a row exactly 24h ago is recent (inclusive boundary)");
});

test("a row with no finishedAt uses startedAt as the last activity", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  const mid = {
    id: "x",
    parentId: "s",
    status: "running",
    startedAt: new Date(now - 30 * H).toISOString(),
    // no finishedAt
  };
  assert.equal(isRecent(mid, 24 * H, now), true, "still running beats the time check");
});

test("windowMsFromHours truncates and clamps to 1..720", () => {
  assert.equal(windowMsFromHours(24), 24 * H);
  assert.equal(windowMsFromHours(0), 1 * H, "clamps to a minimum of 1h");
  assert.equal(windowMsFromHours(2.7), 2 * H, "truncates fractional hours");
});

test("the default window is 24 hours", () => {
  assert.equal(DEFAULT_SUBAGENT_WINDOW_HOURS, 24);
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `node --test apps/web/test/subagents-window.test.mjs`
Expected: FAIL — `subagents-window.ts` is missing.

- [ ] **Step 3: Create the pure helper — `apps/web/components/studio/subagents-window.ts`.**

```typescript
import type { SubagentRun } from "@science-studio/transport";

/** The default recent-window when settings don't specify one. */
export const DEFAULT_SUBAGENT_WINDOW_HOURS = 24;

/**
 * One subagent run is "recent" if it is still running (any age — the user is
 * watching it) OR its most recent activity (the newer of startedAt/finishedAt)
 * falls within `windowMs` of `now`. A boundary row exactly at `windowMs` is
 * included (an inclusive window).
 */
export function isRecent(run: SubagentRun, windowMs: number, now: number): boolean {
  if (run.status === "running") return true;
  const started = Date.parse(run.startedAt);
  if (Number.isNaN(started)) return false;
  const finished = run.finishedAt !== undefined ? Date.parse(run.finishedAt) : NaN;
  const lastActivity = Number.isNaN(finished) ? started : Math.max(started, finished);
  return now - lastActivity <= windowMs;
}

/** Convert an hours value to a millisecond window, clamped to 1h minimum. */
export function windowMsFromHours(hours: number): number {
  const truncated = Math.max(1, Math.trunc(hours));
  return truncated * 3_600_000;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `node --test apps/web/test/subagents-window.test.mjs`
Expected: PASS (6/6).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/components/studio/subagents-window.ts \
        apps/web/test/subagents-window.test.mjs
git commit -m "$(cat <<'EOF'
feat(web): add the pure 'isRecent' subagent-window predicate

A dependency-free .ts helper that mirrors file-utils.ts — the same shape
the app already uses for file kinds — used by the subagent panel to filter
the list by the settings-derived recent window (running-any-age OR last
activity within the window) without pulling in the React host.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Web — apply the window (panel + settings dialog)

**Files:**
- Modify: `apps/web/components/studio/subagents-view.tsx` (use the predicate + hook)
- Modify: `apps/web/components/studio/settings-dialog.tsx` (add a "Subagents" tab)
- Test: `apps/web/test/subagents-window-e2e.test.mjs` (integration)

**Interfaces:**
- Consumes: `isRecent`, `windowMsFromHours` from `./subagents-window`;
  `useSubagentsWindow` from `@science-studio/transport-client`.
- Produces: the panel's `visible` list is now `subagents.filter(isRecent(run, windowMs, now))`
  when the History toggle is OFF, unchanged (all) when ON.

- [ ] **Step 1: Wire the window into the panel (`subagents-view.tsx`).**

Read the top of the file first: it imports `useSubagents` from
`@science-studio/transport-client` (no `api` arg — the default `/api/transport`),
computes `const enabled = open && projectId !== null && activeSessionId !== null;`,
then `const { subagents } = useSubagents({ projectId, threadId: activeSessionId,
enabled });` and
`const visible = showHistory ? subagents : subagents.filter((run) => run.status === "running");`.
Make three small changes:

1. Imports — extend the client import and add the local predicate import:
```typescript
import { useSubagents, useSubagentsWindow } from "@science-studio/transport-client";
import { isRecent, windowMsFromHours } from "./subagents-window";
```

2. After the existing `useSubagents(...)` call, read the window (gated on the module
   being open, so a collapsed module does not hit `/api/settings`):
```typescript
const { windowHours } = useSubagentsWindow({ enabled: open });
```

3. Replace
   `const visible = showHistory ? subagents : subagents.filter((run) => run.status === "running");`
   with:
```typescript
const windowMs = windowMsFromHours(windowHours);
const visible = showHistory ? subagents : subagents.filter((run) => isRecent(run, windowMs, Date.now()));
```
   (`const hidden = subagents.length - visible.length;` stays unchanged.)

Update the empty-state copy so it names the window. The existing empty state is roughly
"No subagents running."; when the History toggle is ON it already names the hidden
count + the toggle — keep that. For the default (toggle OFF) copy use:
`No subagents in the last ${windowHours}h.`

- [ ] **Step 2: Add a "Subagents" tab to the settings dialog (`settings-dialog.tsx`).**

Add a new `TabsTrigger`/`TabsContent` pair (after the `agent` tab), and state
+ save handling for the hours input:

```typescript
// New state:
const [subagentsWindow, setSubagentsWindow] = React.useState("");
const [subagentsWindowCleared, setSubagentsWindowCleared] = React.useState(false);

// On open (in the existing fetchSettings().then(...) handler, alongside setProvider/setModel/...):
const n = view.subagents?.visibleWindowHours;
setSubagentsWindow(n === undefined ? "" : String(n));
setSubagentsWindowCleared(false);

// In save(), after the existing `patch.model` is set, extend the patch with the
// subagents section before calling updateSettings(SETTINGS_API, patch):
if (!(subagentsWindow === "" && !subagentsWindowCleared)) {
  patch.subagents = {
    visibleWindowHours: subagentsWindow === "" ? null : Number(subagentsWindow),
  };
}
// (blank + not a reset = leave the stored value untouched)
```

The new TabsContent:

```tsx
<TabsTrigger value="subagents">Subagents</TabsTrigger>
<TabsContent value="subagents" className="space-y-6">
  {status === "loading" ? (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Loading…
    </p>
  ) : (
    <>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Subagents</h3>
        <p className="text-xs text-muted-foreground">
          How long a finished subagent stays in the default (non-history) view.
        </p>
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">Window (hours, 1–720; default 24)</span>
          <Input
            type="number"
            min={1}
            max={720}
            value={subagentsWindow}
            placeholder="24"
            onChange={(e) => {
              setSubagentsWindow(e.target.value.trim());
              setSubagentsWindowCleared(false);
            }}
          />
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => { setSubagentsWindow(""); setSubagentsWindowCleared(true); }}
        >
          Reset to default (24h)
        </Button>
      </section>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={() => void save()} disabled={status === "saving"}>
          {status === "saving" ? <Loader2 className="size-4 animate-spin" /> : null}
          Save
        </Button>
        {status === "saved" ? (
          <span className="text-xs text-muted-foreground">Saved.</span>
        ) : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </>
  )}
</TabsContent>
```

(Leave the existing `model` tab's Save/Restart block alone; the new tab simply
reuses the same save/status mechanism.)

- [ ] **Step 3: Write the e2e — `apps/web/test/subagents-window-e2e.test.mjs`.**

```javascript
/**
 * Integration: the DEFAULT subagent-list view respects the `subagents.visibleWindowHours`
 * setting (default 24h when unset), showing a still-running row AND a recent
 * completed row, while an older completed row is hidden behind the History
 * toggle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findChromium, freePort, killTree, newWorkbenchPage,
  mockRecordSurface, mockWorkbenchSurfaces, startWebServer, waitForServer, warmWorkbench,
} from "./harness.mjs";

const H = 3600e3;
// Relative to REAL now so the "recent" row never ages out of the 24h window,
// no matter when the test runs (the panel filters with Date.now()).
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const ROWS = [
  // running, started 10 days ago → always recent via the running branch
  { id: "c1", parentId: "s1", label: "Running long", provider: "spawn", status: "running", startedAt: iso(10 * 24 * H) },
  // completed 2h ago → within the 24h window → visible by default
  { id: "c2", parentId: "s1", label: "Recent task", provider: "fork", status: "completed", stopReason: "completed", startedAt: iso(3 * H), finishedAt: iso(2 * H) },
  // completed 3d ago → outside the window → hidden until the History toggle
  { id: "c3", parentId: "s1", label: "Old task", provider: "spawn", status: "completed", stopReason: "completed", startedAt: iso(3 * 24 * H), finishedAt: iso(3 * 24 * H) },
];

test("the subagent list shows a recent window by default (24h); the toggle opens it", { timeout: 240_000 }, async (t) => {
  const executablePath = findChromium();
  if (!executablePath) { t.skip("no Chromium found"); return; }
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

    // Pin the subagent-list window to 24h so the assertions are deterministic
    // regardless of what the harness might return.
    await page.route("**/api/settings", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: {}, plugins: {}, agent: {},
          subagents: { visibleWindowHours: 24 },
          runtime: "dsh", settingsPath: "/tmp/s.json",
        }),
      }),
    );
    await page.route("**/api/transport/subagents*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subagents: ROWS }),
      }),
    );

    await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, { waitUntil: "domcontentloaded" });
    await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
    const subagents = page.locator('[data-section="subagents"]');
    await subagents.waitFor({ timeout: 15_000 });

    await subagents.getByRole("button", { name: "Subagents" }).click();
    // The RUNNING row (always recent) + the RECENT COMPLETED row (2h ago) are visible.
    await subagents.getByText("Running long").waitFor({ timeout: 10_000 });
    await subagents.getByText("Recent task").waitFor({ timeout: 10_000 });
    // The OLD completed row (3d ago) is HIDDEN by default (outside the 24h window).
    assert.equal(await subagents.getByText("Old task").count(), 0, "a 3d-ago completed row is hidden by default");

    // Toggling History reveals the older row.
    await subagents.getByLabel("Show past subagent runs").click();
    await subagents.getByText("Old task").waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`${error.message}\n--- web log ---\n${server.log().slice(-2000)}`);
  } finally {
    await browser?.close();
    killTree(server.child, port);
  }
});
```

(Add `HISTORY_MARKER` to the import from `./harness.mjs` if it is not already
imported there — it is used by the existing `subagents-panel.test.mjs`.)

- [ ] **Step 4: Run the e2e (needs Chromium).**

Ensure `npm run build -w @science-studio/transport-client` is up to date, then:
Run: `node --test apps/web/test/subagents-window-e2e.test.mjs`
Expected: PASS (or SKIP when no Chromium is found; CI has one).

- [ ] **Step 5: Run the panel regression test to make sure the existing invariants still hold.**

Run: `node --test apps/web/test/subagents-panel.test.mjs`
Expected: PASS (or SKIP without Chromium). That test's completed-row fixture is a
fixed 2026-09-17 date which only ever AGES OLDER as real time passes, so it stays
outside the 24h window and its "Completed hidden by default" assertion remains
valid under the new `isRecent` filter (the running row is still always recent).
No change to that test is normally needed — run it to confirm. If it does fail,
the knob is that file's completed-row `finishedAt` (push it further into the past,
e.g. `new Date(Date.now() - 3 * 864e5).toISOString()`), preserving its pre-window intent.

- [ ] **Step 6: Run the web e2e suite.**

Run: `npm run test:e2e -w @science-studio/web`
Expected: PASS (or the known pre-existing failures in unrelated files). No new
failures.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/components/studio/subagents-view.tsx \
        apps/web/components/studio/settings-dialog.tsx \
        apps/web/test/subagents-window-e2e.test.mjs
git commit -m "$(cat <<'EOF'
feat(web): apply the subagent recent-window in the panel and add its settings tab

The default view now filters by isRecent(run, windowMs, now); the History
toggle still opens to all rows. A new "Subagents" tab in the Settings dialog
exposes the hours value (1-720, default 24) with an explicit
reset-to-default affordance. The e2e pins the window to 24h and asserts a
running row + a 2h-ago completed row are visible by default while a 3d-ago
row is hidden until the toggle.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: dsh parent-reporting plugin + adapter mount

**Files:**
- Create: `packages/transport-dsh/src/subagent-plugin.ts`
- Modify: `packages/transport-dsh/src/bridge.ts` (add `writeSubagentPatch`)
- Modify: `packages/transport-dsh/src/adapter.ts` (add default `subagentPluginPath` + unconditional mount)
- Test: `packages/transport-dsh/test/subagent-plugin.test.ts` (new)
- Test: `packages/transport-dsh/test/adapter.test.ts` (add one case)

**Interfaces:**
- Consumes: no new deps. The plugin reads only its own `name`, `inject`, and
  the host's `systemPrompt` / `effect` surface.
- Produces:
  - `subagent-plugin.ts` exports: `name = "science-studio-subagent-reporting"`,
    `inject = ["systemPrompt"]`, `apply(ctx)` (the host API is
    `{ systemPrompt?: { section(s: {name,order,text}): () => void },
       effect?: (register: () => (() => void), name: string): void }`).
  - `writeSubagentPatch(opts: { dir: string; pluginPath: string }): Promise<string>`
    in `bridge.ts`.

- [ ] **Step 1: Write the failing test — `packages/transport-dsh/test/subagent-plugin.test.ts`.**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, inject, name } from "../src/subagent-plugin.js";

// Mirrors the idiom in cron-plugin.test.ts: a fake host exposing a
// `systemPrompt.section` capture, passed to apply(ctx) without a cast.
function fakeHost() {
  interface Section { name: string; order: number; text: string }
  const sections: Section[] = [];
  const ctx = {
    systemPrompt: {
      section: (s: Section) => {
        sections.push(s);
        return () => { /* disposer */ };
      },
    },
  };
  return { ctx, sections: () => sections };
}

test("the plugin registers a host-scope reporting section", () => {
  const { ctx, sections } = fakeHost();
  apply(ctx);
  assert.equal(sections().length, 1);
  assert.equal(sections()[0]?.name, name);
  assert.match(sections()[0]?.text ?? "", /subagent/i);
  assert.match(sections()[0]?.text ?? "", /report/i);
});

test("a host without a systemPrompt surface registers nothing and does not throw", () => {
  let threw = false;
  try { apply({}); } catch { threw = true; }
  assert.equal(threw, false);
});

test("the plugin declares a section-only inject scope", () => {
  assert.deepEqual([...inject], ["systemPrompt"]);
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -w @science-studio/transport-dsh -- subagent-plugin`
Expected: FAIL — `../src/subagent-plugin.js` is missing.

- [ ] **Step 3: Create the plugin — `packages/transport-dsh/src/subagent-plugin.ts`.**

```typescript
/**
 * The CHILD-side parent-reporting plugin: a dependency-free cordis plugin
 * loaded into the dsh harness child via a per-launch profile patch. It
 * registers ONE host-scope system-prompt section that reaches the MAIN
 * agent (and any subagent child, unless shadowed) — telling the parent to
 * pick up each delegated subagent's result and report it to the user in
 * plain terms.
 *
 * The dsh harness already delivers the child's result to the parent
 * (foreground → a tool result; background, the `sdk` default → a settlement
 * notice); this section closes the "and now report it" step.
 *
 * Like `bridge-plugin.ts` / `project-plugin.ts` it imports NOTHING from
 * `@deepseek-ai/*`, never writes to stdout, and fails soft.
 */

export const name = "science-studio-subagent-reporting";
export const inject: readonly string[] = ["systemPrompt"];

interface PromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

interface SubagentHost {
  readonly systemPrompt?: { readonly section: (s: PromptSection) => () => void };
  readonly effect?: (register: () => (() => void), name: string) => void;
}

const SECTION: PromptSection = {
  name,
  order: 455, // alongside the science-studio sections (450 project, 460 cron); distinct + non-colliding
  text: [
    "When you delegate work to a subagent (the `subagent` or `subagent_fork` tool), its result comes back to you — either as a tool result (a foreground call) or as a later settlement notice (a background call).",
    "After each delegated subagent completes and its result arrives, read it and summarize the key finding and conclusion in plain language, and report that to the user.",
    "Never silently drop a subagent's result: if a subagent finished, say what it did and what it found, even if you will keep working on the larger task.",
    "If a subagent errored or left no closing message, say so plainly and what you will do about it.",
  ].join("\n"),
};

export function apply(ctx: SubagentHost): void {
  const register = (): (() => void) => {
    const disposes: Array<() => void> = [];
    if (ctx.systemPrompt) {
      try { disposes.push(ctx.systemPrompt.section(SECTION)); } catch { /* host without one */ }
    }
    return () => {
      for (let i = disposes.length - 1; i >= 0; i--) {
        try { disposes[i]?.(); } catch { /* noop */ }
      }
    };
  };
  try {
    if (ctx.effect) ctx.effect(register, name);
    else register();
  } catch {
    /* best-effort: a host without a surface simply registers nothing */
  }
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npm test -w @science-studio/transport-dsh -- subagent-plugin`
Expected: PASS.

- [ ] **Step 5: Add `writeSubagentPatch` to `packages/transport-dsh/src/bridge.ts`.**

Under the existing `writeCronPatch`, add:

```typescript
/**
 * Write the launch patch that inserts the SUBAGENT-REPORTING plugin into the
 * child's profile, and return its path (for `--patch`). No config node — the
 * plugin registers a static section (see `subagent-plugin.ts`). Same shape as
 * the bridge/project/cron patches: a `file:` URL name and a distinct
 * filename (`subagent-reporting-<8hex>`).
 */
export async function writeSubagentPatch(opts: { dir: string; pluginPath: string }): Promise<string> {
  const { dir, pluginPath } = opts;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `subagent-reporting-${randomUUID().slice(0, 8)}.cordis.patch.yml`);
  const document = [
    "- insert:",
    "    - id: science-studio-subagent-reporting",
    `      name: ${JSON.stringify(pathToFileURL(pluginPath).href)}`,
    "",
  ].join("\n");
  await writeFile(file, document, "utf8");
  return file;
}
```

- [ ] **Step 6: Wire it into the adapter.**

In `packages/transport-dsh/src/adapter.ts`:

- Add `writeSubagentPatch` to the import from `"./bridge.js"` (next to the
  existing `writeBridgePatch`, `writeCronPatch`, `writeProjectPatch`).
- Add to the options interface (next to `cronPluginPath?: string`):
  `subagentPluginPath?: string;`
- Add a field alongside `this.cronPluginPath`:
  `private readonly subagentPluginPath: string;`
- In the constructor (next to the `this.cronPluginPath = options.cronPluginPath ?? ...`
  line), add:
  ```typescript
  this.subagentPluginPath =
    options.subagentPluginPath ?? fileURLToPath(new URL("./subagent-plugin.js", import.meta.url));
  ```
- In the `init` patches block (right after the bridge patch is attempted, BEFORE the
  `opts.project`-gated blocks), add the unconditional mount:
  ```typescript
  // The parent-reporting plugin rides its own launch patch (unconditional,
  // like the bridge): it steers the MAIN agent to report each delegated
  // subagent's result — in a real Project and in `project-default` alike.
  // Best-effort: if the write fails the child simply has no instruction.
  try {
    patches.push(await writeSubagentPatch({ dir: this.bridgeDir, pluginPath: this.subagentPluginPath }));
  } catch (err) {
    console.warn("[dsh] subagent-reporting plugin unavailable", err);
  }
  ```

- [ ] **Step 7: Add the adapter patch-assertion test.**

Add to `packages/transport-dsh/test/adapter.test.ts` (near the other init
tests):

```typescript
test("DshAdapter mounts the parent-reporting plugin patch unconditionally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-subagent-report-"));
  const client = new FakeDshClient((_sid, _text) => []);
  let captured: string[] = [];
  const adapter = new DshRuntimeAdapter({
    createClient: (options) => {
      captured = ((options as Record<string, unknown>)["patches"] as string[] | undefined) ?? [];
      return client;
    },
    transcriptDir: dir,
  });
  const store = new FakeRecordStore();  // the same store the other adapter tests use
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    assert.ok(captured.some((p) => p.includes("subagent-reporting-")), "the parent-reporting patch is present in `patches`");
    assert.ok(captured.length >= 2, "at least the bridge + report patches (2 min) are mounted");
  } finally {
    await client.close?.();
  }
});
```

(The `FakeDshClient`/`FakeRecordStore` idiom is the same as the existing tests in this
file — see `run() streams user + assistant deltas…` at the top for how they are
constructed and closed.)

- [ ] **Step 8: Run the dsh test suite.**

Run: `npm test -w @science-studio/transport-dsh`
Expected: all dsh tests PASS (the new plugin test + the new adapter case, and the
existing suite).

- [ ] **Step 9: Run the root build gate.**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 10: Commit.**

```bash
git add packages/transport-dsh/src/subagent-plugin.ts \
        packages/transport-dsh/src/bridge.ts \
        packages/transport-dsh/src/adapter.ts \
        packages/transport-dsh/test/subagent-plugin.test.ts \
        packages/transport-dsh/test/adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(dsh): steer the main agent to report each subagent's result

A fourth dependency-free cordis plugin (subagent-plugin.ts) registers a
host-scope system-prompt section telling the parent agent to summarize a
delegated subagent's result when it arrives (tool result or settlement
notice) and report it to the user in plain terms. The bridge.ts patch
writer mounts it unconditionally into the child's profile via a `--patch`
line, so the instruction reaches `project-default` sessions as well as
real Projects. Best-effort: a host without a systemPrompt surface
registers nothing; a failed write logs a warning and the child runs
without the instruction.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `stopReason` on the transcript (shared type + adapter merge)

**Files:**
- Modify: `packages/transport/src/types.ts:184-204` (`SubagentTranscript`)
- Modify: `packages/transport-dsh/src/adapter.ts:542-554` (`subagentTranscript` method)
- Test: `packages/transport-dsh/test/adapter.test.ts` (extend — the reader/registry merge test)

**Interfaces:**
- Consumes: `SubagentRun.stopReason` (already present) from the registry; the
  existing `SubagentTranscript` type in `types.ts` (Step 3 adds `stopReason`).
- Produces: `SubagentTranscript.stopReason?: string` — set by the adapter from
  the owning run's `stopReason`, or absent if the run has no stop reason.

- [ ] **Step 1: Extend the existing `subagentTranscript serves the child's record…` test.**

The existing test (near line 575) already: builds a zstd child log for `sub-child-1`,
runs one turn, emits `subagent.started` for `sub-child-1`, reads
`subagentTranscript("sess-1", "sub-child-1")`, and asserts its id/status/messages.
It does NOT emit `subagent.finished`, so the registry entry has no `stopReason`.
Make two small additions to that SAME test:

1. Right after the existing `client.emit({ method: "subagent.started", … "sub-child-1" … })`
   line, emit a `subagent.finished` carrying a distinct stop reason (reuse the same
   `parentSessionId` value that emit used):
```typescript
client.emit({
  method: "subagent.finished",
  params: {
    parentSessionId: client.sessionIds[0] ?? "root-x",
    childSessionId: "sub-child-1",
    provider: "spawn",
    status: "ok",
    stopReason: "max-tokens",
  },
});
```
2. Right after the existing
   `assert.equal(t!.messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "child says hi")), true);`
   line, add the new assertion:
```typescript
assert.equal(t!.stopReason, "max-tokens", "the registry's stop reason surfaces on the transcript");
```
(The read's `status` still comes from the log's `turn/end` and stays `"completed"`;
only `stopReason` is merged from the registry — see Step 4.)

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -w @science-studio/transport-dsh -- adapter`
Expected: the new assertion fails (`stopReason` is `undefined` on the read).

- [ ] **Step 3: Add the field to the shared type (`packages/transport/src/types.ts`).**

Extend `SubagentTranscript`:

```typescript
export interface SubagentTranscript {
  id: Id;
  parentId: Id;
  label?: string;
  provider?: string;
  agentProvider?: string;
  agentModel?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: RunStatus;
  /** The child's stop reason when the ledger recorded one (max-tokens, refusal, …). */
  stopReason?: string;
  messages: Message[];
}
```

- [ ] **Step 4: Update the adapter's reader to merge the run's stopReason.**

In `packages/transport-dsh/src/adapter.ts`, `subagentTranscript` (lines
~542-554) — change the last line of the method (the
`return readChildTranscript(...)` call) to:

```typescript
async subagentTranscript(sessionKey: string, childId: string): Promise<SubagentTranscript | null> {
  if (this.dshHome === undefined || this.launchCwd === undefined) return null;
  const runs = await this.subagents(sessionKey);
  const run = runs.find((r) => r.id === childId);
  if (run === undefined) return null;
  const transcript = await readChildTranscript({
    home: this.dshHome,
    cwd: this.launchCwd,
    sessionKey,
    childId,
  });
  if (transcript === null) return null;
  return run.stopReason === undefined
    ? transcript
    : { ...transcript, stopReason: run.stopReason };
}
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `npm test -w @science-studio/transport-dsh -- adapter`
Expected: PASS (including the new assertion).

- [ ] **Step 6: Run the root build gate (the shared type change affects the service, client, and web readers).**

Run: `npm run build`
Expected: PASS. The service's transcript route already returns the adapter's
object verbatim; the new optional field is additive, so no service change is
required. The web's `SubagentRenderer` will now receive it (used in Task 7).

- [ ] **Step 7: Commit.**

```bash
git add packages/transport/src/types.ts \
        packages/transport-dsh/src/adapter.ts \
        packages/transport-dsh/test/adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(dsh): surface a subagent's stop reason on its transcript

SubagentTranscript now carries stopReason (the richer reason the
harness reports on subagent.finished — max-tokens, refusal, etc.),
merged from the owning run's registry row rather than re-derived from
the child log (which records only the coarser turn-end kind). Fail-soft:
absent when the run has no reason.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Web — the drill-in Details + Result view

**Files:**
- Modify: `apps/web/components/studio/renderers/SubagentRenderer.tsx` (add Details block + Result section)
- Test: `apps/web/test/subagents-drill-in.test.mjs` (new; the Result section + stopReason assertion)

**Interfaces:**
- Consumes: `transcript.stopReason?` (Task 6), `transcript.status`,
  `transcript.provider`, `transcript.agentProvider/model`,
  `transcript.startedAt/finishedAt`, `transcript.messages`.
- Produces: the `subagent:<childId>` tab now shows a Details block (incl.
  stopReason when present) + a highlighted Result section (the last assistant
  message's text) + the transcript.

- [ ] **Step 1: Write the failing test — `apps/web/test/subagents-drill-in.test.mjs`.**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findChromium, freePort, killTree, newWorkbenchPage,
  mockRecordSurface, mockWorkbenchSurfaces, startWebServer, waitForServer, warmWorkbench,
} from "./harness.mjs";

const ROWS = [
  {
    id: "child-1",
    parentId: "s1",
    label: "Deep dive",
    provider: "fork",
    status: "completed",
    stopReason: "max-tokens",
    startedAt: "2026-09-19T10:00:00.000Z",
    finishedAt: "2026-09-19T10:01:00.000Z",
  },
];

test("the drill-in shows a Details block (with stopReason) and a Result section", { timeout: 240_000 }, async (t) => {
  const executablePath = findChromium();
  if (!executablePath) { t.skip("no Chromium found"); return; }
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

    await page.route("**/api/settings", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: {}, plugins: {}, agent: {}, subagents: { visibleWindowHours: 24 }, runtime: "dsh", settingsPath: "/tmp/s.json" }),
      }),
    );
    await page.route("**/api/transport/subagents*", (route) =>
      route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ subagents: ROWS }) }),
    );
    await page.route("**/api/transport/subagents/child-1/transcript*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transcript: {
            id: "child-1",
            parentId: "s1",
            provider: "fork",
            agentProvider: "ollama-local",
            agentModel: "qwen3.8",
            startedAt: "2026-09-19T10:00:00.000Z",
            finishedAt: "2026-09-19T10:01:00.000Z",
            status: "completed",
            stopReason: "max-tokens",
            messages: [
              { id: "m1", role: "user", parts: [{ type: "text", text: "Go look at the paper." }] },
              { id: "m2", role: "assistant", parts: [{ type: "text", text: "The paper concludes X." }] },
            ],
          },
        }),
      }),
    );

    await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, { waitUntil: "domcontentloaded" });
    await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
    const subagents = page.locator('[data-section="subagents"]');
    await subagents.waitFor({ timeout: 15_000 });
    await subagents.getByRole("button", { name: "Subagents" }).click();
    await subagents.getByText("Deep dive").waitFor({ timeout: 10_000 });
    await subagents.getByText("Deep dive").dblclick();

    // The Details block:
    await page.getByText("fork", { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByText("completed", { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByText("max-tokens").waitFor({ timeout: 10_000 });  // stopReason surfaced
    // The Result section:
    await page.getByText("Result", { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByText("The paper concludes X.").waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`${error.message}\n--- web log ---\n${server.log().slice(-2000)}`);
  } finally {
    await browser?.close();
    killTree(server.child, port);
  }
});
```

(Add `HISTORY_MARKER` to the import from `./harness.mjs` if it isn't already
exported there — the existing `subagents-panel.test.mjs` uses it, so it
exists.)

- [ ] **Step 2: Run the test to verify it fails.**

Run: `node --test apps/web/test/subagents-drill-in.test.mjs`
Expected: FAIL — the Result section does not exist yet (and/or stopReason is
not in the Details block).

- [ ] **Step 3: Update the renderer — `apps/web/components/studio/renderers/SubagentRenderer.tsx`.**

Replace `TranscriptBody` with:

```tsx
export function TranscriptBody({ transcript }: { transcript: SubagentTranscript }) {
  const result = finalAssistantText(transcript);
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
        <Bot className="size-3.5" />
        {transcript.provider ? <span>{transcript.provider}</span> : null}
        {transcript.agentProvider && transcript.agentModel ? (
          <span>{transcript.agentProvider}/{transcript.agentModel}</span>
        ) : null}
        {transcript.startedAt ? <span>started {new Date(transcript.startedAt).toLocaleString()}</span> : null}
        {transcript.finishedAt ? <span>ended {new Date(transcript.finishedAt).toLocaleString()}</span> : null}
        {transcript.status ? <span>{transcript.status}</span> : null}
        {transcript.stopReason ? <span>{transcript.stopReason}</span> : null}
      </div>

      <section className="border-border/80 rounded-md border p-2">
        <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase tracking-wide">
          Result
        </div>
        {result ? (
          <div className="text-xs"><MarkdownRenderer content={result} /></div>
        ) : (
          <p className="text-xs opacity-60">No closing message.</p>
        )}
      </section>

      {transcript.messages.map((message) => (
        <TranscriptMessage key={message.id} message={message} />
      ))}
    </div>
  );
}

/** The child's final assistant message's text parts joined. Null when there is none. */
function finalAssistantText(transcript: SubagentTranscript): string | null {
  const lastAssistant = [...transcript.messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant === undefined) return null;
  const text = lastAssistant.parts
    .map((p) => (p.type === "text" ? p.text : null))
    .filter((t): t is string => typeof t === "string")
    .join("\n\n");
  return text.trim().length > 0 ? text : null;
}
```

(`TranscriptMessage`, `TranscriptPart`, `partKey` are unchanged.)

- [ ] **Step 4: Run the test to verify it passes.**

Run: `node --test apps/web/test/subagents-drill-in.test.mjs`
Expected: PASS (or SKIP without Chromium).

- [ ] **Step 5: Run the full web e2e suite.**

Run: `npm run test:e2e -w @science-studio/web`
Expected: PASS (no new failures; the existing `subagents-panel.test.mjs` and
`right-panel-sections.test.mjs` still hold).

- [ ] **Step 6: Run the web build gate.**

Run: `npm run build -w @science-studio/web`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/components/studio/renderers/SubagentRenderer.tsx \
        apps/web/test/subagents-drill-in.test.mjs
git commit -m "$(cat <<'EOF'
feat(web): show a Details block and a Result section in the drill-in tab

The Subagent tab now surfaces (a) an explicit Details row — provider,
model, started → ended, status, and stopReason (when the transcript
carries one) — and (b) a highlighted Result section with the child's
final assistant message's text (or a "No closing message." friendly
fallback). The full transcript follows, unchanged.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Docs — ADR 0018 + AGENTS.md + comment updates

**Files:**
- Create: `docs/adr/0018-a-dsh-plugin-instructs-the-parent-to-report-subagent-results.md`
- Modify: `AGENTS.md` (the Subagents module line)
- Modify: `packages/transport/src/types.ts` (the `SubagentTranscript` docstring if it
  needs an explicit `stopReason` note — already covered by the field comment
  from Task 6; the existing `SubagentRun` / `subagents?` comments are unchanged
  this pass).

**Interfaces:**
- Consumes: the three features shipped in Tasks 1-7.
- Produces: a short ADR, an AGENTS.md line that names all three, no code.

- [ ] **Step 1: Write the ADR — `docs/adr/0018-...md`.**

Follow the style of ADR 0017 (the cron-plugin ADR). A skeleton:

```markdown
# ADR 0018: A dsh plugin instructs the parent to report subagent results

## Status
Accepted

## Context

A delegated subagent's result already reaches the parent agent (a
foreground `subagent` tool-call returns the child's final answer as the tool
result; a background run — the `sdk`-profile default — surfaces it as a
settlement notice). What the parent does with it is model-driven, and the
harness itself only provides the "use subagent in the background by default"
guidance. In practice the parent frequently does not synthesize the result
and report it to the user.

## Decision

Add a fourth dependency-free dsh child plugin (`subagent-plugin.ts`), mounted
unconditionally in `DshAdapter.init` as a host-scope `systemPrompt.section`
(like the existing bridge/project/cron plugins, riding a per-launch
`--patch`). The section tells the MAIN agent to pick up each delegated
subagent's result when it arrives (tool-result or settlement notice) and
report it in plain terms, in a real Project and in `project-default` alike.

It is a prompt steer, best-effort — a weak model may still skip it.
The UI keeps the result visible regardless via the "recent window" default
(A1) and the drill-in Details/Result view (A2), so the user is never blocked
on parent-agent compliance.

## Consequences

- Always on for dsh; not a hard guarantee.
- Applies in all dsh sessions (real Projects AND `project-default`).
- The instruction is conditional (only active when a subagent result arrives),
  so it is inert in non-delegating sessions.
- The seam surface for a future openclaw analogue is unchanged — the seam is
  optional and dsh implements it.
```

- [ ] **Step 2: Update the AGENTS.md line.**

In `AGENTS.md`, find the Subagents-module line (in the `apps/web` row — search
for "Subagents module reads the active Session's delegated-agent runs") and
add, in the same sentence:

- The recent-window setting (default 24h, configurable).
- The parent-reporting instruction (a separate child plugin, best-effort).
- The drill-in's Details + Result sections.

Concretely — append to the sentence:
"…plus a parent-reporting instruction (a fourth child plugin that steers the
main agent to report each subagent's result when it arrives — best-effort,
harness delivers the result; docs/adr/0018) and a
drill-in Details + Result surface on each child tab."

And in the settings-dialog row, add a "Subagents" tab (window hours) next to
Model / Plugins / Agent.

- [ ] **Step 3: Run the docs sanity checks.**

```bash
# Confirm the ADR references a valid filename:
grep -n "subagent-plugin\|docs/adr/0018" AGENTS.md
```
Expected: at least one hit.

- [ ] **Step 4: Commit.**

```bash
git add docs/adr/0018-a-dsh-plugin-instructs-the-parent-to-report-subagent-results.md \
        AGENTS.md
git commit -m "$(cat <<'EOF'
docs: record the parent-reporting plugin and the three subagent-surface optimizations

ADR 0018 records the fourth dsh child plugin (a host-scope system-prompt
section that instructs the main agent to report each delegated subagent's
result when it arrives; best-effort, harness delivers the result) and the
two UI counterparts — the recent-window list and the
drill-in Details + Result view. AGENTS.md gains the Subagents tab (a window
hours setting) alongside Model/Plugins/Agent.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Final verification checklist

- [ ] `npm run build` — the type gate
- [ ] `npm run test` — all package suites PASS
- [ ] `npm run test:e2e -w @science-studio/web -- subagents-panel subagents-window subagents-drill-in` — the feature e2e PASS
- [ ] The spec's "Out of scope" holds: no record change, no openclaw surface, no
  `Run` projection, no server-side enforcement.
- [ ] All 8 commits present in the branch history.
