import { test } from "node:test";
import assert from "node:assert/strict";
import { DshRuntimeAdapter } from "../src/index.js";

function withDefaultSession(value: string | undefined, fn: () => void): void {
  const prev = process.env.DSH_DEFAULT_SESSION;
  if (value === undefined) delete process.env.DSH_DEFAULT_SESSION;
  else process.env.DSH_DEFAULT_SESSION = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_DEFAULT_SESSION;
    else process.env.DSH_DEFAULT_SESSION = prev;
  }
}

/**
 * dsh's own session-key POLICY, not the seam's convergence rule: the conver-
 * gence of an unclaimed session with `__LOCALID_*` is asserted by the shared
 * `testResolveSessionKey` suite in conformance.test.ts. What only dsh can pin
 * is what a real client id does, and the exact default it resolves to.
 */
test("resolveSessionKey passes stable client ids through and uses the configured default", () => {
  withDefaultSession("dshtest-default", () => {
    const adapter = new DshRuntimeAdapter();
    assert.equal(adapter.resolveSessionKey("sess-real-1"), "sess-real-1");
    assert.equal(adapter.resolveSessionKey("__LOCALID_abc123"), "dshtest-default", "a configured default session applies to local-mint ids");
  });
});

test("resolveSessionKey resolves an absent session to 'default' when unconfigured", () => {
  withDefaultSession(undefined, () => {
    assert.equal(new DshRuntimeAdapter().resolveSessionKey(null), "default");
  });
});
