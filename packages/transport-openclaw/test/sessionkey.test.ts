import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenClawRuntimeAdapter } from "../src/index.js";

/** resolveSessionKey reads env/config only — no gateway needed. */
function adapter(): OpenClawRuntimeAdapter {
  return new OpenClawRuntimeAdapter();
}

function withDefaultSession(value: string | undefined, fn: () => void): void {
  const prev = process.env.OPENCLAW_DEFAULT_SESSION;
  if (value === undefined) delete process.env.OPENCLAW_DEFAULT_SESSION;
  else process.env.OPENCLAW_DEFAULT_SESSION = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_DEFAULT_SESSION;
    else process.env.OPENCLAW_DEFAULT_SESSION = prev;
  }
}

test("resolveSessionKey passes agent:-namespaced ids and defaults everything else", () => {
  withDefaultSession("oc-default", () => {
    const a = adapter();
    assert.equal(a.resolveSessionKey("agent:main:main"), "agent:main:main");
    assert.equal(a.resolveSessionKey("agent:alt"), "agent:alt");
    assert.equal(a.resolveSessionKey("__LOCALID_abc"), "oc-default", "assistant-ui local-mint ids fall to the default session");
    assert.equal(a.resolveSessionKey(null), "oc-default", "the mount probe claims no session");
  });
});

test("resolveSessionKey defaults to agent:main:main when unconfigured", () => {
  withDefaultSession(undefined, () => {
    assert.equal(adapter().resolveSessionKey(null), "agent:main:main");
  });
});
