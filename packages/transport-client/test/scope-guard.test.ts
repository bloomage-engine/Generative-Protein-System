/**
 * The scope seam's guard: NO client source file may hand-spell a claim key —
 * the only place `projectId` / `worktreeId` / `threadId` may appear as a
 * quoted literal is `src/scope.ts` itself, the module that owns the spelling.
 * A per-module `query()` / `params.set("projectId", …)` is exactly the drift
 * this refactor removed; this test keeps it from creeping back.
 *
 * The scan is byte-level: any quoted (or backticked) claim key anywhere in the
 * file — code OR comment — is a failure. If a legitimate non-claim use ever
 * appears, it belongs in a review conversation, not a widened guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const EXEMPT = join(SRC_DIR, "scope.ts");

/** A claim key wrapped in a quote, apostrophe or backtick. */
const CLAIM_LITERAL = /["'`](projectId|worktreeId|threadId)["'`]/;

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
      if (CLAIM_LITERAL.test(line)) {
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
