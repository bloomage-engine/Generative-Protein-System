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
import {
  isImageFile,
  isMsaFile,
  isPdfFile,
  isStructureFile,
  isTextEditable,
  kindFor,
  languageFor,
} from "../components/studio/file-utils.ts";

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

test("image files map to the image kind by name (mime-independent)", () => {
  for (const name of [
    "a.png",
    "B.JPG",
    "c.jpeg",
    "d.gif",
    "e.webp",
    "f.bmp",
    "g.svg",
  ]) {
    assert.equal(kindFor(name, "application/octet-stream"), "image", name);
    assert.equal(isImageFile(name), true, name);
  }
  assert.equal(kindFor("a.png", "image/png"), "image");
});

test("image detection: only real suffixes count, and images are not text-editable", () => {
  assert.equal(isImageFile("notes.txt"), false);
  assert.equal(isImageFile("png"), false);
  assert.equal(isImageFile("icon.png.txt"), false);
  assert.equal(kindFor("icon.png.txt"), "code");
  assert.equal(isTextEditable("report.pdf"), false);
  assert.equal(isTextEditable("1abc.pdb"), false);
  assert.equal(isTextEditable("photo.png"), false);
  assert.equal(isTextEditable("data.yaml"), true);
  assert.equal(isTextEditable("readme.txt"), true);
});

test("yaml/xml/json routing is unchanged", () => {
  assert.equal(kindFor("notes.md"), "markdown");
  assert.equal(kindFor("notes", "text/markdown"), "markdown");
  assert.equal(kindFor("data.json"), "json");
  assert.equal(kindFor("data", "application/json"), "json");
  assert.equal(kindFor("main.py"), "code");
  assert.equal(kindFor("readme.txt"), "code");
  assert.equal(kindFor("flow.yaml"), "code");
  assert.equal(kindFor("flow.yml"), "code");
  assert.equal(kindFor("manifest.xml"), "code");
  assert.equal(kindFor("settings.toml"), "code");
  assert.equal(kindFor("page.html"), "code");
});

test("common text formats map to their shiki language; unknown ones stay plain", () => {
  assert.equal(languageFor("flow.yaml"), "yaml");
  assert.equal(languageFor("flow.YML"), "yaml");
  assert.equal(languageFor("manifest.xml"), "xml");
  assert.equal(languageFor("settings.toml"), "toml");
  assert.equal(languageFor("config.ini"), "ini");
  assert.equal(languageFor("app.properties"), "properties");
  assert.equal(languageFor("query.sql"), "sql");
  assert.equal(languageFor("table.csv"), "csv");
  assert.equal(languageFor("page.html"), "html");
  assert.equal(languageFor("page.htm"), "html");
  // unchanged mappings
  assert.equal(languageFor("main.py"), "python");
  assert.equal(languageFor("main.ts"), "typescript");
  assert.equal(languageFor("main.js"), "javascript");
  assert.equal(languageFor("run.sh"), "bash");
  // unknown text: no language — the pane falls back to plain text, not a
  // wrong grammar (a .txt must NOT be JS-highlighted).
  assert.equal(languageFor("readme.txt"), undefined);
  assert.equal(languageFor("notes"), undefined);
  assert.equal(languageFor(".env"), undefined);
});

test("only real suffixes count, not words that merely contain them", () => {
  assert.equal(isStructureFile("molecule.txt"), false);
  assert.equal(isPdfFile("pdf-report.txt"), false);
  assert.equal(kindFor("md.pdf.txt"), "code");
});

test("MSA alignment + mmseqs-result files map to the msa kind by name (mime-independent)", () => {
  for (const name of [
    "align.clustal",
    "a.clustal.om",
    "msa.sto",
    "msa.stockholm",
    "seqs.fasta",
    "seqs.fa",
    "seqs.faa",
    "seqs.fna",
    "align.aln",
    "hits.result",
    "mmseqs_output_result",
    "sub/dir/hits_result",
  ]) {
    assert.equal(kindFor(name, "application/octet-stream"), "msa", name);
    assert.equal(isMsaFile(name), true, name);
  }
  assert.equal(isMsaFile("notes.txt"), false);
  assert.equal(isMsaFile("result-notes.txt"), false);
  assert.equal(kindFor("notes.txt"), "code");
});

test("msa files are not text-editable (no source editor; the renderer owns the raw view)", () => {
  assert.equal(isTextEditable("align.clustal"), false);
  assert.equal(isTextEditable("seqs.fasta"), false);
  assert.equal(isTextEditable("hits.result"), false);
  assert.equal(isTextEditable("data.yaml"), true); // regression: text files still editable
});
