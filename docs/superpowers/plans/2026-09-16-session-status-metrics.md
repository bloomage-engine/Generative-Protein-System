# Session Status Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the active Session's model route, token usage and context occupancy in the workbench's bottom status bar.

**Architecture:** The dsh adapter captures the harness's `request/context` event and records `contextWindow` on each `Run`; the record (existing runs route, filtered per Session) is the source. A pure `summarizeSessionRuns` aggregates cumulative + latest metrics; a React hook fetches it and the status bar renders it, refreshing when a run finishes.

**Tech Stack:** TypeScript (npm workspaces), Fastify, React 19, zustand, `node:test` via `node --import tsx --test`.

## Global Constraints

- The seam (`packages/transport`) does NOT change: no `StateDelta`/`WatchSnapshot` field, no new adapter method.
- `Run.parameters` is `Record<string, unknown>`; `contextWindow` is additive.
- Client aggregation is a PURE function; the React hook is a thin fetch wrapper.
- `runTotal = usage.totalTokens ?? inputTokens + outputTokens`.
- Unknown/missing fields render `—`; openclaw records neither model nor usage.
- NO git commit is made unless the user explicitly asks (repo rule overrides the plan's commit steps).
- Verification gate: `npm run build` (includes `typecheck:tests`), plus the per-package `npm test`.

---

### Task 1: dsh adapter records the model context window

**Files:**
- Modify: `packages/transport-dsh/src/behavior.ts` (`applyEvent` switch, `projectRun`)
- Test: `packages/transport-dsh/test/behavior.test.ts`

**Interfaces:**
- Consumes: `SessionEvent` (`request/context` data = `{ provider: string; model: string; contextWindow?: number }`), `SettleContext` from `@science-studio/transport`.
- Produces: `Run.parameters.contextWindow?: number` (plus `provider`/`model` from the captured event, falling back to the adapter's configured pair).

- [ ] **Step 1: Write the failing test**

Add to `packages/transport-dsh/test/behavior.test.ts`:

```ts
import type { SettleContext } from "@science-studio/transport";

function settleCtx(
  state: SessionState,
  directive: { status?: "completed" | "error"; usage?: unknown } = {},
): SettleContext {
  return {
    sessionKey: "sess-1",
    state,
    inRun: true,
    runId: "run-1",
    userMessageId: "u1",
    input: "q",
    baseline: 0,
    directive,
    startedAt: "2026-01-01T00:00:00.000Z",
    replaceMessages: () => {},
    resetSession: () => {},
    notify: () => {},
  };
}

test("request/context records provider/model/contextWindow on the projected Run", () => {
  const state = freshState();
  const b = behavior();
  b.apply?.(
    ev("request/context", { provider: "prov", model: "mod", contextWindow: 128000 }),
    makeCtx(state),
  );
  const spec = b.projectRun!(settleCtx(state, { usage: { inputTokens: 10, outputTokens: 5 } }));
  assert.equal(spec?.parameters?.provider, "prov");
  assert.equal(spec?.parameters?.model, "mod");
  assert.equal(spec?.parameters?.contextWindow, 128000);
  assert.deepEqual(spec?.parameters?.usage, { inputTokens: 10, outputTokens: 5 });
});

test("without request/context the Run keeps the configured route and no contextWindow", () => {
  const spec = behavior().projectRun!(settleCtx(freshState(), {}));
  assert.equal(spec?.parameters?.provider, "p");
  assert.equal(spec?.parameters?.model, "m");
  assert.equal(spec?.parameters?.contextWindow, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/behavior.test.ts -w packages/transport-dsh` (or `npm test -w @science-studio/transport-dsh`)
Expected: FAIL — `parameters.contextWindow` is `undefined` / provider is `"p"`.

- [ ] **Step 3: Implement**

In `packages/transport-dsh/src/behavior.ts`, inside `createDshBehavior` add a per-Session capture map:

```ts
/** The latest `request/context` route per Session (harness-authoritative). */
const modelContexts = new Map<string, { provider?: string; model?: string; contextWindow?: number }>();
```

In `applyEvent`'s `switch`, add a case before `default`:

```ts
case "request/context": {
  const data = event.data;
  const captured: { provider?: string; model?: string; contextWindow?: number } = {
    ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
    ...(typeof data.model === "string" ? { model: data.model } : {}),
    ...(typeof data.contextWindow === "number" && Number.isFinite(data.contextWindow)
      ? { contextWindow: data.contextWindow }
      : {}),
  };
  modelContexts.set(ctx.sessionKey, captured);
  return;
}
```

In `projectRun(ctx)`:

```ts
projectRun(ctx) {
  if (isCommandText(ctx.input)) return null;
  const usage = ctx.directive.usage;
  const captured = modelContexts.get(ctx.sessionKey);
  return {
    status: ctx.directive.status ?? "error",
    parameters: {
      provider: captured?.provider ?? provider,
      model: captured?.model ?? model,
      ...(captured?.contextWindow !== undefined ? { contextWindow: captured.contextWindow } : {}),
      ...(usage !== undefined ? { usage } : {}),
    },
  };
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @science-studio/transport-dsh`
Expected: PASS (all suites, including behavior).

---

### Task 2: runs route accepts a `sessionId` filter

**Files:**
- Modify: `services/transport-service/src/server.ts:242-245`
- Test: `services/transport-service/test/projects.test.ts:124`

**Interfaces:**
- Produces: `GET /api/projects/:id/runs?sessionId=<sid>` returns only that Session's Runs; no query returns all.

- [ ] **Step 1: Write the failing test**

Extend the existing "rolls up the Runs of all its Sessions" test (or add a sibling):

```ts
test("GET /api/projects/:id/runs can filter to one Session", async () => {
  const records = createInMemoryRecordStore();
  const run = (id: string, sessionId: string): Run => ({
    id, sessionId, projectId: "p1", status: "completed", agentId: "main", parameters: {}, input: "q", output: "a",
  });
  await records.createProject({ id: "p1", name: "P1", createdAt: "2026-01-01T00:00:00.000Z" });
  await records.addRun(run("r1", "s1"));
  await records.addRun(run("r2", "s2"));

  await withServer(backendWith(records), async (base) => {
    const scoped = (await (await fetch(`${base}/api/projects/p1/runs?sessionId=s1`)).json()) as { runs: Run[] };
    assert.deepEqual(scoped.runs.map((r) => r.id), ["r1"]);
    const all = (await (await fetch(`${base}/api/projects/p1/runs`)).json()) as { runs: Run[] };
    assert.deepEqual(all.runs.map((r) => r.id), ["r1", "r2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @science-studio/transport-service`
Expected: FAIL — the filtered request returns `["r1","r2"]`.

- [ ] **Step 3: Implement**

Replace the route body:

```ts
app.get("/api/projects/:id/runs", async (request) => {
  const { id } = request.params as { id: string };
  const { sessionId } = request.query as { sessionId?: string };
  const runs = await directory.listRuns(id);
  return { runs: sessionId ? runs.filter((run) => run.sessionId === sessionId) : runs };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @science-studio/transport-service`
Expected: PASS.

---

### Task 3: client runs fetch helper

**Files:**
- Modify: `packages/transport-client/src/projects.ts`
- Test: `packages/transport-client/test/projects.test.ts`

**Interfaces:**
- Produces: `fetchSessionRuns(api: string, projectId: string, sessionId: string): Promise<Run[]>`.

- [ ] **Step 1: Write the failing test**

```ts
import { fetchSessionRuns } from "../src/projects.js";

test("fetchSessionRuns scopes the runs request to one Session", async () => {
  await withFetch({ runs: [] }, async (calls) => {
    const runs = await fetchSessionRuns(API, "p 1", "s/1");
    assert.deepEqual(runs, []);
    assert.equal(calls[0]!.url, `${API}/p%201/runs?sessionId=s%2F1`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @science-studio/transport-client`
Expected: FAIL — `fetchSessionRuns is not a function`.

- [ ] **Step 3: Implement**

Append to `packages/transport-client/src/projects.ts`:

```ts
/** The Runs of ONE Session (the status bar's metrics source). */
export async function fetchSessionRuns(
  api: string,
  projectId: string,
  sessionId: string,
): Promise<Run[]> {
  const body = await request<{ runs: Run[] }>(
    `${base(api)}/${encodeURIComponent(projectId)}/runs?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return body.runs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @science-studio/transport-client`
Expected: PASS.

---

### Task 4: pure metrics summarizer + formatter

**Files:**
- Create: `packages/transport-client/src/session-metrics.ts`
- Test: `packages/transport-client/test/session-metrics.test.ts`

**Interfaces:**
- Produces:
  - `interface TokenUsage { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }`
  - `interface SessionMetrics { model?: { provider?: string; model?: string; contextWindow?: number }; latest?: { usage?: TokenUsage; status?: RunStatus; at?: string }; cumulative: { input: number; output: number; total: number; runs: number } }`
  - `summarizeSessionRuns(runs: Run[], sessionId: string): SessionMetrics`
  - `formatTokens(n: number | undefined): string`
- Consumes: `Run`, `RunStatus` from `@science-studio/record`.

- [ ] **Step 1: Write the failing tests**

Create `packages/transport-client/test/session-metrics.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "@science-studio/record";
import { formatTokens, summarizeSessionRuns } from "../src/session-metrics.js";

function run(over: Partial<Run>): Run {
  return {
    id: "r", sessionId: "s1", projectId: "p1", status: "completed", agentId: "main",
    parameters: {}, input: "q", ...over,
  };
}

test("filters to the Session and orders by finishedAt", () => {
  const metrics = summarizeSessionRuns(
    [
      run({ id: "b", sessionId: "s1", finishedAt: "2026-01-02T00:00:00.000Z" }),
      run({ id: "x", sessionId: "s2", finishedAt: "2026-01-03T00:00:00.000Z" }),
      run({ id: "a", sessionId: "s1", finishedAt: "2026-01-01T00:00:00.000Z" }),
    ],
    "s1",
  );
  assert.equal(metrics.latest!.status, undefined);
  assert.equal(metrics.cumulative.runs, 2);
});

test("sums input/output and derives total when totalTokens is absent", () => {
  const metrics = summarizeSessionRuns(
    [
      run({ id: "a", parameters: { usage: { inputTokens: 100, outputTokens: 20 } } }),
      run({ id: "b", parameters: { usage: { inputTokens: 50, outputTokens: 10, totalTokens: 70 } } }),
    ],
    "s1",
  );
  assert.deepEqual(metrics.cumulative, { input: 150, output: 30, total: 190, runs: 2 });
});

test("latest picks the newest Run and its usage", () => {
  const metrics = summarizeSessionRuns(
    [
      run({ id: "a", finishedAt: "2026-01-01T00:00:00.000Z", parameters: { usage: { inputTokens: 5, outputTokens: 1 } } }),
      run({ id: "b", finishedAt: "2026-01-02T00:00:00.000Z", parameters: { usage: { inputTokens: 900, outputTokens: 40 } } }),
    ],
    "s1",
  );
  assert.equal(metrics.latest!.usage!.inputTokens, 900);
});

test("model fields come from the most recent Run that carries them, merged", () => {
  const metrics = summarizeSessionRuns(
    [
      run({ id: "a", finishedAt: "2026-01-01T00:00:00.000Z", parameters: { provider: "p", model: "m", contextWindow: 128000 } }),
      run({ id: "b", finishedAt: "2026-01-02T00:00:00.000Z" }),
    ],
    "s1",
  );
  assert.deepEqual(metrics.model, { provider: "p", model: "m", contextWindow: 128000 });
});

test("malformed usage is ignored, not fatal", () => {
  const metrics = summarizeSessionRuns(
    [run({ id: "a", parameters: { usage: { inputTokens: "nope" } } })],
    "s1",
  );
  assert.deepEqual(metrics.cumulative, { input: 0, output: 0, total: 0, runs: 1 });
  assert.equal(metrics.latest!.usage, undefined);
});

test("formatTokens renders exact small numbers and compact large ones", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12_300), "12.3k");
  assert.equal(formatTokens(1_200_000), "1.2M");
  assert.equal(formatTokens(undefined), "—");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @science-studio/transport-client`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/transport-client/src/session-metrics.ts`:

```ts
"use client";

/**
 * Session metrics for the status bar: a PURE summarizer over the Session's
 * persisted Runs (the record is the source of truth) plus token formatting.
 * React-free so it is unit-testable; the fetch hook lives in
 * `use-session-metrics.ts`.
 */
import type { Run, RunStatus } from "@science-studio/record";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface SessionMetrics {
  model?: { provider?: string; model?: string; contextWindow?: number };
  latest?: { usage?: TokenUsage; status?: RunStatus; at?: string };
  cumulative: { input: number; output: number; total: number; runs: number };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!isFiniteNumber(raw.inputTokens) || !isFiniteNumber(raw.outputTokens)) return undefined;
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    ...(isFiniteNumber(raw.totalTokens) ? { totalTokens: raw.totalTokens } : {}),
    ...(isFiniteNumber(raw.cacheReadTokens) ? { cacheReadTokens: raw.cacheReadTokens } : {}),
    ...(isFiniteNumber(raw.cacheWriteTokens) ? { cacheWriteTokens: raw.cacheWriteTokens } : {}),
    ...(isFiniteNumber(raw.reasoningTokens) ? { reasoningTokens: raw.reasoningTokens } : {}),
  };
}

function runTotal(usage: TokenUsage): number {
  return usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
}

export function summarizeSessionRuns(runs: Run[], sessionId: string): SessionMetrics {
  const scoped = runs
    .filter((run) => run.sessionId === sessionId)
    .map((run, index) => ({ run, index }))
    .sort((a, b) => {
      const at = a.run.finishedAt ?? a.run.startedAt;
      const bt = b.run.finishedAt ?? b.run.startedAt;
      if (at && bt && at !== bt) return at < bt ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.run);

  const cumulative = { input: 0, output: 0, total: 0, runs: scoped.length };
  const latest = scoped.at(-1);
  let model: SessionMetrics["model"] | undefined;

  for (const run of scoped) {
    const usage = parseUsage(run.parameters?.usage);
    if (usage) {
      cumulative.input += usage.inputTokens;
      cumulative.output += usage.outputTokens;
      cumulative.total += runTotal(usage);
    }
    const provider = typeof run.parameters?.provider === "string" ? run.parameters.provider : undefined;
    const modelId = typeof run.parameters?.model === "string" ? run.parameters.model : undefined;
    const contextWindow = isFiniteNumber(run.parameters?.contextWindow) ? run.parameters.contextWindow : undefined;
    if (provider !== undefined || modelId !== undefined || contextWindow !== undefined) {
      model = { ...model, ...(provider ? { provider } : {}), ...(modelId ? { model: modelId } : {}), ...(contextWindow !== undefined ? { contextWindow } : {}) };
    }
  }

  const latestUsage = latest ? parseUsage(latest.parameters?.usage) : undefined;
  return {
    ...(model ? { model } : {}),
    ...(latest
      ? {
          latest: {
            ...(latestUsage ? { usage: latestUsage } : {}),
            status: latest.status,
            ...(latest.finishedAt ? { at: latest.finishedAt } : {}),
          },
        }
      : {}),
    cumulative,
  };
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @science-studio/transport-client`
Expected: PASS.

---

### Task 5: metrics fetch hook + exports

**Files:**
- Create: `packages/transport-client/src/use-session-metrics.ts`
- Modify: `packages/transport-client/src/index.ts`

**Interfaces:**
- Consumes: `fetchSessionRuns`, `summarizeSessionRuns`, `SessionMetrics`.
- Produces: `useSessionMetrics({ api, projectId, sessionId, revision }): SessionMetrics | null`.

- [ ] **Step 1: Implement the hook**

Create `packages/transport-client/src/use-session-metrics.ts`:

```ts
"use client";

import { useEffect, useRef, useState } from "react";
import { fetchSessionRuns, DEFAULT_PROJECTS_API } from "./projects.js";
import { summarizeSessionRuns, type SessionMetrics } from "./session-metrics.js";

export interface UseSessionMetricsOptions {
  api?: string;
  projectId: string | null;
  sessionId: string | null;
  /** Bump to refetch (e.g. a run finished); identity change refetches too. */
  revision?: number;
}

/**
 * The active Session's metrics, sourced from its persisted Runs. Refetches on
 * scope change and whenever `revision` changes; a failed fetch keeps the last
 * value (never throws into render). No scope → no request, `null`.
 */
export function useSessionMetrics(options: UseSessionMetricsOptions): SessionMetrics | null {
  const api = options.api ?? DEFAULT_PROJECTS_API;
  const { projectId, sessionId, revision = 0 } = options;
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null);
  const lastRef = useRef<SessionMetrics | null>(null);

  useEffect(() => {
    if (!projectId || !sessionId) {
      lastRef.current = null;
      setMetrics(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const runs = await fetchSessionRuns(api, projectId, sessionId);
        if (!active) return;
        const next = summarizeSessionRuns(runs, sessionId);
        lastRef.current = next;
        setMetrics(next);
      } catch {
        // Keep the previous value; a transient record failure must not blank the bar.
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, projectId, sessionId, revision]);

  return metrics ?? lastRef.current;
}
```

- [ ] **Step 2: Export**

In `packages/transport-client/src/index.ts` add:

```ts
export { fetchSessionRuns } from "./projects.js";
export { formatTokens, summarizeSessionRuns } from "./session-metrics.js";
export type { SessionMetrics, TokenUsage } from "./session-metrics.js";
export { useSessionMetrics } from "./use-session-metrics.js";
export type { UseSessionMetricsOptions } from "./use-session-metrics.js";
```

(`fetchProjectRuns` is already exported where appropriate; keep its existing line.)

- [ ] **Step 3: Typecheck**

Run: `npm run build -w @science-studio/transport-client`
Expected: PASS.

---

### Task 6: store revision + run-finish wiring

**Files:**
- Modify: `apps/web/store/studio-store.ts`
- Modify: `apps/web/components/session-view.tsx`

**Interfaces:**
- Produces: `runsRevision: number`, `bumpRunsRevision(): void` on the store.

- [ ] **Step 1: Add the store fields**

In `State`:
```ts
/** Bumped when a run finishes, so the status bar refetches its Session metrics. */
runsRevision: number;
bumpRunsRevision: () => void;
```
In the initial state: `runsRevision: 0,` and:
```ts
bumpRunsRevision: () => set((s) => ({ runsRevision: s.runsRevision + 1 })),
```

- [ ] **Step 2: Wire `onFinish`**

In `apps/web/components/session-view.tsx`:
```ts
const runtime = useTransport({
  api,
  projectId,
  threadId: sessionId,
  onFinish: () => useStudioStore.getState().bumpRunsRevision(),
});
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: PASS.

---

### Task 7: status bar chip

**Files:**
- Modify: `apps/web/components/studio/status-bar.tsx`

**Interfaces:**
- Consumes: `useSessionMetrics`, `formatTokens`, `DEFAULT_PROJECTS_API` from `@science-studio/transport-client`.

- [ ] **Step 1: Implement `SessionStatusChip`**

Add near the other project-panel-style consts:
```ts
const PROJECTS_API = process.env.NEXT_PUBLIC_PROJECTS_URL ?? "/api/projects";
```

Replace `SessionStatusChip` with:

```tsx
function SessionStatusChip() {
  const activeSessionId = useStudioStore((s) => s.activeSessionId);
  const projectId = useStudioStore((s) => s.projectId);
  const sessions = useStudioStore((s) => s.sessions);
  const runsRevision = useStudioStore((s) => s.runsRevision);
  const active = sessions.find((s) => s.id === activeSessionId) ?? null;
  const metrics = useSessionMetrics({
    api: PROJECTS_API,
    projectId,
    sessionId: activeSessionId,
    revision: runsRevision,
  });

  const usage = metrics?.latest?.usage;
  const used = usage?.inputTokens;
  const window = metrics?.model?.contextWindow;
  const contextLabel =
    used === undefined ? null : window === undefined
      ? formatTokens(used)
      : `${formatTokens(used)} / ${formatTokens(window)}`;
  const inline = [
    metrics?.model?.model,
    contextLabel,
  ].filter((v): v is string => Boolean(v));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-5 gap-1.5 px-1.5">
          <Activity className="size-3.5 opacity-60" />
          <span className="max-w-[18rem] truncate">
            {active?.title ?? active?.id ?? "no session"}
            {inline.length > 0 ? ` · ${inline.join(" · ")}` : ""}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-72 p-3">
        <div className="text-sm font-semibold">Session</div>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{active?.updatedAt ? new Date(active.updatedAt).toLocaleString() : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Project</dt>
            <dd>{active?.projectId ?? "—"}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Agent</dt>
            <dd>{active?.agentId ?? "—"}</dd>
          </div>
        </dl>
        <div className="mt-3 border-t pt-2 text-sm font-semibold">Token usage</div>
        {metrics && metrics.cumulative.runs > 0 ? (
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="break-all">
                {metrics.model?.provider && metrics.model.model
                  ? `${metrics.model.provider}/${metrics.model.model}`
                  : (metrics.model?.model ?? "—")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Context</dt>
              <dd>{contextLabel ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last turn</dt>
              <dd>
                {usage
                  ? `${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Total (last)</dt>
              <dd>{usage ? formatTokens(usage.totalTokens ?? usage.inputTokens + usage.outputTokens) : "—"}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-muted-foreground">Session total</dt>
              <dd>
                {formatTokens(metrics.cumulative.input)} in /{" "}
                {formatTokens(metrics.cumulative.output)} out · {formatTokens(metrics.cumulative.total)} total ·{" "}
                {metrics.cumulative.runs} {metrics.cumulative.runs === 1 ? "turn" : "turns"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No turns yet.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

Update the imports: add `useSessionMetrics`, `formatTokens`; remove nothing existing.

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual verification**

Run `npm run dev:dsh`, open a session, send a turn; the bar shows `· <model> · <used>/<window>` after the turn settles, and the popover shows the breakdown. Reload → same numbers (record-sourced).

---

### Task 8: final gate

- [ ] **Step 1: Full build + tests**

Run: `npm run build`
Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Web suite**

Run: `npm run test:e2e -w @science-studio/web`
Expected: PASS or SKIP (needs Chromium); no new failures.

---

## Self-Review

- **Spec coverage:** dsh capture → Task 1; service filter → Task 2; fetch → Task 3; pure summarize + format → Task 4; hook → Task 5; refresh wiring → Task 6; UI → Task 7; gate → Task 8. Test plan in the spec maps to Tasks 1–4, 8.
- **Placeholders:** none.
- **Type consistency:** `SessionMetrics`/`TokenUsage`/`summarizeSessionRuns`/`formatTokens`/`fetchSessionRuns`/`useSessionMetrics` names match across tasks.
