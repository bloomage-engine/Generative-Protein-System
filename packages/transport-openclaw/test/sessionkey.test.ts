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
    assert.equal(
      a.resolveSessionKey("thread-42"),
      "oc-default",
      "an id the gateway does not namespace collapses to the configured default session",
    );
  });
});

test("resolveSessionKey defaults to agent:main:main when unconfigured", () => {
  withDefaultSession(undefined, () => {
    assert.equal(adapter().resolveSessionKey("thread-42"), "agent:main:main");
  });
});
