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
import type { RuntimeAdapter } from "@gps/transport/seams";

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
