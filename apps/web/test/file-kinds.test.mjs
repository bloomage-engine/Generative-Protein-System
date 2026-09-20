/**
 * Regression: the preview routes PDFs and structure files to the heavy
 * viewers, not the text renderer.
 *
 * The workspace service serves every structure format as
 * `application/octet-stream` (and PDFs as `application/pdf`), so a MIME sniff
 * cannot tell them apart — the decision is by file NAME. If this mapping drifts,
 * a `.pdb` silently falls back to "preview is not available".
 *
 * Pure Node (type stripping) — no Chromium needed. Prereq is nothing beyond the
 * source tree, unlike the browser suites.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPdfFile, isStructureFile, kindFor } from "../components/studio/file-utils.ts";

test("PDF files map to the pdf kind by name (mime-independent)", () => {
  assert.equal(kindFor("report.pdf"), "pdf");
  assert.equal(kindFor("REPORT.PDF"), "pdf");
  assert.equal(kindFor("report.pdf", "application/octet-stream"), "pdf");
  assert.equal(isPdfFile("report.PDF"), true);
});

test("structure formats map to the structure kind", () => {
  for (const name of [
    "1abc.pdb",
    "1abc.PDB.gz",
    "model.cif",
    "model.cif.gz",
    "model.mmcif",
    "model.bcif",
    "model.bcif.gz",
    "ligand.mol",
    "ligand.mol2",
  ]) {
    assert.equal(kindFor(name, "application/octet-stream"), "structure", name);
    assert.equal(isStructureFile(name), true, name);
  }
});

test("text/markdown/json routing is unchanged", () => {
  assert.equal(kindFor("notes.md"), "markdown");
  assert.equal(kindFor("notes", "text/markdown"), "markdown");
  assert.equal(kindFor("data.json"), "json");
  assert.equal(kindFor("data", "application/json"), "json");
  assert.equal(kindFor("main.py"), "code");
  assert.equal(kindFor("readme.txt"), "code");
});

test("only real suffixes count, not words that merely contain them", () => {
  assert.equal(isStructureFile("molecule.txt"), false);
  assert.equal(isPdfFile("pdf-report.txt"), false);
  assert.equal(kindFor("md.pdf.txt"), "code");
});
