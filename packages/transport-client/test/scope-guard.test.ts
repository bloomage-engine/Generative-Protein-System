/**
 * The scope seam's guard: NO client source file may hand-spell a claim key —
 * the only place `projectId` / `worktreeId` / `threadId` may appear as a WIRE
 * spelling is `src/scope.ts`, the module that owns the spelling. A per-module
 * `query()` or `params.set("projectId", …)` is exactly the drift this refactor
 * removed; this test keeps it from creeping back.
 *
 * Three shapes count as a wire spelling:
 *   - a quoted key: `"projectId"`, `params.set("worktreeId", …)`;
 *   - an inline fragment: `` `?projectId=${id}` `` (the old cron/skills style);
 *   - a key folded into URLSearchParams: `new URLSearchParams({ projectId })`.
 *
 * A `ClientScope` VALUE is different: `{ projectId, worktreeId }` and
 * `const { projectId } = scope` are type-checked identifiers used to CARRY the
 * scope, not to spell its wire key, so they are deliberately allowed.
 *
 * The scan is byte-level and includes comments, so a claim key in prose must be
 * written without quotes/backticks. If a legitimate wire use ever appears, it
 * belongs in a review conversation, not a widened guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const EXEMPT = join(SRC_DIR, "scope.ts");

/** A claim key wrapped in a quote, apostrophe or backtick. */
const CLAIM_QUOTED = /["'`](projectId|worktreeId|threadId)["'`]/;
/** An inline wire fragment, e.g. `` `?projectId=${id}` `` (`==` is a comparison). */
const CLAIM_FRAGMENT = /\b(projectId|worktreeId|threadId)=(?!=)/;
/** A claim key folded straight into URLSearchParams: `new URLSearchParams({ projectId })`. */
const CLAIM_PARAMS = /URLSearchParams\s*\(\s*\{[^}]*\b(projectId|worktreeId|threadId)\b/;

const CLAIM_SPELLINGS = [CLAIM_QUOTED, CLAIM_FRAGMENT, CLAIM_PARAMS];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else out.push(full);
  }
  return out;
}

test("no client source hand-spells a claim key outside scope.ts", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    if (file === EXEMPT) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (CLAIM_SPELLINGS.some((pattern) => pattern.test(line))) {
        offenders.push(`${relative(SRC_DIR, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `claim keys belong in scope.ts alone; found:\n${offenders.join("\n")}`,
  );
});
