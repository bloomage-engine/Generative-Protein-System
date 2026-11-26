# dsh cron scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-Project scheduled agent runs: a `.gps/cron/<id>.md` task fires at a cron schedule, the service drives a normal run on its target Session with the task's prompt, the run is logged to a sibling `.log.md`, and the right-pane Cron module lists tasks and opens them in a form tab.

**Architecture:** A new pure package `@gps/cron` owns the task-document codec, the 5-field schedule grammar and the run-log format. The transport-service owns a workspace-backed store, CRUD routes, and a scheduler that calls `adapter.run()` and shares the existing one-in-flight `activeRuns` lock. A dsh child plugin (mounted by a third per-launch `--patch`) gives the agent `schedule_*` tools and a `/cron` command. The web reaches the routes through one proxy hop and `transport-client` hooks.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), Node 18+, Fastify 5, node:test + tsx, React 19 / Next 15 / Zustand, shadcn/ui, the existing dsh cordis child-plugin mechanism.

## Global Constraints

- Node >= 18, `"type": "module"`, TypeScript strict with `noUncheckedIndexedAccess`; relative imports carry the `.js` suffix.
- `@gps/cron` is pure and zero-dependency: **no `node:` imports** (it is imported by the browser bundle), no external packages.
- dsh child plugins import **nothing** from `@deepseek-ai/*`; they never write to **stdout** (it is the child's JSON-RPC wire, use `process.stderr`); every registration is guarded so a failure never kills the child.
- Schedule grammar: exactly 5 fields `minute hour day-of-month month day-of-week`, each `*`, `n`, `a-b`, `a,b`, `*/n`, `a-b/n`; a task fires when ALL five match (NOT the standard cron OR between day-of-month and day-of-week). Local time.
- Tests run with `node --import tsx --test test/*.test.ts` inside each package. Cross-package imports resolve to `dist`, so build a dependency package before running its consumers' tests.
- UI copy stays English like the existing panels; code comments match each file's existing style.
- Commit after every task; the message style is the repo's (`feat(scope): …`, `test(scope): …`, `docs(scope): …`).

---

### Task 1: `@gps/cron` package + schedule grammar

**Files:**
- Create: `packages/cron/package.json`
- Create: `packages/cron/tsconfig.json`
- Create: `packages/cron/src/schedule.ts`
- Create: `packages/cron/src/index.ts`
- Create: `packages/cron/test/schedule.test.ts`
- Modify: `package.json` (root `build` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `parseSchedule(expr): ParsedSchedule | null`, `isValidSchedule(expr): boolean`, `matchesSchedule(expr, at: Date): boolean`, `describeSchedule(expr): string`, `SCHEDULE_PRESETS`, `presetToExpression(preset, opts?): string`, types `SchedulePreset`, `SchedulePresetOption`, `ParsedSchedule`, `PresetOptions`.

- [ ] **Step 1: Create the package manifests**

`packages/cron/package.json`:

```json
{
  "name": "@gps/cron",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit",
    "test": "node --import tsx --test test/*.test.ts"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.19.0"
  }
}
```

`packages/cron/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

Modify the root `package.json` `build` script: insert `npm run build -w @gps/cron &&` immediately after `npm run build -w @gps/workspace &&` (the package has no deps; it must build before `transport-client`/`transport-dsh`/`transport-service`).

- [ ] **Step 2: Write the failing test**

`packages/cron/test/schedule.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeSchedule,
  isValidSchedule,
  matchesSchedule,
  parseSchedule,
  presetToExpression,
} from "../src/schedule.js";

test("the grammar accepts the supported subset and rejects everything else", () => {
  for (const ok of ["0 9 * * *", "*/15 * * * *", "0 9 * * 1", "0 0 1,15 * *", "5-10/2 * * * *"]) {
    assert.equal(isValidSchedule(ok), true, `${ok} should be valid`);
  }
  for (const bad of ["", "0 9 * *", "0 9 * * * *", "60 9 * * *", "0 24 * * *", "0 9 0 * *", "*/0 * * * *", "a * * * *"]) {
    assert.equal(isValidSchedule(bad), false, `${bad} should be invalid`);
  }
});

test("matching requires ALL five fields (AND semantics)", () => {
  const at = new Date(2026, 8, 18, 9, 30, 0); // 2026-09-18 09:30 local
  assert.equal(matchesSchedule("30 9 * * *", at), true);
  assert.equal(matchesSchedule("30 9 18 9 *", at), true);
  assert.equal(matchesSchedule("30 10 * * *", at), false);
  assert.equal(matchesSchedule("31 9 * * *", at), false);
  // Both day-of-month and day-of-week must match (unlike standard cron's OR).
  assert.equal(matchesSchedule("30 9 19 * 5", at), false);
});

test("presets write canonical expressions", () => {
  assert.equal(presetToExpression("hourly"), "0 * * * *");
  assert.equal(presetToExpression("daily", { hour: 9, minute: 30 }), "30 9 * * *");
  assert.equal(presetToExpression("weekly", { hour: 8, minute: 0, weekday: 1 }), "0 8 * * 1");
});

test("describeSchedule names the common shapes and falls back to the expression", () => {
  assert.equal(describeSchedule("0 * * * *"), "Every hour at :00");
  assert.equal(describeSchedule("30 9 * * *"), "Every day at 09:30");
  assert.equal(describeSchedule("0 9 * * 1"), "Every Monday at 09:00");
  assert.equal(describeSchedule("*/15 * * * *"), "*/15 * * * *");
  assert.equal(parseSchedule("0 9 * * *")?.length, 5);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -w @gps/cron`
Expected: FAIL — `Cannot find module '../src/schedule.js'` (or the package's `test` script missing).

- [ ] **Step 4: Implement the schedule grammar**

`packages/cron/src/schedule.ts`:

```ts
export type SchedulePreset = "hourly" | "daily" | "weekly";

export interface SchedulePresetOption {
  readonly id: SchedulePreset;
  readonly label: string;
}

export const SCHEDULE_PRESETS: readonly SchedulePresetOption[] = [
  { id: "hourly", label: "Every hour" },
  { id: "daily", label: "Every day" },
  { id: "weekly", label: "Every week" },
];

interface FieldSpec {
  readonly min: number;
  readonly max: number;
}

const MINUTE: FieldSpec = { min: 0, max: 59 };
const HOUR: FieldSpec = { min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { min: 1, max: 31 };
const MONTH: FieldSpec = { min: 1, max: 12 };
const DAY_OF_WEEK: FieldSpec = { min: 0, max: 6 };

const FIELDS: readonly FieldSpec[] = [MINUTE, HOUR, DAY_OF_MONTH, MONTH, DAY_OF_WEEK];

export type ParsedSchedule = readonly [
  ReadonlySet<number>,
  ReadonlySet<number>,
  ReadonlySet<number>,
  ReadonlySet<number>,
  ReadonlySet<number>,
];

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function isDigits(text: string | undefined): text is string {
  return text !== undefined && /^\d+$/.test(text);
}

function parseField(text: string, spec: FieldSpec): Set<number> | null {
  if (text === "") return null;
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [base, stepText, extra] = part.split("/");
    if (extra !== undefined) return null;
    let step = 1;
    if (stepText !== undefined) {
      if (!isDigits(stepText)) return null;
      step = Number(stepText);
      if (step < 1) return null;
    }
    let start: number;
    let end: number;
    if (base === "*") {
      start = spec.min;
      end = spec.max;
    } else if (base !== undefined && base.includes("-")) {
      const [from, to, dashExtra] = base.split("-");
      if (dashExtra !== undefined || !isDigits(from) || !isDigits(to)) return null;
      start = Number(from);
      end = Number(to);
    } else {
      if (!isDigits(base)) return null;
      start = Number(base);
      end = stepText === undefined ? start : spec.max;
    }
    if (start < spec.min || end > spec.max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseSchedule(expression: string): ParsedSchedule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const parsed = parts.map((part, index) => parseField(part, FIELDS[index]!));
  if (parsed.some((field) => field === null)) return null;
  return parsed as unknown as ParsedSchedule;
}

export function isValidSchedule(expression: string): boolean {
  return parseSchedule(expression) !== null;
}

function isFull(values: ReadonlySet<number>, spec: FieldSpec): boolean {
  return values.size === spec.max - spec.min + 1;
}

export function matchesSchedule(expression: string, at: Date): boolean {
  const parsed = parseSchedule(expression);
  if (parsed === null) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed;
  return (
    minute.has(at.getMinutes()) &&
    hour.has(at.getHours()) &&
    dayOfMonth.has(at.getDate()) &&
    month.has(at.getMonth() + 1) &&
    dayOfWeek.has(at.getDay())
  );
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function describeSchedule(expression: string): string {
  const parsed = parseSchedule(expression);
  if (parsed === null) return expression;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed;
  const calendarFull = isFull(dayOfMonth, DAY_OF_MONTH) && isFull(month, MONTH);
  if (minute.size === 1 && hour.size === 24 && calendarFull && isFull(dayOfWeek, DAY_OF_WEEK)) {
    return `Every hour at :${pad2([...minute][0]!)}`;
  }
  if (minute.size === 1 && hour.size === 1 && calendarFull) {
    const time = `${pad2(hour.values().next().value!)}:${pad2(minute.values().next().value!)}`;
    if (isFull(dayOfWeek, DAY_OF_WEEK)) return `Every day at ${time}`;
    if (dayOfWeek.size === 1) return `Every ${WEEKDAYS[dayOfWeek.values().next().value!]} at ${time}`;
  }
  return expression;
}

export interface PresetOptions {
  /** 0-23; the default is 9. */
  hour?: number;
  /** 0-59; the default is 0. */
  minute?: number;
  /** 0 = Sunday … 6 = Saturday; the default is 1 (Monday). */
  weekday?: number;
}

export function presetToExpression(preset: SchedulePreset, options: PresetOptions = {}): string {
  const minute = options.minute ?? 0;
  const hour = options.hour ?? 9;
  const weekday = options.weekday ?? 1;
  switch (preset) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
  }
}
```

`packages/cron/src/index.ts` (explicit re-exports — the repo's convention):

```ts
export {
  SCHEDULE_PRESETS,
  describeSchedule,
  isValidSchedule,
  matchesSchedule,
  parseSchedule,
  presetToExpression,
  type ParsedSchedule,
  type PresetOptions,
  type SchedulePreset,
  type SchedulePresetOption,
} from "./schedule.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w @gps/cron`
Expected: PASS (4 tests).

- [ ] **Step 6: Build and typecheck the package**

Run: `npm run build -w @gps/cron`
Expected: exits 0, creates `packages/cron/dist`.

- [ ] **Step 7: Commit**

```bash
git add packages/cron package.json
git commit -m "feat(cron): add the pure schedule grammar package"
```

---

### Task 2: Task-document codec + run log

**Files:**
- Create: `packages/cron/src/task-doc.ts`
- Create: `packages/cron/src/log.ts`
- Modify: `packages/cron/src/index.ts`
- Create: `packages/cron/test/task-doc.test.ts`
- Create: `packages/cron/test/log.test.ts`

**Interfaces:**
- Consumes: `isValidSchedule` (Task 1).
- Produces: `CRON_DIR`, `CronTask`, `ParseResult`, `isValidTaskId`, `cronTaskPath`, `cronLogPath`, `isCronTaskPath`, `taskIdFromPath`, `parseTaskDoc`, `serializeTaskDoc`; `CronRunStatus`, `CronLogEntry`, `appendLogEntry`, `latestLogEntry`.

- [ ] **Step 1: Write the failing task-doc test**

`packages/cron/test/task-doc.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CRON_DIR,
  cronLogPath,
  cronTaskPath,
  isCronTaskPath,
  parseTaskDoc,
  serializeTaskDoc,
  taskIdFromPath,
  type CronTask,
} from "../src/task-doc.js";

const TASK: CronTask = {
  id: "daily-digest",
  name: "Daily digest",
  schedule: "0 9 * * *",
  enabled: true,
  sessionId: "sess-abc",
  prompt: "Summarize the feeds.",
  createdAt: "2026-09-18T00:00:00.000Z",
};

test("a task document round-trips through serialize/parse", () => {
  const text = serializeTaskDoc(TASK);
  const parsed = parseTaskDoc(TASK.id, text);
  assert.ok("task" in parsed);
  assert.deepEqual(parsed.task, TASK);
});

test("paths are recognized and the log file is never a task", () => {
  assert.equal(CRON_DIR, ".gps/cron");
  assert.equal(cronTaskPath("x1"), ".gps/cron/x1.md");
  assert.equal(cronLogPath("x1"), ".gps/cron/x1.log.md");
  assert.equal(taskIdFromPath(cronTaskPath("x1")), "x1");
  assert.equal(isCronTaskPath(cronTaskPath("x1")), true);
  assert.equal(isCronTaskPath(cronLogPath("x1")), false);
  assert.equal(isCronTaskPath("notes.md"), false);
  assert.equal(taskIdFromPath(".gps/cron/sub/x.md"), null);
});

test("parse rejects malformed documents with a reason", () => {
  assert.ok("error" in parseTaskDoc("bad id!", serializeTaskDoc(TASK)));
  assert.ok("error" in parseTaskDoc("x", "no frontmatter"));
  assert.ok("error" in parseTaskDoc("x", "---\nname: \"x\"\nschedule: \"nope\"\n---\nbody"));
  const missingName = "---\nschedule: \"0 9 * * *\"\n---\nbody";
  assert.match((parseTaskDoc("x", missingName) as { error: string }).error, /name/);
});

test("a hand-edited unquoted scalar still parses", () => {
  const text = "---\nname: Daily digest\nschedule: 0 9 * * *\nenabled: true\n---\nDo it.\n";
  const parsed = parseTaskDoc("daily-digest", text);
  assert.ok("task" in parsed);
  assert.equal(parsed.task.name, "Daily digest");
  assert.equal(parsed.task.prompt, "Do it.\n");
});
```

- [ ] **Step 2: Write the failing log test**

`packages/cron/test/log.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendLogEntry, latestLogEntry } from "../src/log.js";

test("appending and reading back the latest entry", () => {
  let text = "";
  text = appendLogEntry(text, {
    at: "2026-09-18T09:00:00.000Z",
    status: "success",
    sessionId: "s1",
    message: "All good.",
  });
  text = appendLogEntry(text, {
    at: "2026-09-19T09:00:00.000Z",
    status: "skipped-busy",
    sessionId: "s1",
  });
  assert.equal(latestLogEntry(text)?.status, "skipped-busy");
  assert.equal(latestLogEntry(text)?.at, "2026-09-19T09:00:00.000Z");
  const withMessage = appendLogEntry(text, {
    at: "2026-09-20T09:00:00.000Z",
    status: "success",
    runId: "run-1",
    message: "Line one\n\nLine two",
  });
  const last = latestLogEntry(withMessage);
  assert.equal(last?.runId, "run-1");
  assert.match(last?.message ?? "", /Line two/);
  assert.equal(latestLogEntry(""), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test -w @gps/cron`
Expected: FAIL — `Cannot find module '../src/task-doc.js'`.

- [ ] **Step 4: Implement the codec and the log**

`packages/cron/src/task-doc.ts`:

```ts
import { isValidSchedule } from "./schedule.js";

export const CRON_DIR = ".gps/cron";

const TASK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_SUFFIX = ".md";
const LOG_SUFFIX = ".log.md";

export interface CronTask {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  sessionId?: string;
  prompt: string;
  createdAt?: string;
  updatedAt?: string;
}

export type ParseResult = { task: CronTask } | { error: string };

export function isValidTaskId(id: string): boolean {
  return TASK_ID.test(id);
}

export function cronTaskPath(id: string): string {
  return `${CRON_DIR}/${id}${TASK_SUFFIX}`;
}

export function cronLogPath(id: string): string {
  return `${CRON_DIR}/${id}${LOG_SUFFIX}`;
}

export function taskIdFromPath(path: string): string | null {
  const prefix = `${CRON_DIR}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.includes("/")) return null;
  if (!rest.endsWith(TASK_SUFFIX) || rest.endsWith(LOG_SUFFIX)) return null;
  const id = rest.slice(0, -TASK_SUFFIX.length);
  return isValidTaskId(id) ? id : null;
}

export function isCronTaskPath(path: string): boolean {
  return taskIdFromPath(path) !== null;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  return trimmed;
}

export function parseTaskDoc(id: string, text: string): ParseResult {
  if (!isValidTaskId(id)) return { error: `invalid task id: ${id}` };
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { error: "missing frontmatter" };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { error: "unterminated frontmatter" };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "");
  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) return { error: `malformed frontmatter line: ${line}` };
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const name = unquote(fields.get("name") ?? "");
  if (name === "") return { error: "missing name" };
  const schedule = unquote(fields.get("schedule") ?? "");
  if (!isValidSchedule(schedule)) return { error: `invalid schedule: ${schedule}` };
  const enabledRaw = (fields.get("enabled") ?? "true").trim();
  if (enabledRaw !== "true" && enabledRaw !== "false") return { error: `invalid enabled: ${enabledRaw}` };
  const sessionId = unquote(fields.get("sessionId") ?? "");
  const createdAt = unquote(fields.get("createdAt") ?? "");
  const updatedAt = unquote(fields.get("updatedAt") ?? "");
  return {
    task: {
      id,
      name,
      schedule,
      enabled: enabledRaw === "true",
      prompt: body,
      ...(sessionId ? { sessionId } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    },
  };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function serializeTaskDoc(task: CronTask): string {
  const lines = [
    "---",
    `name: ${quote(task.name)}`,
    `schedule: ${quote(task.schedule)}`,
    `enabled: ${task.enabled ? "true" : "false"}`,
  ];
  if (task.sessionId) lines.push(`sessionId: ${quote(task.sessionId)}`);
  if (task.createdAt) lines.push(`createdAt: ${quote(task.createdAt)}`);
  if (task.updatedAt) lines.push(`updatedAt: ${quote(task.updatedAt)}`);
  lines.push("---", "", task.prompt, "");
  return lines.join("\n");
}
```

`packages/cron/src/log.ts`:

```ts
export type CronRunStatus = "success" | "skipped-busy" | "error";

export interface CronLogEntry {
  at: string;
  status: CronRunStatus;
  sessionId?: string;
  runId?: string;
  message?: string;
}

const HEADER_SOURCE = "^## (\\S+) · (success|skipped-busy|error)$";

export function appendLogEntry(existing: string, entry: CronLogEntry): string {
  const block = [`## ${entry.at} · ${entry.status}`];
  if (entry.sessionId) block.push(`- session: ${entry.sessionId}`);
  if (entry.runId) block.push(`- run: ${entry.runId}`);
  block.push("");
  if (entry.message) block.push(entry.message);
  block.push("");
  const base = existing.trim() === "" ? "" : `${existing.replace(/\s+$/, "")}\n\n`;
  return `${base}${block.join("\n")}`;
}

export function latestLogEntry(existing: string): CronLogEntry | null {
  const headers = [...existing.matchAll(new RegExp(HEADER_SOURCE, "gm"))];
  const last = headers[headers.length - 1];
  if (!last || last.index === undefined) return null;
  const section = existing.slice(last.index + last[0].length).split(/^## /m)[0] ?? "";
  const sessionId = /^- session: (.+)$/m.exec(section)?.[1]?.trim();
  const runId = /^- run: (.+)$/m.exec(section)?.[1]?.trim();
  const message = section.replace(/^- (?:session|run): .+$/gm, "").trim();
  return {
    at: last[1]!,
    status: last[2] as CronRunStatus,
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(message ? { message } : {}),
  };
}
```

Append to `packages/cron/src/index.ts`:

```ts
export {
  CRON_DIR,
  cronLogPath,
  cronTaskPath,
  isCronTaskPath,
  isValidTaskId,
  parseTaskDoc,
  serializeTaskDoc,
  taskIdFromPath,
  type CronTask,
  type ParseResult,
} from "./task-doc.js";
export {
  appendLogEntry,
  latestLogEntry,
  type CronLogEntry,
  type CronRunStatus,
} from "./log.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @gps/cron`
Expected: PASS (all schedule + task-doc + log tests).

- [ ] **Step 6: Build**

Run: `npm run build -w @gps/cron`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/cron
git commit -m "feat(cron): parse/serialize task documents and append run logs"
```

---

### Task 3: Service cron store (workspace-backed)

**Files:**
- Modify: `services/transport-service/package.json` (add `@gps/cron`)
- Modify: `services/transport-service/tsconfig.json` (add the `../../packages/cron` reference)
- Create: `services/transport-service/src/cron/store.ts`
- Create: `services/transport-service/test/cron-store.test.ts`

**Interfaces:**
- Consumes: `@gps/cron` (Tasks 1-2), `Workspace` from `@gps/transport`.
- Produces: `CronTaskSummary`, `CronListResult`, `CronStore` (`list`, `read`, `write`, `remove`, `appendLog`), `createCronStore(opts?)`.

- [ ] **Step 1: Add the dependency**

In `services/transport-service/package.json` `dependencies`, add:

```json
"@gps/cron": "*",
```

In `services/transport-service/tsconfig.json` `references`, add (following the existing workspace-package references):

```json
{ "path": "../../packages/cron" }
```

- [ ] **Step 2: Write the failing test**

`services/transport-service/test/cron-store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsWorkspace } from "@gps/workspace";
import { createCronStore, type CronStore } from "../src/cron/store.js";

async function fixture<T>(
  fn: (store: CronStore, workspace: FsWorkspace, root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "gps-cron-store-"));
  const workspace = new FsWorkspace(root);
  const store = createCronStore({ now: () => "2026-09-18T00:00:00.000Z" });
  try {
    return await fn(store, workspace, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("write/read/list round-trips a task and a missing log is empty", async () => {
  await fixture(async (store, workspace) => {
    const task = await store.write(workspace, {
      id: "digest",
      name: "Digest",
      schedule: "0 9 * * *",
      enabled: true,
      prompt: "Summarize.",
    });
    assert.equal(task.updatedAt, "2026-09-18T00:00:00.000Z");
    assert.equal((await store.read(workspace, "digest"))?.name, "Digest");
    const listing = await store.list(workspace);
    assert.equal(listing.invalid.length, 0);
    assert.deepEqual(listing.tasks.map((t) => t.id), ["digest"]);
    assert.equal(listing.tasks[0]?.lastRun, undefined);
  });
});

test("a malformed file is reported as invalid, never as a task", async () => {
  await fixture(async (store, workspace, root) => {
    await store.write(workspace, { id: "ok", name: "OK", schedule: "0 9 * * *", enabled: true, prompt: "" });
    await mkdir(join(root, ".gps", "cron"), { recursive: true });
    await writeFile(join(root, ".gps", "cron", "broken.md"), "not a task");
    const listing = await store.list(workspace);
    assert.deepEqual(listing.tasks.map((t) => t.id), ["ok"]);
    assert.equal(listing.invalid.length, 1);
    assert.match(listing.invalid[0]!.error, /frontmatter/);
  });
});

test("appendLog records the latest run on the listing, and remove deletes both files", async () => {
  await fixture(async (store, workspace) => {
    await store.write(workspace, { id: "digest", name: "Digest", schedule: "0 9 * * *", enabled: true, prompt: "" });
    await store.appendLog(workspace, "digest", {
      at: "2026-09-18T09:00:00.000Z",
      status: "success",
      sessionId: "s1",
      message: "done",
    });
    const listing = await store.list(workspace);
    assert.equal(listing.tasks[0]?.lastRun?.status, "success");
    await store.remove(workspace, "digest");
    assert.equal(await store.read(workspace, "digest"), null);
    assert.deepEqual((await store.list(workspace)).tasks, []);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build -w @gps/cron && npm run test -w @gps/transport-service`
Expected: FAIL — `Cannot find module '../src/cron/store.js'`.

- [ ] **Step 4: Implement the store**

`services/transport-service/src/cron/store.ts`:

```ts
import {
  CRON_DIR,
  appendLogEntry,
  cronLogPath,
  cronTaskPath,
  latestLogEntry,
  parseTaskDoc,
  serializeTaskDoc,
  taskIdFromPath,
  type CronLogEntry,
  type CronTask,
} from "@gps/cron";
import { WorkspaceNotFoundError, type Workspace } from "@gps/transport";

export interface CronTaskSummary extends CronTask {
  path: string;
  lastRun?: CronLogEntry;
}

export interface CronListResult {
  tasks: CronTaskSummary[];
  invalid: { path: string; error: string }[];
}

export interface CronStore {
  list(workspace: Workspace): Promise<CronListResult>;
  read(workspace: Workspace, id: string): Promise<CronTask | null>;
  write(workspace: Workspace, task: CronTask): Promise<CronTask>;
  remove(workspace: Workspace, id: string): Promise<void>;
  appendLog(workspace: Workspace, id: string, entry: CronLogEntry): Promise<void>;
}

async function readText(workspace: Workspace, path: string): Promise<string | null> {
  try {
    const content = await workspace.open(path);
    return await new Response(content.body).text();
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) return null;
    throw err;
  }
}

async function writeText(workspace: Workspace, path: string, text: string): Promise<void> {
  await workspace.write(path, new TextEncoder().encode(text), { createParents: true });
}

export function createCronStore(opts: { now?: () => string } = {}): CronStore {
  const now = opts.now ?? (() => new Date().toISOString());
  return {
    async list(workspace) {
      let entries;
      try {
        ({ entries } = await workspace.list(CRON_DIR));
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError) return { tasks: [], invalid: [] };
        throw err;
      }
      const tasks: CronTaskSummary[] = [];
      const invalid: { path: string; error: string }[] = [];
      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        const id = taskIdFromPath(entry.path);
        if (id === null) continue;
        const text = await readText(workspace, entry.path);
        if (text === null) continue;
        const parsed = parseTaskDoc(id, text);
        if ("error" in parsed) {
          invalid.push({ path: entry.path, error: parsed.error });
          continue;
        }
        const log = await readText(workspace, cronLogPath(id));
        const lastRun = log === null ? null : latestLogEntry(log);
        tasks.push({ ...parsed.task, path: entry.path, ...(lastRun ? { lastRun } : {}) });
      }
      tasks.sort((a, b) => a.id.localeCompare(b.id));
      return { tasks, invalid };
    },
    async read(workspace, id) {
      const text = await readText(workspace, cronTaskPath(id));
      if (text === null) return null;
      const parsed = parseTaskDoc(id, text);
      return "error" in parsed ? null : parsed.task;
    },
    async write(workspace, task) {
      const next = { ...task, updatedAt: now() };
      await writeText(workspace, cronTaskPath(task.id), serializeTaskDoc(next));
      return next;
    },
    async remove(workspace, id) {
      if (typeof workspace.delete !== "function") return;
      for (const path of [cronTaskPath(id), cronLogPath(id)]) {
        try {
          await workspace.delete(path);
        } catch (err) {
          if (!(err instanceof WorkspaceNotFoundError)) throw err;
        }
      }
    },
    async appendLog(workspace, id, entry) {
      const existing = (await readText(workspace, cronLogPath(id))) ?? "";
      await writeText(workspace, cronLogPath(id), appendLogEntry(existing, entry));
    },
  };
}
```

Fix the test file so every `fixture` callback receives `workspace` (e.g. `async (store, workspace) => …` and `async (store, workspace, root)`); the `fixture` helper invokes `fn(store, workspace, root)`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w @gps/transport-service`
Expected: PASS (the new cron-store tests and all existing service tests).

- [ ] **Step 6: Commit**

```bash
git add services/transport-service/package.json services/transport-service/src/cron services/transport-service/test/cron-store.test.ts
git commit -m "feat(service): add the workspace-backed cron task store"
```

---

### Task 4: Service cron CRUD routes

**Files:**
- Create: `services/transport-service/src/cron/routes.ts`
- Modify: `services/transport-service/src/server.ts` (register the routes)
- Create: `services/transport-service/test/cron-routes.test.ts`

**Interfaces:**
- Consumes: `createCronStore`/`CronStore` (Task 3), `ProjectScopes` (`src/project-scope.ts`).
- Produces: `registerCronRoutes(app, { scope, store })` (Task 5 extends its deps with the scheduler and adds the run-now route).

- [ ] **Step 1: Write the failing test**

`services/transport-service/test/cron-routes.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  type RuntimeAdapter,
} from "@gps/transport";
import { FsWorkspace } from "@gps/workspace";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

function fakeAdapter(): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* () {},
    abort: () => {},
  };
}

async function withServer<T>(root: string, fn: (base: string) => Promise<T>): Promise<T> {
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: fakeAdapter(), workspace: new FsWorkspace(root) }),
    }),
    cors: { origin: true },
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

test("cron CRUD creates, lists, reads, updates and deletes a task file", async () => {
  const root = await mkdtemp(join(tmpdir(), "gps-cron-routes-"));
  try {
    await withServer(root, async (base) => {
      const created = await fetch(`${base}/api/cron/task?projectId=p1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Daily digest", schedule: "0 9 * * *", prompt: "Summarize." }),
      });
      assert.equal(created.status, 201);
      const { task } = (await created.json()) as { task: { id: string } };
      assert.equal(task.id, "daily-digest");

      const list = await (await fetch(`${base}/api/cron?projectId=p1`)).json();
      assert.equal((list as { tasks: unknown[] }).tasks.length, 1);

      const one = await fetch(`${base}/api/cron/task?projectId=p1&id=daily-digest`);
      assert.equal(one.status, 200);

      const saved = await fetch(`${base}/api/cron/task?projectId=p1&id=daily-digest`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed", schedule: "0 10 * * *", prompt: "X", enabled: false }),
      });
      assert.equal(saved.status, 200);
      assert.equal(((await saved.json()) as { task: { name: string } }).task.name, "Renamed");

      const removed = await fetch(`${base}/api/cron/task/delete?projectId=p1&id=daily-digest`, { method: "POST" });
      assert.equal(removed.status, 200);
      assert.equal((await (await fetch(`${base}/api/cron?projectId=p1`)).json() as { tasks: unknown[] }).tasks.length, 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid schedule is a 400, an unknown id a 404", async () => {
  const root = await mkdtemp(join(tmpdir(), "gps-cron-routes-"));
  try {
    await withServer(root, async (base) => {
      const bad = await fetch(`${base}/api/cron/task?projectId=p1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", schedule: "nope", prompt: "y" }),
      });
      assert.equal(bad.status, 400);
      assert.equal((await fetch(`${base}/api/cron/task?projectId=p1&id=missing`)).status, 404);
      assert.equal((await fetch(`${base}/api/cron/task?projectId=p1&id=bad%20id`)).status, 400);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build -w @gps/cron && npm run test -w @gps/transport-service`
Expected: FAIL — `/api/cron` answers 404.

- [ ] **Step 3: Implement the routes**

`services/transport-service/src/cron/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { isValidSchedule, isValidTaskId, type CronTask } from "@gps/cron";
import type { ProjectScopes } from "../project-scope.js";
import type { CronStore } from "./store.js";

export interface CronRouteDeps {
  scope: ProjectScopes;
  store: CronStore;
}

interface TaskBody {
  name?: unknown;
  schedule?: unknown;
  prompt?: unknown;
  sessionId?: unknown;
  enabled?: unknown;
}

function parseTaskBody(body: unknown): { input: Omit<CronTask, "id"> } | { error: string } {
  const raw = (body ?? {}) as TaskBody;
  if (typeof raw.name !== "string" || raw.name.trim() === "") return { error: "name is required" };
  if (typeof raw.schedule !== "string" || !isValidSchedule(raw.schedule)) {
    return { error: "a valid 5-field schedule is required" };
  }
  if (typeof raw.prompt !== "string") return { error: "prompt is required" };
  const sessionId = typeof raw.sessionId === "string" && raw.sessionId !== "" ? raw.sessionId : undefined;
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
  return {
    input: {
      name: raw.name.trim(),
      schedule: raw.schedule.trim(),
      prompt: raw.prompt,
      enabled,
      ...(sessionId ? { sessionId } : {}),
    },
  };
}

function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base === "" ? "task" : base;
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function registerCronRoutes(app: FastifyInstance, deps: CronRouteDeps): void {
  const { scope, store } = deps;

  app.get("/api/cron", async (request, reply) =>
    scope.withWorkspace(request, reply, async ({ environment }) => store.list(environment.workspace)),
  );

  app.get("/api/cron/task", async (request, reply) => {
    const { id } = request.query as { id?: string };
    if (!id || !isValidTaskId(id)) return reply.code(400).send({ error: "a valid id is required" });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      const task = await store.read(environment.workspace, id);
      if (task === null) return reply.code(404).send({ error: `task not found: ${id}` });
      return { task };
    });
  });

  app.post("/api/cron/task", async (request, reply) => {
    const parsed = parseTaskBody(request.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      const { tasks } = await store.list(environment.workspace);
      const taken = new Set(tasks.map((task) => task.id));
      const task = await store.write(environment.workspace, {
        id: uniqueId(slug(parsed.input.name), taken),
        ...parsed.input,
      });
      return reply.code(201).send({ task });
    });
  });

  app.put("/api/cron/task", async (request, reply) => {
    const { id } = request.query as { id?: string };
    if (!id || !isValidTaskId(id)) return reply.code(400).send({ error: "a valid id is required" });
    const parsed = parseTaskBody(request.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      const existing = await store.read(environment.workspace, id);
      if (existing === null) return reply.code(404).send({ error: `task not found: ${id}` });
      const task = await store.write(environment.workspace, {
        id,
        ...parsed.input,
        ...(existing.createdAt ? { createdAt: existing.createdAt } : {}),
      });
      return { task };
    });
  });

  app.post("/api/cron/task/delete", async (request, reply) => {
    const { id } = request.query as { id?: string };
    if (!id || !isValidTaskId(id)) return reply.code(400).send({ error: "a valid id is required" });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      await store.remove(environment.workspace, id);
      return { ok: true };
    });
  });

}
```

In `services/transport-service/src/server.ts`, add near the other route registrations (after the subagents route block, before the watch route):

```ts
  // -- Scheduled tasks (per-Project, service-owned) --------------------------
  registerCronRoutes(app, { scope, store: cronStore });
```

with imports at the top:

```ts
import { registerCronRoutes } from "./cron/routes.js";
import { createCronStore } from "./cron/store.js";
```

and after `activeRuns` is declared:

```ts
  const cronStore = createCronStore();
```

(The scheduler itself is added in Task 5, which extends these same deps and imports.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @gps/transport-service`
Expected: PASS (cron routes + all existing service tests).

- [ ] **Step 5: Commit**

```bash
git add services/transport-service/src/cron services/transport-service/src/server.ts services/transport-service/test/cron-routes.test.ts
git commit -m "feat(service): add cron task CRUD routes"
```

---

### Task 5: Service cron scheduler + startup wiring

**Files:**
- Create: `services/transport-service/src/cron/scheduler.ts`
- Modify: `services/transport-service/src/cron/routes.ts` (add the run-now route and the scheduler dep)
- Modify: `services/transport-service/src/server.ts` (create/decorate the scheduler)
- Modify: `services/transport-service/src/index.ts` (start the scheduler in `isMain`)
- Create: `services/transport-service/test/cron-scheduler.test.ts`

**Interfaces:**
- Consumes: `CronStore` (Task 3), `RecordStore`/`RecordDirectory`, `EnvironmentProvider`, `Principal`, `RuntimeAdapter`, `activeRuns`.
- Produces: `CronScheduler` (`tick`, `fire`, `start`, `stop`), `createCronScheduler(deps)`, and the Fastify `cronScheduler` decorator type.

- [ ] **Step 1: Write the failing test**

`services/transport-service/test/cron-scheduler.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  type RuntimeAdapter,
  type SessionState,
  type StateDelta,
  type TransportCommand,
} from "@gps/transport";
import { createInMemoryRecordStore, type RecordStore } from "@gps/record";
import { FsWorkspace } from "@gps/workspace";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";
import { createRecordDirectory } from "../src/directory.js";
import { createCronStore } from "../src/cron/store.js";
import { createCronScheduler } from "../src/cron/scheduler.js";

const PROMPT = "do the thing";

type ServiceApp = Awaited<ReturnType<typeof createTransportService>>;

async function fixture<T>(
  fn: (ctx: { base: string; records: RecordStore; app: ServiceApp; prompts: string[] }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "gps-cron-sched-"));
  const records = createInMemoryRecordStore();
  const prompts: string[] = [];
  const adapter: RuntimeAdapter = {
    runtime: "fake",
    init: async () => {},
    run: async function* (_session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta> {
      const message = commands.find((c) => c.type === "add-message");
      if (message && message.type === "add-message") prompts.push(message.message.content);
      yield {
        type: "add-message",
        message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
      };
    },
    abort: () => {},
  };
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter, workspace: new FsWorkspace(root) }),
    }),
    cors: { origin: true },
    records,
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  try {
    return await fn({ base: `http://127.0.0.1:${addr.port}`, records, app, prompts });
  } finally {
    app.cronScheduler.stop();
    app.server.closeAllConnections?.();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function addTask(base: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base}/api/cron/task?projectId=project-default`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201);
}

test("fire() drives the adapter with the prompt and appends a success log", async () => {
  await fixture(async ({ base, records, app, prompts }) => {
    await records.addSession({
      id: "s1",
      projectId: "project-default",
      agentId: "main",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    await addTask(base, { name: "Run it", schedule: "0 9 * * *", prompt: PROMPT, sessionId: "s1" });
    const { status } = await app.cronScheduler.fire("project-default", "run-it");
    assert.equal(status, "success");
    assert.deepEqual(prompts, [PROMPT]);
    const listing = (await (await fetch(`${base}/api/cron?projectId=project-default`)).json()) as {
      tasks: { lastRun?: { status: string } }[];
    };
    assert.equal(listing.tasks[0]?.lastRun?.status, "success");
  });
});

test("tick() at a non-matching minute is a no-op", async () => {
  await fixture(async ({ base, records, app, prompts }) => {
    await records.addSession({
      id: "s1",
      projectId: "project-default",
      agentId: "main",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    // A wildcard minute matches every minute EXCEPT the test asserts a no-op by
    // targeting a disabled task; enabled=false is the deterministic no-op.
    await addTask(base, { name: "Off", schedule: "* * * * *", prompt: PROMPT, sessionId: "s1", enabled: false });
    await app.cronScheduler.tick();
    assert.deepEqual(prompts, []);
  });
});

test("fire() on an unknown task is an error", async () => {
  await fixture(async ({ app, prompts }) => {
    const { status } = await app.cronScheduler.fire("project-default", "nope");
    assert.equal(status, "error");
    assert.deepEqual(prompts, []);
  });
});

test("a busy target is skipped and logged as skipped-busy", async () => {
  const root = await mkdtemp(join(tmpdir(), "gps-cron-busy-"));
  try {
    const store = createCronStore({ now: () => "2026-09-18T00:00:00.000Z" });
    const workspace = new FsWorkspace(root);
    await store.write(workspace, {
      id: "run-it",
      name: "Run it",
      schedule: "0 9 * * *",
      enabled: true,
      prompt: PROMPT,
      sessionId: "s1",
    });
    const records = createInMemoryRecordStore();
    await records.addSession({
      id: "s1",
      projectId: "project-default",
      agentId: "main",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    const directory = createRecordDirectory({ store: records });
    const principal = await new LocalPrincipalResolver().resolve({ headers: {}, url: "" });
    const prompts: string[] = [];
    const environments = new LocalEnvironmentProvider({
      environmentFor: async () => ({
        adapter: {
          runtime: "fake",
          init: async () => {},
          run: async function* () {
            prompts.push("ran");
          },
          abort: () => {},
        },
        workspace,
      }),
    });
    const scheduler = createCronScheduler({
      store,
      records,
      directory,
      environments,
      principal,
      activeRuns: new Set(["local:s1"]),
    });
    const { status } = await scheduler.fire("project-default", "run-it");
    assert.equal(status, "skipped-busy");
    assert.deepEqual(prompts, []);
    const listing = await store.list(workspace);
    assert.equal(listing.tasks[0]?.lastRun?.status, "skipped-busy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a named session in another project is an error and logs nothing to the transcript", async () => {
  await fixture(async ({ base, records, app, prompts }) => {
    await records.addSession({
      id: "other",
      projectId: "other-project",
      agentId: "main",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    await addTask(base, { name: "Wrong project", schedule: "0 9 * * *", prompt: PROMPT, sessionId: "other" });
    const { status } = await app.cronScheduler.fire("project-default", "wrong-project");
    assert.equal(status, "error");
    assert.deepEqual(prompts, []);
  });
});
```

> The `skipped-busy` lock is exercised deterministically at the store/scheduler
> boundary in the implementation's own review: `activeRuns` is the server-wide
> `Set` created in `server.ts`, and `fire()` adds `${tenant}:${sessionId}` for the
> duration of the run. To assert it directly, export a tiny test hook or build the
> scheduler via `createCronScheduler` with a pre-seeded `activeRuns` set instead of
> going through `createTransportService`; either is acceptable. Keep the four
> assertions above (fire success + log, disabled no-op, missing task error,
> foreign session error) as the minimum.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build -w @gps/cron && npm run test -w @gps/transport-service`
Expected: FAIL — `app.cronScheduler` is undefined / `scheduler.js` missing.

- [ ] **Step 3: Implement the scheduler**

`services/transport-service/src/cron/scheduler.ts`:

```ts
import type { Id, RecordStore } from "@gps/record";
import { matchesSchedule, type CronRunStatus, type CronTask } from "@gps/cron";
import type {
  Environment,
  EnvironmentProvider,
  MessagePart,
  Principal,
  SessionState,
} from "@gps/transport";
import type { RecordDirectory } from "../directory.js";
import type { CronStore } from "./store.js";

declare module "fastify" {
  interface FastifyInstance {
    cronScheduler: CronScheduler;
  }
}

export interface CronScheduler {
  tick(): Promise<void>;
  fire(projectId: Id, id: string): Promise<{ status: CronRunStatus }>;
  start(): void;
  stop(): void;
}

export interface CronSchedulerDeps {
  store: CronStore;
  records: RecordStore;
  directory: RecordDirectory;
  environments: EnvironmentProvider;
  /** The service identity, or `null` when the deployment cannot grant one (hosted mode). */
  principal: Principal | null;
  /** The server's one-in-flight-run lock, shared with the transport route. */
  activeRuns: Set<string>;
  now?: () => Date;
  tickMs?: number;
  onError?: (err: unknown) => void;
  maxMessageChars?: number;
}

function textOf(parts: readonly MessagePart[]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  const { store, records, directory, environments, principal, activeRuns } = deps;
  const now = deps.now ?? (() => new Date());
  const tickMs = deps.tickMs ?? 30_000;
  const onError = deps.onError ?? ((err) => console.error("[transport-service] cron tick failed", err));
  const maxChars = deps.maxMessageChars ?? 4000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  const append = async (environment: Environment, id: string, entry: Parameters<CronStore["appendLog"]>[2]) => {
    try {
      await store.appendLog(environment.workspace, id, entry);
    } catch (err) {
      onError(err);
    }
  };

  const resolveTarget = async (projectId: Id, task: CronTask) => {
    if (task.sessionId) {
      const named = await records.getSession(task.sessionId);
      return named && named.projectId === projectId ? named : null;
    }
    const sessions = await directory.listSessions(projectId);
    const newest = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return newest ?? null;
  };

  const fireWith = async (
    projectId: Id,
    environment: Environment,
    task: CronTask,
  ): Promise<CronRunStatus> => {
    const at = now().toISOString();
    const target = await resolveTarget(projectId, task);
    if (target === null) {
      await append(environment, task.id, { at, status: "error", message: "target session not found" });
      return "error";
    }
    const runKey = `${principal!.tenant}:${target.id}`;
    if (activeRuns.has(runKey)) {
      await append(environment, task.id, { at, status: "skipped-busy", sessionId: target.id });
      return "skipped-busy";
    }
    activeRuns.add(runKey);
    const session: SessionState = {
      sessionId: target.id,
      projectId,
      agentId: target.agentId,
      status: "idle",
      messages: [],
    };
    try {
      let text = "";
      for await (const delta of environment.adapter.run(session, [
        { type: "add-message", message: { id: `cron-${at}-${task.id}`, role: "user", content: task.prompt } },
      ])) {
        if (delta.type === "reconcile") {
          const last = delta.messages[delta.messages.length - 1];
          if (last?.role === "assistant") text = textOf(last.parts);
        } else if (delta.type === "add-message" && delta.message.role === "assistant") {
          text = textOf(delta.message.parts);
        }
      }
      await append(environment, task.id, {
        at,
        status: "success",
        sessionId: target.id,
        ...(text ? { message: text.slice(0, maxChars) } : {}),
      });
      return "success";
    } catch (err) {
      await append(environment, task.id, {
        at,
        status: "error",
        sessionId: target.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return "error";
    } finally {
      activeRuns.delete(runKey);
    }
  };

  return {
    async tick() {
      if (ticking || principal === null) return;
      ticking = true;
      try {
        const at = now();
        for (const project of await directory.listProjects()) {
          const environment = await environments.acquire(principal, project.id);
          const { tasks } = await store.list(environment.workspace);
          for (const task of tasks) {
            if (!task.enabled) continue;
            if (!matchesSchedule(task.schedule, at)) continue;
            await fireWith(project.id, environment, task);
          }
        }
      } catch (err) {
        onError(err);
      } finally {
        ticking = false;
      }
    },
    async fire(projectId, id) {
      if (principal === null) return { status: "error" };
      const environment = await environments.acquire(principal, projectId);
      const task = await store.read(environment.workspace, id);
      if (task === null) return { status: "error" };
      return { status: await fireWith(projectId, environment, task) };
    },
    start() {
      if (principal === null || timer !== null) return;
      timer = setInterval(() => void this.tick(), tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
```

Then extend the routes with the run-now endpoint. In `services/transport-service/src/cron/routes.ts`:

```ts
import type { CronScheduler } from "./scheduler.js";

export interface CronRouteDeps {
  scope: ProjectScopes;
  store: CronStore;
  scheduler: CronScheduler;
}
```

and inside `registerCronRoutes`, after the delete route:

```ts
  app.post("/api/cron/task/run", async (request, reply) => {
    const { id } = request.query as { id?: string };
    if (!id || !isValidTaskId(id)) return reply.code(400).send({ error: "a valid id is required" });
    const { projectId } = await scope.acquire(request);
    return scheduler.fire(projectId, id);
  });
```

Then wire the scheduler into `services/transport-service/src/server.ts`:

```ts
import { createCronScheduler } from "./cron/scheduler.js";
```

```ts
  const cronPrincipal = await backend.principal
    .resolve({ headers: {}, url: "" })
    .catch(() => null);
  const cronScheduler = createCronScheduler({
    store: cronStore,
    records,
    directory,
    environments: backend.environments,
    principal: cronPrincipal,
    activeRuns,
  });
  app.decorate("cronScheduler", cronScheduler);
  app.addHook("onClose", async () => {
    cronScheduler.stop();
  });
  registerCronRoutes(app, { scope, store: cronStore, scheduler: cronScheduler });
```

Replace the Task 4 `registerCronRoutes(app, { scope, store: cronStore })` call with the one above.

Then in `services/transport-service/src/index.ts`, `isMain` block:

```ts
  const app = await createServer(backend);
  app.cronScheduler.start();
  await app.listen({ port, host });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @gps/transport-service`
Expected: PASS.

- [ ] **Step 5: Typecheck the service (the real gate rebuilds it)**

Run: `npm run build`
Expected: exits 0 (this includes `typecheck:tests`).

- [ ] **Step 6: Commit**

```bash
git add services/transport-service/src/cron/scheduler.ts services/transport-service/src/index.ts services/transport-service/test/cron-scheduler.test.ts
git commit -m "feat(service): schedule due cron tasks through adapter.run"
```

---

### Task 6: Web cron proxy route + transport-client hooks

**Files:**
- Modify: `packages/transport-client/package.json` (add `@gps/cron`)
- Modify: `packages/transport-client/tsconfig.json` (add the `../cron` reference)
- Create: `packages/transport-client/src/cron.ts`
- Modify: `packages/transport-client/src/index.ts` (export the cron module)
- Create: `apps/web/app/api/cron/[[...path]]/route.ts`
- Create: `packages/transport-client/test/cron.test.ts`

**Interfaces:**
- Consumes: `@gps/cron`; `proxyToService` from `@/lib/service-proxy`.
- Produces (from `@gps/transport-client`): `DEFAULT_CRON_API`, `useCronTasks`, `fetchCronTasks`, `fetchCronTask`, `createCronTask`, `saveCronTask`, `deleteCronTask`, `runCronTask`, and re-exports `CRON_DIR`, `cronLogPath`, `cronTaskPath`, `describeSchedule`, `isCronTaskPath`, `isValidSchedule`, `presetToExpression`, `SCHEDULE_PRESETS`, `taskIdFromPath`, types `CronTask`, `CronTaskSummary`, `CronLogEntry`, `CronRunStatus`, `CronTaskInput`, `CronInvalidFile`, `SchedulePreset`.

- [ ] **Step 1: Add the dependency**

In `packages/transport-client/package.json` `dependencies`, add:

```json
"@gps/cron": "*",
```

In `packages/transport-client/tsconfig.json` `references`, add:

```json
{ "path": "../cron" }
```

- [ ] **Step 2: Write the failing test**

`packages/transport-client/test/cron.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCronTaskPath, taskIdFromPath } from "../src/cron.js";

test("the client re-exports the pure task-path predicate", () => {
  assert.equal(isCronTaskPath(".gps/cron/x.md"), true);
  assert.equal(taskIdFromPath(".gps/cron/x.md"), "x");
  assert.equal(isCronTaskPath(".gps/cron/x.log.md"), false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build -w @gps/cron && npm run test -w @gps/transport-client`
Expected: FAIL — `Cannot find module '../src/cron.js'`.

- [ ] **Step 4: Implement the hooks and the proxy**

`packages/transport-client/src/cron.ts`:

```ts
"use client";

import { useEffect, useState } from "react";
import {
  CRON_DIR,
  SCHEDULE_PRESETS,
  cronLogPath,
  cronTaskPath,
  describeSchedule,
  isCronTaskPath,
  isValidSchedule,
  presetToExpression,
  taskIdFromPath,
  type CronLogEntry,
  type CronRunStatus,
  type CronTask,
  type SchedulePreset,
} from "@gps/cron";

export {
  CRON_DIR,
  SCHEDULE_PRESETS,
  cronLogPath,
  cronTaskPath,
  describeSchedule,
  isCronTaskPath,
  isValidSchedule,
  presetToExpression,
  taskIdFromPath,
};
export type { CronLogEntry, CronRunStatus, CronTask, SchedulePreset };

export const DEFAULT_CRON_API = "/api/cron";

export interface CronTaskSummary extends CronTask {
  path: string;
  lastRun?: CronLogEntry;
}

export interface CronInvalidFile {
  path: string;
  error: string;
}

export interface CronTaskInput {
  name: string;
  schedule: string;
  prompt: string;
  sessionId?: string;
  enabled?: boolean;
}

export interface UseCronTasksOptions {
  api?: string;
  projectId: string | null;
  enabled: boolean;
  intervalMs?: number;
}

export interface CronTasksState {
  tasks: CronTaskSummary[];
  invalid: CronInvalidFile[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

async function requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchCronTasks(
  api: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<{ tasks: CronTaskSummary[]; invalid: CronInvalidFile[] }> {
  const res = await fetch(`${api}?${new URLSearchParams({ projectId })}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`cron ${res.status}`);
  const body = (await res.json()) as { tasks?: CronTaskSummary[]; invalid?: CronInvalidFile[] };
  return { tasks: body.tasks ?? [], invalid: body.invalid ?? [] };
}

export function useCronTasks(options: UseCronTasksOptions): CronTasksState {
  const { api = DEFAULT_CRON_API, projectId, enabled, intervalMs = 2000 } = options;
  const [tasks, setTasks] = useState<CronTaskSummary[]>([]);
  const [invalid, setInvalid] = useState<CronInvalidFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled || projectId === null) return;
    let active = true;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const next = await fetchCronTasks(api, projectId, controller.signal);
        if (!active) return;
        setTasks(next.tasks);
        setInvalid(next.invalid);
        setError(null);
      } catch (err) {
        if (active && !controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [api, projectId, enabled, intervalMs, revision]);

  return { tasks, invalid, loading, error, refresh: () => setRevision((n) => n + 1) };
}

export async function fetchCronTask(api: string, projectId: string, id: string): Promise<CronTask> {
  const body = await requestJson<{ task: CronTask }>(
    `${api}/task?${new URLSearchParams({ projectId, id })}`,
    "GET",
  );
  return body.task;
}

export async function createCronTask(
  api: string,
  projectId: string,
  input: CronTaskInput,
): Promise<CronTask> {
  const body = await requestJson<{ task: CronTask }>(
    `${api}/task?${new URLSearchParams({ projectId })}`,
    "POST",
    input,
  );
  return body.task;
}

export async function saveCronTask(api: string, projectId: string, task: CronTask): Promise<CronTask> {
  const body = await requestJson<{ task: CronTask }>(
    `${api}/task?${new URLSearchParams({ projectId, id: task.id })}`,
    "PUT",
    task,
  );
  return body.task;
}

export async function deleteCronTask(api: string, projectId: string, id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`${api}/task/delete?${new URLSearchParams({ projectId, id })}`, "POST");
}

export async function runCronTask(api: string, projectId: string, id: string): Promise<CronRunStatus> {
  const body = await requestJson<{ status: CronRunStatus }>(
    `${api}/task/run?${new URLSearchParams({ projectId, id })}`,
    "POST",
  );
  return body.status;
}
```

Append to `packages/transport-client/src/index.ts`:

```ts
export {
  CRON_DIR,
  DEFAULT_CRON_API,
  SCHEDULE_PRESETS,
  createCronTask,
  cronLogPath,
  cronTaskPath,
  deleteCronTask,
  describeSchedule,
  fetchCronTask,
  fetchCronTasks,
  isCronTaskPath,
  isValidSchedule,
  presetToExpression,
  runCronTask,
  saveCronTask,
  taskIdFromPath,
  useCronTasks,
  type CronInvalidFile,
  type CronLogEntry,
  type CronRunStatus,
  type CronTask,
  type CronTaskInput,
  type CronTaskSummary,
  type CronTasksState,
  type SchedulePreset,
  type UseCronTasksOptions,
} from "./cron.js";
```

`apps/web/app/api/cron/[[...path]]/route.ts`:

```ts
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(
  request: Request,
  path: string[] | undefined,
  method: "GET" | "POST" | "PUT",
): Promise<NextResponse> {
  const suffix = path && path.length > 0 ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const { search } = new URL(request.url);
  const body = method === "GET" ? "" : await request.text();
  return proxyToService(request, {
    path: `/api/cron${suffix}${search}`,
    method,
    headers: {
      accept: "application/json",
      ...(body !== "" ? { "content-type": "application/json" } : {}),
    },
    ...(body !== "" ? { body } : {}),
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  return forward(request, path, "GET");
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  return forward(request, path, "POST");
}

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  return forward(request, path, "PUT");
}
```

- [ ] **Step 5: Run the test and build**

Run: `npm run test -w @gps/transport-client && npm run build -w @gps/cron && npm run build -w @gps/transport-client`
Expected: PASS and both builds exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/transport-client apps/web/app/api/cron
git commit -m "feat(transport-client): poll and edit cron tasks over the web proxy"
```

---

### Task 7: CronView list + New-task dialog

**Files:**
- Modify: `apps/web/components/studio/cron-view.tsx`
- Create: `apps/web/components/studio/cron-new-task-dialog.tsx`

**Interfaces:**
- Consumes: `useCronTasks`, `createCronTask`, `describeSchedule`, `cronTaskPath` from `@gps/transport-client`; `SidebarSection`/`ModuleEmptyState`; `useStudioStore` (`projectId`, `openFile`, `rightSections.cron`, `rightHeights.cron`, `toggleRightSection`).
- Produces: the list UI and dialog used by the web test.

- [ ] **Step 1: Implement the New-task dialog**

`apps/web/components/studio/cron-new-task-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { createCronTask, SCHEDULE_PRESETS, presetToExpression, type SchedulePreset } from "@gps/transport-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function NewCronTaskDialog({
  open,
  onOpenChange,
  projectId,
  sessionId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  sessionId: string | null;
  onCreated: (task: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<SchedulePreset>("daily");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const task = await createCronTask("/api/cron", projectId, {
        name: name.trim() || "Scheduled task",
        schedule: presetToExpression(preset, { hour, minute }),
        prompt,
        ...(sessionId ? { sessionId } : {}),
        enabled: true,
      });
      onCreated({ id: task.id, name: task.name });
      onOpenChange(false);
      setName("");
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New scheduled task</DialogTitle>
          <DialogDescription>Runs the prompt on a Session at the schedule below.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            Name
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily digest" />
          </label>
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs">
              Repeat
              <select
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                value={preset}
                onChange={(event) => setPreset(event.target.value as SchedulePreset)}
              >
                {SCHEDULE_PRESETS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Hour
              <Input
                type="number"
                min={0}
                max={23}
                className="w-20"
                value={hour}
                onChange={(event) => setHour(Number(event.target.value))}
                disabled={preset === "hourly"}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Minute
              <Input
                type="number"
                min={0}
                max={59}
                className="w-20"
                value={minute}
                onChange={(event) => setMinute(Number(event.target.value))}
                disabled={preset === "hourly"}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs">
            Prompt
            <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} />
          </label>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Implement the CronView list**

Replace `apps/web/components/studio/cron-view.tsx` with:

```tsx
"use client";

import { useState } from "react";
import { CalendarClock, Plus } from "lucide-react";
import { cronTaskPath, describeSchedule, useCronTasks } from "@gps/transport-client";
import { Button } from "@/components/ui/button";
import { ModuleEmptyState, SidebarSection } from "./sidebar-section";
import { NewCronTaskDialog } from "./cron-new-task-dialog";
import { useStudioStore } from "@/store/studio-store";

const STATUS_CLASS: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "skipped-busy": "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  error: "bg-destructive/15 text-destructive",
};

export function CronView() {
  const open = useStudioStore((s) => s.rightSections.cron);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.cron);
  const projectId = useStudioStore((s) => s.projectId);
  const activeSessionId = useStudioStore((s) => s.activeSessionId);
  const openFile = useStudioStore((s) => s.openFile);
  const [dialogOpen, setDialogOpen] = useState(false);

  const enabled = open && projectId !== null;
  const { tasks, invalid, error, refresh } = useCronTasks({ projectId, enabled });

  return (
    <SidebarSection
      section="cron"
      title="Cron"
      icon={CalendarClock}
      open={open}
      onOpenChange={() => toggleRightSection("cron")}
      className={open ? "shrink-0" : undefined}
      style={open ? { height } : undefined}
      actions={
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6"
          aria-label="New scheduled task"
          disabled={projectId === null}
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="size-3.5" />
        </Button>
      }
    >
      {tasks.length === 0 && invalid.length === 0 ? (
        <ModuleEmptyState
          icon={CalendarClock}
          message="No scheduled tasks."
          hint="Scheduled runs will appear here."
        />
      ) : (
        <ul className="flex h-full flex-col gap-1 overflow-auto p-2" aria-label="Scheduled tasks">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onDoubleClick={() => openFile(task.path, task.name)}
                className="border-border/60 hover:bg-accent/50 flex w-full flex-col gap-1 rounded-md border px-2 py-1.5 text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium" title={task.name}>
                    {task.name}
                  </span>
                  {task.lastRun ? (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[task.lastRun.status] ?? ""}`}
                    >
                      {task.lastRun.status}
                    </span>
                  ) : null}
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
                  <span>{describeSchedule(task.schedule)}</span>
                  <span className="ml-auto">{task.enabled ? "Enabled" : "Disabled"}</span>
                </div>
              </button>
            </li>
          ))}
          {invalid.map((file) => (
            <li key={file.path} className="text-destructive px-2 text-[10px]">
              Unreadable task: {file.path}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="text-destructive px-2 pb-1 text-[10px]">{error}</p> : null}
      {projectId !== null ? (
        <NewCronTaskDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          projectId={projectId}
          sessionId={activeSessionId}
          onCreated={(task) => {
            refresh();
            openFile(cronTaskPath(task.id), task.name);
          }}
        />
      ) : null}
    </SidebarSection>
  );
}
```

- [ ] **Step 3: Typecheck the web app**

Run: `npm run typecheck -w @gps/web`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/studio/cron-view.tsx apps/web/components/studio/cron-new-task-dialog.tsx
git commit -m "feat(web): list scheduled tasks and create them from the Cron panel"
```

---

### Task 8: CronTaskRenderer + tab routing

**Files:**
- Create: `apps/web/components/studio/renderers/CronTaskRenderer.tsx`
- Modify: `apps/web/components/studio/file-preview-pane.tsx` (route cron paths)
- Modify: `apps/web/components/studio/file-icons.tsx` (cron icon)
- Modify: `apps/web/components/studio/tab-strip.tsx` (cron tab icon)
- Create: `apps/web/test/cron-panel.test.mjs`

**Interfaces:**
- Consumes: `fetchCronTask`, `saveCronTask`, `deleteCronTask`, `runCronTask`, `taskIdFromPath`, `cronLogPath`, `isCronTaskPath`, `describeSchedule` from `@gps/transport-client`; `DEFAULT_CRON_API`.
- Produces: the tab renderer and end-to-end panel behavior.

- [ ] **Step 1: Add the cron icon**

In `apps/web/components/studio/file-icons.tsx`, import `CalendarClock` from `lucide-react` and add:

```tsx
export function cronIcon(): ReactNode {
  return <CalendarClock className="size-3.5 text-orange-500" />;
}
```

- [ ] **Step 2: Route cron paths in the preview pane**

In `apps/web/components/studio/file-preview-pane.tsx`:

Import:

```ts
import { isCronTaskPath } from "@gps/transport-client";
import { CronTaskRenderer } from "./renderers/CronTaskRenderer";
```

Change the body dispatch to check the path first:

```tsx
<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
  {isCronTaskPath(path) ? (
    <CronTaskRenderer path={path} />
  ) : kind === "pdf" ? (
    <PdfRenderer url={fileUrl} />
  ) : kind === "molecule" ? (
    <MoleculeRenderer url={fileUrl} fileName={name} />
  ) : (
    <TextPreview path={path} name={name} />
  )}
</div>
```

- [ ] **Step 3: Use the cron icon in the tab strip**

In `apps/web/components/studio/tab-strip.tsx`:

```ts
import { cronIcon, fileIcon } from "./file-icons";
import { isCronTaskPath } from "@gps/transport-client";
```

and replace the icon call with:

```tsx
{isCronTaskPath(tab.path) ? cronIcon() : fileIcon(kindFor(tab.name))}
```

- [ ] **Step 4: Implement the renderer**

`apps/web/components/studio/renderers/CronTaskRenderer.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, Trash2 } from "lucide-react";
import {
  DEFAULT_CRON_API,
  cronLogPath,
  deleteCronTask,
  describeSchedule,
  fetchCronTask,
  runCronTask,
  saveCronTask,
  taskIdFromPath,
  type CronTask,
} from "@gps/transport-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useStudioStore } from "@/store/studio-store";

export function CronTaskRenderer({ path }: { path: string }) {
  const id = taskIdFromPath(path) ?? "";
  const projectId = useStudioStore((s) => s.projectId);
  const sessions = useStudioStore((s) => s.sessions);
  const openFile = useStudioStore((s) => s.openFile);
  const closeTab = useStudioStore((s) => s.closeTab);

  const [task, setTask] = useState<CronTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (projectId === null || id === "") {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    fetchCronTask(DEFAULT_CRON_API, projectId, id)
      .then((next) => {
        if (active) setTask(next);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, id]);

  const patch = (next: Partial<CronTask>) => setTask((prev) => (prev ? { ...prev, ...next } : prev));

  const onSave = async () => {
    if (projectId === null || task === null) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await saveCronTask(DEFAULT_CRON_API, projectId, task);
      setTask(saved);
      setStatus("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRun = async () => {
    if (projectId === null || task === null) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setStatus((await runCronTask(DEFAULT_CRON_API, projectId, task.id)) === "success" ? "Ran successfully" : "Run did not complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (projectId === null || task === null) return;
    if (!window.confirm(`Delete “${task.name}”?`)) return;
    setBusy(true);
    try {
      await deleteCronTask(DEFAULT_CRON_API, projectId, task.id);
      closeTab(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center p-4">
        <Loader2 className="text-muted-foreground size-4 animate-spin" />
      </div>
    );
  }
  if (task === null) {
    return <p className="text-destructive p-3 text-xs">{error ?? "Task not found."}</p>;
  }

  return (
    <div className="flex flex-col gap-3 overflow-auto p-3 text-xs">
      <label className="flex flex-col gap-1">
        Name
        <Input value={task.name} onChange={(event) => patch({ name: event.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        Schedule
        <Input value={task.schedule} onChange={(event) => patch({ schedule: event.target.value })} />
        <span className="text-muted-foreground text-[10px]">{describeSchedule(task.schedule)}</span>
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={task.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />
        Enabled
      </label>
      <label className="flex flex-col gap-1">
        Target session
        <select
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={task.sessionId ?? ""}
          onChange={(event) => patch({ sessionId: event.target.value || undefined })}
        >
          <option value="">Most recent session</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title ?? session.id}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Prompt
        <Textarea value={task.prompt} onChange={(event) => patch({ prompt: event.target.value })} rows={8} />
      </label>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void onSave()} disabled={busy}>
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={() => void onRun()} disabled={busy}>
          <Play className="size-3.5" />
          Run now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openFile(cronLogPath(task.id), `${task.id}.log.md`)}
        >
          Open log
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive ml-auto" onClick={() => void onDelete()} disabled={busy}>
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      </div>
      {status ? <p className="text-muted-foreground">{status}</p> : null}
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 5: Write the web regression test**

`apps/web/test/cron-panel.test.mjs`:

```js
/**
 * Regression: the Cron module lists scheduled tasks, a double click opens the
 * task tab with its form renderer, and Save PUTs the task. Prereq:
 * `npm run build -w @gps/transport-client`. Chromium-gated.
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

const TASKS = {
  tasks: [
    {
      id: "daily-digest",
      name: "Daily digest",
      schedule: "0 9 * * *",
      enabled: true,
      prompt: "Summarize.",
      path: ".gps/cron/daily-digest.md",
    },
  ],
  invalid: [],
};

test(
  "the Cron panel lists tasks and opens the editor tab",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip("no Chromium found");
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
      await page.route("**/api/cron*", (route) => {
        const request = route.request();
        if (request.method() === "PUT") puts.push(request.url());
        if (request.url().includes("/task?")) {
          return route.fulfill({
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ task: TASKS.tasks[0] }),
          });
        }
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(TASKS),
        });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      const cron = page.locator('[data-section="cron"]');
      await cron.getByRole("button", { name: "Cron" }).click();
      const row = cron.getByText("Daily digest");
      await row.waitFor({ timeout: 10_000 });
      await cron.getByText("Every day at 09:00").waitFor({ timeout: 10_000 });

      await row.dblclick();
      const tab = page.getByRole("tab", { name: /Daily digest/ });
      await tab.waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Save" }).click();
      await page.waitForTimeout(500);
      assert.ok(puts.length >= 1, "Save PUTs the task");
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
```

- [ ] **Step 6: Run the web test**

Run: `npm run build -w @gps/cron && npm run build -w @gps/transport-client && npm run test:e2e -w @gps/web`
Expected: PASS (or SKIP without Chromium). The suite runs its own `next dev` on a private build dir.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/studio apps/web/test/cron-panel.test.mjs
git commit -m "feat(web): edit scheduled tasks in a file tab"
```

---

### Task 9: dsh child cron plugin

**Files:**
- Modify: `packages/transport-dsh/package.json` (add `@gps/cron`)
- Modify: `packages/transport-dsh/tsconfig.json` (add the `../cron` reference)
- Create: `packages/transport-dsh/src/cron-plugin.ts`
- Create: `packages/transport-dsh/test/cron-plugin.test.ts`

**Interfaces:**
- Consumes: `@gps/cron` (codec/schedule), `node:fs`.
- Produces: `name`, `inject`, `apply(ctx, config)`, `CronPluginConfig`, tool/command/prompt definitions; the file `dist/cron-plugin.js` mounted by Task 10.

- [ ] **Step 1: Add the dependency**

In `packages/transport-dsh/package.json` `dependencies`, add:

```json
"@gps/cron": "*",
```

In `packages/transport-dsh/tsconfig.json` `references`, add:

```json
{ "path": "../cron" }
```

- [ ] **Step 2: Write the failing test**

`packages/transport-dsh/test/cron-plugin.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply,
  type CronCommandDefinition,
  type CronHost,
  type CronPromptSection,
  type CronToolDefinition,
} from "../src/cron-plugin.js";
import { parseTaskDoc } from "@gps/cron";

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };

function fakeHost(): {
  ctx: CronHost;
  commands: () => CronCommandDefinition[];
  tools: () => CronToolDefinition[];
  sections: () => CronPromptSection[];
} {
  const commands: CronCommandDefinition[] = [];
  const tools: CronToolDefinition[] = [];
  const sections: CronPromptSection[] = [];
  const ctx: CronHost = {
    commands: { register: (definition) => { commands.push(definition); return () => {}; } },
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
    systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
    effect: (body) => { body(); },
  };
  return { ctx, commands: () => commands, tools: () => tools, sections: () => sections };
}

function tool(host: ReturnType<typeof fakeHost>, name: string): CronToolDefinition {
  const found = host.tools().find((entry) => entry.name === name);
  assert.ok(found, `tool ${name} is registered`);
  return found;
}

test("a project config registers the four tools, /cron and the prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cron-"));
  try {
    const host = fakeHost();
    apply(host.ctx, { project: META, root });
    assert.deepEqual(host.tools().map((t) => t.name).sort(), [
      "schedule_create",
      "schedule_delete",
      "schedule_list",
      "schedule_set_enabled",
    ]);
    assert.deepEqual(host.commands().map((c) => c.name), ["cron"]);
    assert.deepEqual(host.sections().map((s) => s.name), ["gps-cron"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule_create writes a parseable task file; list and delete see it", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cron-"));
  try {
    const host = fakeHost();
    apply(host.ctx, { project: META, root });
    const create = tool(host, "schedule_create");
    const created = await create.execute(
      { name: "Daily digest", schedule: "0 9 * * *", prompt: "Summarize." },
      {},
    );
    assert.match(String(created), /daily-digest/);
    const path = join(root, ".gps", "cron", "daily-digest.md");
    assert.ok(existsSync(path));
    const parsed = parseTaskDoc("daily-digest", readFileSync(path, "utf8"));
    assert.ok("task" in parsed);
    assert.equal(parsed.task.prompt, "Summarize.");

    assert.match(await tool(host, "schedule_list").execute({}, {}), /Daily digest/);
    await tool(host, "schedule_delete").execute({ id: "daily-digest" }, {});
    assert.equal(existsSync(path), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule_create rejects an invalid schedule", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cron-"));
  try {
    const host = fakeHost();
    apply(host.ctx, { project: META, root });
    const outcome = await tool(host, "schedule_create").execute(
      { name: "x", schedule: "nope", prompt: "y" },
      {},
    );
    assert.match(String(outcome), /schedule/i);
    assert.equal(existsSync(join(root, ".gps")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build -w @gps/cron && npm run test -w @gps/transport-dsh`
Expected: FAIL — `Cannot find module '../src/cron-plugin.js'`.

- [ ] **Step 4: Implement the plugin**

`packages/transport-dsh/src/cron-plugin.ts`:

```ts
/**
 * The CHILD-side cron plugin: a cordis plugin loaded into the dsh harness child
 * by a per-launch profile patch. It gives the agent the scheduling tools
 * (`schedule_create`/`list`/`delete`/`set_enabled`), a `/cron` command and one
 * system-prompt section. It only WRITES task files (the Project Workspace is the
 * child's cwd); the transport-service owns the scheduler and the run log.
 *
 * Like `bridge-plugin.ts`/`project-plugin.ts` it imports NOTHING from
 * `@deepseek-ai/*`, never writes to stdout, and fails soft.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CRON_DIR,
  cronLogPath,
  cronTaskPath,
  isValidSchedule,
  parseTaskDoc,
  serializeTaskDoc,
  taskIdFromPath,
  type CronTask,
} from "@gps/cron";

export const name = "gps-cron";
export const inject = ["commands", "tools", "systemPrompt"];

export interface CronPluginConfig {
  /** The record-owned Project identity; absent → the plugin is inert. */
  project?: { id: string; name: string; createdAt: string };
  /** The Project Workspace root; defaults to the child's cwd. */
  root?: string;
}

export interface CronCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string };
  readonly handler: (invocation: { readonly agent: unknown; readonly rawInput: string; readonly signal: AbortSignal }) =>
    | { kind: "success"; text?: string }
    | { kind: "error"; text: string }
    | Promise<{ kind: "success"; text?: string } | { kind: "error"; text: string }>;
}

export interface CronToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    readonly render: (args: unknown, value: unknown) => unknown;
  };
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

export interface CronPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

export interface CronHost {
  readonly commands?: { register(definition: CronCommandDefinition): () => void };
  readonly tools?: { register(definition: CronToolDefinition): () => void };
  readonly systemPrompt?: { section(section: CronPromptSection): () => void };
  effect?(body: () => () => void, label?: string): unknown;
}

function warn(message: string, detail: unknown): void {
  const text = detail instanceof Error ? detail.message : String(detail);
  process.stderr.write(`[dsh cron] ${message}: ${text}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function textOutput(): CronToolDefinition["output"] {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: String(value) }],
  };
}

function slug(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base === "" ? "task" : base;
}

function readTaskIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => taskIdFromPath(`${CRON_DIR}/${file}`))
    .filter((id): id is string => id !== null);
}

function listTasks(root: string): CronTask[] {
  const dir = join(root, CRON_DIR);
  const tasks: CronTask[] = [];
  for (const id of readTaskIds(dir)) {
    const parsed = parseTaskDoc(id, readFileSync(join(dir, `${id}.md`), "utf8"));
    if ("task" in parsed) tasks.push(parsed.task);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export function apply(ctx: CronHost, config: CronPluginConfig | undefined): void {
  const project = config?.project;
  if (!project) return;
  const root = config.root ?? process.cwd();
  const dir = join(root, CRON_DIR);

  const createTool: CronToolDefinition = {
    name: "schedule_create",
    description:
      "创建一个定时任务：到点后由服务向目标会话发送 prompt 并执行一次。schedule 为 5 字段 cron 表达式（分 时 日 月 周，如 `0 9 * * *` 表示每天 09:00）。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务名称。" },
        schedule: { type: "string", description: "5 字段 cron 表达式，如 `0 9 * * *`。" },
        prompt: { type: "string", description: "到点后发送给 agent 的指令。" },
        sessionId: { type: "string", description: "目标会话 id；省略则使用本项目最近活跃的会话。" },
        enabled: { type: "boolean", description: "是否启用，默认 true。" },
      },
      required: ["name", "schedule", "prompt"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const input = asRecord(args);
      const taskName = input?.["name"];
      const schedule = input?.["schedule"];
      const prompt = input?.["prompt"];
      if (typeof taskName !== "string" || taskName.trim() === "") return "参数无效：需要非空 name。";
      if (typeof schedule !== "string" || !isValidSchedule(schedule)) {
        return `无效的 schedule「${String(schedule)}」：需要 5 字段 cron 表达式，如 \`0 9 * * *\`。`;
      }
      if (typeof prompt !== "string" || prompt.trim() === "") return "参数无效：需要非空 prompt。";
      const sessionId = input?.["sessionId"];
      const enabled = input?.["enabled"];
      const existing = readTaskIds(dir);
      let id = slug(taskName);
      if (existing.includes(id)) {
        let suffix = 2;
        while (existing.includes(`${id}-${suffix}`)) suffix += 1;
        id = `${id}-${suffix}`;
      }
      const task: CronTask = {
        id,
        name: taskName.trim(),
        schedule: schedule.trim(),
        enabled: typeof enabled === "boolean" ? enabled : true,
        prompt,
        ...(typeof sessionId === "string" && sessionId !== "" ? { sessionId } : {}),
        createdAt: new Date().toISOString(),
      };
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(root, cronTaskPath(id)), serializeTaskDoc(task));
        return `已创建定时任务「${task.name}」（id: ${id}，schedule: ${task.schedule}）。`;
      } catch (err) {
        warn("schedule_create failed", err);
        return "写入任务文件失败。";
      }
    },
  };

  const listTool: CronToolDefinition = {
    name: "schedule_list",
    description: "列出本项目已有的定时任务。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: textOutput(),
    async execute() {
      try {
        const tasks = listTasks(root);
        if (tasks.length === 0) return "本项目还没有定时任务。";
        return tasks
          .map((task) => `- ${task.name}（id: ${task.id}，${task.schedule}，${task.enabled ? "启用" : "停用"}）`)
          .join("\n");
      } catch (err) {
        warn("schedule_list failed", err);
        return "读取任务列表失败。";
      }
    },
  };

  const deleteTool: CronToolDefinition = {
    name: "schedule_delete",
    description: "删除一个定时任务。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id。" } },
      required: ["id"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const id = asRecord(args)?.["id"];
      if (typeof id !== "string" || id === "") return "参数无效：需要 { id: string }。";
      try {
        rmSync(join(root, cronTaskPath(id)), { force: true });
        rmSync(join(root, cronLogPath(id)), { force: true });
        return `已删除任务 ${id}。`;
      } catch (err) {
        warn("schedule_delete failed", err);
        return "删除任务失败。";
      }
    },
  };

  const setEnabledTool: CronToolDefinition = {
    name: "schedule_set_enabled",
    description: "启用或停用一个定时任务。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id。" },
        enabled: { type: "boolean", description: "true 启用，false 停用。" },
      },
      required: ["id", "enabled"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const input = asRecord(args);
      const id = input?.["id"];
      const enabled = input?.["enabled"];
      if (typeof id !== "string" || id === "" || typeof enabled !== "boolean") {
        return "参数无效：需要 { id: string, enabled: boolean }。";
      }
      try {
        const path = join(root, cronTaskPath(id));
        if (!existsSync(path)) return `任务 ${id} 不存在。`;
        const parsed = parseTaskDoc(id, readFileSync(path, "utf8"));
        if ("error" in parsed) return `任务 ${id} 无法解析：${parsed.error}`;
        writeFileSync(path, serializeTaskDoc({ ...parsed.task, enabled }));
        return `任务 ${id} 已${enabled ? "启用" : "停用"}。`;
      } catch (err) {
        warn("schedule_set_enabled failed", err);
        return "更新任务失败。";
      }
    },
  };

  const command: CronCommandDefinition = {
    name: "cron",
    description: "列出本项目的定时任务",
    handler: () => {
      const tasks = listTasks(root);
      if (tasks.length === 0) return { kind: "success", text: "本项目还没有定时任务。" };
      return {
        kind: "success",
        text: tasks.map((task) => `- ${task.name}（${task.schedule}）`).join("\n"),
      };
    },
  };

  const prompt: CronPromptSection = {
    name: "gps-cron",
    order: 460,
    text: [
      "本项目支持定时任务：到点后由服务向目标会话发送一条 prompt 并执行一次，结果记录在会话中，同时写入任务日志文件。",
      `任务文件位于工作区 \`${CRON_DIR}/<id>.md\`（frontmatter 含 name/schedule/enabled/sessionId，正文是 prompt）。`,
      "用 schedule_create 创建、schedule_list 查看、schedule_delete 删除、schedule_set_enabled 启停；也可以用 /cron 查看。",
      "schedule 是 5 字段 cron（分 时 日 月 周），如 `0 9 * * *`（每天 09:00）、`0 * * * *`（每小时）；省略 sessionId 时默认使用本项目最近活跃的会话。",
      "只应在用户明确要求定期执行某事时创建任务，不要主动安排。",
    ].join("\n"),
  };

  const register = (): (() => void) => {
    const disposers: (() => void)[] = [];
    const tryRegister = (label: string, registerOne: () => () => void): void => {
      try {
        disposers.push(registerOne());
      } catch (err) {
        warn(label, err);
      }
    };
    if (ctx.commands) tryRegister("command registration failed", () => ctx.commands!.register(command));
    if (ctx.tools) tryRegister("schedule_create registration failed", () => ctx.tools!.register(createTool));
    if (ctx.tools) tryRegister("schedule_list registration failed", () => ctx.tools!.register(listTool));
    if (ctx.tools) tryRegister("schedule_delete registration failed", () => ctx.tools!.register(deleteTool));
    if (ctx.tools) tryRegister("schedule_set_enabled registration failed", () => ctx.tools!.register(setEnabledTool));
    if (ctx.systemPrompt) tryRegister("prompt section registration failed", () => ctx.systemPrompt!.section(prompt));
    return () => {
      for (const disposer of disposers.reverse()) {
        try {
          disposer();
        } catch (err) {
          warn("dispose failed", err);
        }
      }
    };
  };

  try {
    if (ctx.effect) ctx.effect(register, "gps-cron");
    else register();
  } catch (err) {
    warn("cron plugin disabled", err);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @gps/transport-dsh`
Expected: PASS (cron plugin + all existing dsh tests).

- [ ] **Step 6: Commit**

```bash
git add packages/transport-dsh/package.json packages/transport-dsh/src/cron-plugin.ts packages/transport-dsh/test/cron-plugin.test.ts
git commit -m "feat(dsh): ship a child cron plugin with scheduling tools"
```

---

### Task 10: dsh adapter launch patch wiring

**Files:**
- Modify: `packages/transport-dsh/src/bridge.ts` (`writeCronPatch`)
- Modify: `packages/transport-dsh/src/adapter.ts` (`cronPluginPath` option + patch injection)
- Modify: `packages/transport-dsh/src/commands.ts` (`/cron` fallback descriptor)
- Modify: `packages/transport-dsh/test/project-launch.test.ts` (patch count 2 → 3)
- Create: `packages/transport-dsh/test/cron-launch.test.ts`

**Interfaces:**
- Consumes: `cron-plugin.ts` (Task 9).
- Produces: the third `--patch` on a Project's child launch.

- [ ] **Step 1: Write the failing patch test**

`packages/transport-dsh/test/cron-launch.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCronPatch } from "../src/bridge.js";

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };

