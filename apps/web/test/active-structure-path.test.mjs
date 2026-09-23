/**
 * The derived `activeStructurePath` selector: the ONE file the user is viewing,
 * and only when it is a structure file. This is what the structure tools target
 * — the agent's `molql` has no path of its own.
 *
 * Pure — imports the store module through the app's `@/` alias loader, no DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeStructurePath } from "../store/studio-store.ts";

const tab = (path, name = path) => ({ id: path, path, name });
const state = (tabs, activeTabPath) => ({ tabs, activeTabPath });

test("returns the active tab's path only when that file is a structure", () => {
  const tabs = [tab("a.pdb"), tab("readme.md")];
  assert.equal(activeStructurePath(state(tabs, "a.pdb")), "a.pdb");
  assert.equal(activeStructurePath(state(tabs, "readme.md")), null);
});

test("returns null when the active tab is missing or none is set", () => {
  const tabs = [tab("a.pdb")];
  assert.equal(activeStructurePath(state(tabs, "gone.pdb")), null);
  assert.equal(activeStructurePath(state([], null)), null);
  assert.equal(activeStructurePath(state([], "a.pdb")), null);
});

test("recognizes the supported structure extensions (and .gz)", () => {
  for (const name of ["x.pdb", "x.cif", "x.mmcif", "x.mol", "x.mol2", "x.bcif", "x.xyz", "1abc.pdb.gz"]) {
    assert.equal(activeStructurePath(state([tab(name)], name)), name, name);
  }
  for (const name of ["notes.md", "data.csv", "model.py", "image.png"]) {
    assert.equal(activeStructurePath(state([tab(name)], name)), null, name);
  }
});
