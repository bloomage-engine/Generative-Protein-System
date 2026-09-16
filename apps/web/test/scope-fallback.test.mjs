/**
 * The scope-fallback decision table (docs/adr/0014): where the workbench lands
 * once the active Project or Session is archived or deleted. Pure — no browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackProject, fallbackSession } from "../lib/scope-fallback.ts";

test("fallbackProject opens the first remaining Project, else none", () => {
  assert.equal(fallbackProject([]), null);
  assert.equal(fallbackProject([{ id: "p2" }, { id: "p3" }]), "p2");
});

test("fallbackSession opens the newest remaining Session, else none", () => {
  assert.equal(fallbackSession("p1", []), null);
  assert.equal(fallbackSession("p1", [{ id: "s1" }, { id: "s2" }]), "s2");
});