test("writeCronPatch inserts the cron plugin by file URL with a JSON config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-cron-launch-"));
  try {
    const file = await writeCronPatch({
      dir,
      pluginPath: "/opt/ss/cron-plugin.js",
      config: { project: META, root: "/w/project" },
    });
    const patch = await readFile(file, "utf8");
    assert.match(patch, /- insert:/);
    assert.match(patch, /id: gps-cron/);
    assert.match(patch, /cron-plugin\.js/);
    assert.match(patch, /"root":"\/w\/project"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @gps/transport-dsh`
Expected: FAIL — `writeCronPatch` is not exported.

- [ ] **Step 3: Add the patch writer**

In `packages/transport-dsh/src/bridge.ts`, after `writeProjectPatch`:

```ts
/** The config the child-side cron plugin (`cron-plugin.ts`) reads. */
export interface CronPluginLaunchConfig {
  project: { id: string; name: string; createdAt: string };
  /** The Project Workspace root (the child's cwd) the task files live in. */
  root: string;
}

/**
 * Write the launch patch that inserts the CRON plugin into the child's profile,
 * and return its path (for `--patch`). Same shape as the bridge/project patches:
 * a `file:` URL name and one JSON config node, so no YAML dependency is needed.
 */
export async function writeCronPatch(opts: {
  dir: string;
  pluginPath: string;
  config: CronPluginLaunchConfig;
}): Promise<string> {
  const { dir, pluginPath, config } = opts;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `cron-${randomUUID().slice(0, 8)}.cordis.patch.yml`);
  const document = [
    "- insert:",
    "    - id: gps-cron",
    `      name: ${JSON.stringify(pathToFileURL(pluginPath).href)}`,
    `      config: ${JSON.stringify(config)}`,
    "",
  ].join("\n");
  await writeFile(file, document, "utf8");
  return file;
}
```

- [ ] **Step 4: Inject the patch in the adapter**

In `packages/transport-dsh/src/adapter.ts`:

Add the option to `DshRuntimeAdapterOptions`:

```ts
  /**
   * The child-side cron plugin this adapter's launch patch mounts — the
   * scheduled-task tools. Defaults to this package's own build output.
   */
  cronPluginPath?: string;
```

Add the field and constructor default:

```ts
  private readonly cronPluginPath: string;
```
```ts
    this.cronPluginPath =
      options.cronPluginPath ?? fileURLToPath(new URL("./cron-plugin.js", import.meta.url));
```

Import `writeCronPatch` alongside `writeProjectPatch` in the `./bridge.js` import.

In `initialize`, after the project-plugin block:

```ts
    if (opts.project) {
      try {
        patches.push(
          await writeCronPatch({
            dir: this.bridgeDir,
            pluginPath: this.cronPluginPath,
            config: { project: opts.project, root: cwd },
          }),
        );
      } catch (err) {
        console.warn("[dsh] cron plugin unavailable", err);
      }
    }
```

- [ ] **Step 5: Curate `/cron` in the cold fallback**

In `packages/transport-dsh/src/commands.ts`, append to `DSH_HARNESS_FALLBACK_DESCRIPTORS` (after the `/project` row):

```ts
  // This package's own cron plugin registers `/cron` in the harness registry
  // (like `/project`), listed here for the same cold-menu reason.
  {
    id: "cron",
    label: "/cron",
    description: "列出本项目的定时任务",
    invocationText: "/cron",
  },
```

- [ ] **Step 6: Update the existing launch test**

In `packages/transport-dsh/test/project-launch.test.ts`:

```ts
    const patches = await launchedPatches(META);
    assert.equal(patches.length, 3, "the bridge, project and cron patches");
    assert.ok(patches.some((text) => text.includes("drought-screen")), "the project identity rides the launch");
    assert.ok(patches.some((text) => text.includes("gps-cron")), "the cron plugin is mounted");
```

and pass `cronPluginPath: "/opt/ss/cron-plugin.js"` in the `DshRuntimeAdapter` options inside `launchedPatches`.

- [ ] **Step 7: Run the dsh tests**

Run: `npm run test -w @gps/transport-dsh`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/transport-dsh
git commit -m "feat(dsh): mount the cron plugin through a launch patch"
```

---

### Task 11: Documentation (ADR + AGENTS.md)

**Files:**
- Create: `docs/adr/0017-cron-scheduling-is-service-owned-and-task-as-file.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the recorded decision and the updated repo map.

- [ ] **Step 1: Write the ADR**

`docs/adr/0017-cron-scheduling-is-service-owned-and-task-as-file.md` — follow the existing ADR format (Status / Context / Decision / Consequences), recording:

- Tasks are workspace files (`.gps/cron/<id>.md` frontmatter + prompt body) plus a sibling `.log.md`; the file is the authority, no record type.
- The scheduler is service-owned (reliability across cold children, restart recovery of the store), drives `adapter.run()` and shares the server's one-in-flight `activeRuns` lock.
- The dsh child plugin is the agent surface only (tools + `/cron` + prompt), mounted by a third per-launch patch alongside the bridge and project plugins.
- Cron semantics: 5-field restricted grammar with AND across day-of-month/day-of-week (documented deviation), local time.
- Missed fires are skipped; busy targets are skipped (`skipped-busy`).

- [ ] **Step 2: Update AGENTS.md**

- Add `packages/cron` to the Structure block: `@gps/cron` — pure task-document codec, 5-field schedule grammar and run-log format shared by transport-service and the dsh child plugin.
- Note the cron surface in `services/transport-service`: `src/cron/{store,routes,scheduler}.ts`, the `/api/cron*` routes, the `cronScheduler` decorator started only by the entrypoint.
- Note the dsh child plugin `cron-plugin.ts` (tools `schedule_*`, `/cron`) and the third launch patch.
- Note `.gps/cron/` in the workspace description and the `apps/web/app/api/cron` proxy.
- Mention the root build chain now includes `@gps/cron`.

- [ ] **Step 3: Verify the docs build/lint**

Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0017-cron-scheduling-is-service-owned-and-task-as-file.md AGENTS.md
git commit -m "docs(cron): record the service-owned scheduling decision"
```

---

## Self-Review

**Spec coverage:**

- Task-as-file data model (frontmatter + prompt body, `.log.md`) → Tasks 2, 3.
- Service-owned scheduler + persistence → Tasks 3, 5.
- Child plugin agent tools + `/cron` + prompt → Task 9; launch patch → Task 10.
- CronView list / New dialog / double-click → Tasks 6, 7, 8.
- CronTaskRenderer form (view/config, run now, open log, delete) → Task 8.
- File-tab routing by path + tab icon → Task 8.
- CRUD + run-now routes and web proxy → Tasks 4, 6.
- Presets + custom cron, AND semantics, local time → Task 1.
- Skip missed / skip busy → Task 5.
- `@gps/cron` shared package, build chain, deps → Tasks 1, 3, 6, 9.
- Error handling (invalid file surfaced, 400/404/503, per-fire error log) → Tasks 3, 4, 5.
- Tests at every layer → each task.
- ADR + AGENTS.md → Task 11.

**Type consistency:** `CronTask` (package) is the shared shape; `CronTaskSummary` = `CronTask + path + lastRun?` in both the service store and transport-client. `CronRunStatus` = `"success" | "skipped-busy" | "error"` everywhere. `fire()` returns `{ status }`. `createCronStore`/`CronStore`, `registerCronRoutes`, `createCronScheduler`/`CronScheduler` names are used identically across tasks. `taskIdFromPath`/`cronTaskPath`/`cronLogPath`/`isCronTaskPath` are the only path helpers.

**Task ordering:** Task 4 (CRUD routes) is self-contained and does not touch the scheduler; Task 5 adds `scheduler.ts`, the Fastify `cronScheduler` decorator, the `onClose` stop, and the run-now route, then starts it from `index.ts`. Do them in order — Task 5 depends on Task 4's `CronRouteDeps` and registration site.
