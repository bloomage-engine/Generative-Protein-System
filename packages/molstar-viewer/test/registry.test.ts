import { test } from "node:test";
import assert from "node:assert/strict";
import { getMolqlViewer, removeMolqlViewer, setMolqlViewer } from "../src/registry.js";
import type { MolqlSelectionTarget } from "../src/target.js";

/** A viewer stub with nothing loaded — enough for registry bookkeeping. */
function stub(): MolqlSelectionTarget {
  return {
    structure: undefined,
    select: () => {},
    highlight: () => {},
    focus: () => {},
  };
}

test("viewers are keyed by path, so several structure tabs can coexist", () => {
  const a = stub();
  const b = stub();
  setMolqlViewer("a.pdb", a);
  setMolqlViewer("b.pdb", b);
  try {
    assert.equal(getMolqlViewer("a.pdb"), a);
    assert.equal(getMolqlViewer("b.pdb"), b);
    assert.equal(getMolqlViewer("c.pdb"), null);
  } finally {
    removeMolqlViewer("a.pdb", a);
    removeMolqlViewer("b.pdb", b);
  }
});

test("removing only clears the viewer it still owns", () => {
  const stale = stub();
  const live = stub();
  setMolqlViewer("swap.pdb", stale);
  setMolqlViewer("swap.pdb", live);
  try {
    removeMolqlViewer("swap.pdb", stale); // a stale unmount must not clear the live viewer
    assert.equal(getMolqlViewer("swap.pdb"), live);
  } finally {
    removeMolqlViewer("swap.pdb", live);
  }
  assert.equal(getMolqlViewer("swap.pdb"), null);
});
