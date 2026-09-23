import { test } from "node:test";
import assert from "node:assert/strict";
import { MsaMentionError, formatMsaMention, msaMentionKey, parseMsaMention } from "../src/mention.js";

test("formatMsaMention: one cell and a run", () => {
  assert.equal(
    formatMsaMention("proj", "a/b.c", { seqName: "Seq1", start: 5, end: 5 }),
    "@proj/a/b.c/Seq1@5",
  );
  assert.equal(
    formatMsaMention("proj", "a/b.c", { seqName: "Seq1", start: 5, end: 9 }),
    "@proj/a/b.c/Seq1@5-9",
  );
});

test("parseMsaMention: round-trips both forms", () => {
  for (const mention of ["@proj/a/b.c/Seq1@5", "@proj/a/b.c/Seq1@5-9"]) {
    const p = parseMsaMention(mention);
    assert.equal(p.project, "proj");
    assert.equal(p.path, "a/b.c");
    assert.deepEqual(p.target, mention.endsWith("@5") ? { seqName: "Seq1", start: 5, end: 5 } : { seqName: "Seq1", start: 5, end: 9 });
    assert.equal(formatMsaMention(p.project, p.path, p.target), mention);
  }
});

test("parseMsaMention: a trailing ' #label' (the structure-mention convention) is tolerated", () => {
  const p = parseMsaMention("@proj/x/Seq1@5 #Hydrogen Bond");
  assert.deepEqual(p.target, { seqName: "Seq1", start: 5, end: 5 });
});

test("parseMsaMention: malformed mentions are typed errors, never partial", () => {
  for (const bad of [
    "no-at-sign",
    "@proj",
    "@proj/x",
    "@proj/x/Seq1",
    "@proj/x/Seq1@abc",
    "@proj/x/Seq1@9-5",
    "@proj/x//5",
  ]) {
    assert.throws(() => parseMsaMention(bad), MsaMentionError, bad);
  }
});

test("a project containing a slash splits at the FIRST slash (documented ambiguity)", () => {
  const p = parseMsaMention("@a/proj/path/Seq@1");
  assert.equal(p.project, "a");
  assert.equal(p.path, "proj/path");
});

test("msaMentionKey is stable across single cells and runs", () => {
  assert.equal(msaMentionKey({ seqName: "Seq1", start: 5, end: 5 }), "Seq1@5-5");
  assert.equal(msaMentionKey({ seqName: "Seq1", start: 5, end: 9 }), "Seq1@5-9");
});
