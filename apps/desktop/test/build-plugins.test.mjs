import { test } from "node:test";
import assert from "node:assert/strict";
import { childPluginNames } from "../scripts/plugin-files.mjs";

test("every child plugin output is bundled, not a hand-maintained subset", () => {
  assert.deepEqual(
    childPluginNames([
      "bridge-plugin.js",
      "commands.js",
      "project-plugin.js",
      "cron-plugin.js",
      "cron-plugin.d.ts",
      "subagent-plugin.js.map",
      "subagent-plugin.js",
      "hpc-plugin.js",
      "worktree-plugin.js",
    ]),
    [
      "bridge-plugin.js",
      "cron-plugin.js",
      "hpc-plugin.js",
      "project-plugin.js",
      "subagent-plugin.js",
      "worktree-plugin.js",
    ],
  );
});
