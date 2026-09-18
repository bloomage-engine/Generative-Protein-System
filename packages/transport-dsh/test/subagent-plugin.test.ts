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
