import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, inject, name } from "../src/subagent-plugin.js";

// Mirrors the idiom in cron-plugin.test.ts: a fake host exposing a
// `systemPrompt.section` capture, passed to apply(ctx) without a cast.
function fakeHost() {
  interface Section { name: string; order: number; text: string }
  const sections: Section[] = [];
  const ctx = {
    systemPrompt: {
      section: (s: Section) => {
        sections.push(s);
        return () => { /* disposer */ };
      },
    },
  };
  return { ctx, sections: () => sections };
}

test("the plugin registers a host-scope reporting section", () => {
  const { ctx, sections } = fakeHost();
  apply(ctx);
  assert.equal(sections().length, 1);
  assert.equal(sections()[0]?.name, name);
  assert.match(sections()[0]?.text ?? "", /subagent/i);
  assert.match(sections()[0]?.text ?? "", /report/i);
});

test("a host without a systemPrompt surface registers nothing and does not throw", () => {
  let threw = false;
  try { apply({}); } catch { threw = true; }
  assert.equal(threw, false);
});

test("the plugin declares a section-only inject scope", () => {
  assert.deepEqual([...inject], ["systemPrompt"]);
});

test("the disposal callback (when provided by ctx.effect) is invoked", () => {
  interface Section { name: string; order: number; text: string }
  const sections: Section[] = [];
  let disposed = 0;
  // A "host-side" holder that captures the register closure (an object property,
  // so TS does not flow-narrow it to its null initializer the way a bare `let` would).
  const host: { register: (() => () => void) | null } = { register: null };
  const ctx = {
    systemPrompt: {
      section: (s: Section) => {
        sections.push(s);
        return () => { disposed += 1; };
      },
    },
    effect: (register: () => () => void, _name: string) => { host.register = register; },
  };
  apply(ctx);
  assert.ok(host.register, "ctx.effect captured the register closure");
  const disposeEffect = host.register!();
  assert.equal(sections.length, 1, "mounting (calling register) registers the section");
  assert.equal(disposed, 0, "not disposed yet");
  disposeEffect();
  assert.equal(disposed, 1, "the effect's disposer invokes the section's own dispose");
});
