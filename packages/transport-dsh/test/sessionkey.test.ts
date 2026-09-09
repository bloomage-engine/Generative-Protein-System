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

test("resolveSessionKey passes stable client ids through and defaults local-mint/absent ones", () => {
  withDefaultSession("dshtest-default", () => {
    const adapter = new DshRuntimeAdapter();
    assert.equal(adapter.resolveSessionKey("sess-real-1"), "sess-real-1");
    assert.equal(adapter.resolveSessionKey("__LOCALID_abc123"), "dshtest-default", "assistant-ui local-mint ids must converge on the default session");
    assert.equal(adapter.resolveSessionKey(null), "dshtest-default", "the mount probe claims no session");
  });
});

test("resolveSessionKey defaults to 'default' when unconfigured", () => {
  withDefaultSession(undefined, () => {
    assert.equal(new DshRuntimeAdapter().resolveSessionKey("__LOCALID_x"), "default");
  });
});
