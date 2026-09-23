import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MsaParseError,
  isMsaFile,
  parseAlignment,
  sniffFormat,
  type MsaSequence,
} from "../src/formats.js";

const SEQ26 = "MAAVLTTVLLLLLLAAPAKAAADGAG"; // 26 aa
const SEQ26B = "MAALVTTVLLLLLLAAPAKAAADGGA";

const CLUSTAL = [
  "CLUSTAL W 1.85 multiple sequence alignment",
  "",
  `Seq1           ${"MAAVLTTVLLLLLLAAPAKA"}`,
  `Seq2           ${"MAALVTTVLLLLLLAAPAKA"}`,
  `               ${"*".repeat(20)}`,
  "",
  "Seq1           AAADGAG",
  "Seq2           AAADGGA",
  "               *******",
  "",
].join("\n");

const STOCKHOLM = [
  "# STOCKHOLM 1.0",
  '#=GS Seq1 AC "P12345"',
  `Seq1           ${SEQ26}`,
  `Seq2           ${SEQ26B}`,
  `#=PC CONS     ${"*".repeat(8) + "-".repeat(18)}`,
  "//",
].join("\n");

const FASTA_ALIGNED = `>Seq1\n${SEQ26}\n>Seq2\n${SEQ26B}\n`;
const FASTA_UNALIGNED = `>Seq1\n${SEQ26}\n>Short\nMAAVL\n`;

const MMSEQS_TAB_11 = "A00001|db|prot\tB00001|db|prot\t26\t82.5\t2\t1\t26\t1\t26\t3e-12\t142.6\n";
const MMSEQS_SPACE_12 =
  `A00001|db|prot B00001|db|prot 26 82.5 2 1 26 1 26 3e-12 142.6 ${SEQ26.slice(0, 12)}-${SEQ26.slice(12)}\n`;

test("isMsaFile: recognized alignments and search results by name (case-insensitive)", () => {
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
    "UPPER.FASTA",
  ]) {
    assert.equal(isMsaFile(name), true, name);
  }
  for (const name of ["notes.txt", "result-notes.txt", "icon.png", "molecule.pdb", "pdf-report.txt"]) {
    assert.equal(isMsaFile(name), false, name);
  }
});

test("sniffFormat recognizes each format from the first content line", () => {
  assert.equal(sniffFormat(CLUSTAL), "clustalw");
  assert.equal(sniffFormat(STOCKHOLM), "stockholm");
  assert.equal(sniffFormat("#=GS Seq1 AC x\nSeq1  ABC\n//"), "stockholm");
  assert.equal(sniffFormat(FASTA_ALIGNED), "fasta");
  assert.equal(sniffFormat(MMSEQS_TAB_11.replace("\t", " ")), "mmseqs");
});

test("sniffFormat skips comment lines and rejects unrecognized content", () => {
  assert.equal(sniffFormat("# from mmseqs\n" + MMSEQS_TAB_11.replace(/\t/g, " ")), "mmseqs");
  assert.equal(sniffFormat("hello world\njust some text\n"), null);
  assert.equal(sniffFormat(""), null);
});

test("ClustalW: two blocks re-join per sequence; consensus annotations kept per block", () => {
  const r = parseAlignment(CLUSTAL);
  assert.equal(r.kind, "aligned");
  if (r.kind !== "aligned") return;
  assert.deepEqual(r.sequences.map((s) => s.name), ["Seq1", "Seq2"]);
  assert.equal(r.columns, 27);
  assert.equal(r.sequences[0]!.seq, "MAAVLTTVLLLLLLAAPAKAAAADGAG");
  assert.equal(r.sequences[1]!.seq, "MAALVTTVLLLLLLAAPAKAAAADGGA");
  assert.equal(r.annotations.length, 2);
  assert.equal(r.annotations[0]!.label, "consensus");
  assert.equal(r.annotations.flatMap((a) => a.chars).join("").length, 27);
});

test("Stockholm: GS name kept, PC annotation, trailing // (or EOF) tolerated", () => {
  const r = parseAlignment(STOCKHOLM);
  assert.equal(r.kind, "aligned");
  if (r.kind !== "aligned") return;
  assert.deepEqual(r.sequences.map((s) => s.name), ["Seq1", "Seq2"]);
  assert.equal(r.columns, 26);
  assert.equal(r.sequences[0]!.seq, SEQ26);
  assert.equal(r.annotations.length, 1);
  assert.equal(r.annotations[0]!.label, "CONS");
  assert.equal(r.annotations[0]!.chars.length, 26);
  // missing terminator is tolerated
  const noSlash = STOCKHOLM.replace("//\n", "").replace("//", "");
  assert.equal(parseAlignment(noSlash).kind, "aligned");
});

test("aligned FASTA → aligned; ragged FASTA → unaligned; a single sequence stays a grid-able aligned row", () => {
  const a = parseAlignment(FASTA_ALIGNED);
  assert.equal(a.kind, "aligned");
  if (a.kind === "aligned") assert.equal(a.columns, 26);
  const u = parseAlignment(FASTA_UNALIGNED);
  assert.equal(u.kind, "unaligned");
  if (u.kind === "unaligned") {
    assert.equal(u.sequences.length, 2);
    assert.equal(u.sequences[0]!.seq.length, 26);
    assert.equal(u.sequences[1]!.seq.length, 5);
  }
  const single = parseAlignment(">Only\nMAAVL\n");
  assert.equal(single.kind, "aligned");
});

test("FASTA: the name is the first header token; a description is dropped; an empty name is a typed error", () => {
  const r = parseAlignment("> Seq1 with a description\nMAAVL\n");
  if (r.kind !== "unaligned") return;
  assert.equal(r.sequences[0]!.name, "Seq1");
  assert.throws(() => parseAlignment(">\nMAAVL\n"), MsaParseError);
  assert.throws(() => parseAlignment("MAAVL\n"), MsaParseError); // data before any header
});

test("mmseqs .result: tab or space separated; 10/11/12-field rows; numeric fields become numbers", () => {
  const t = parseAlignment(MMSEQS_TAB_11);
  assert.equal(t.kind, "mmseqs");
  if (t.kind !== "mmseqs") return;
  assert.equal(t.fields.length, 11);
  assert.deepEqual(t.rows[0]!.slice(0, 11), [
    "A00001|db|prot",
    "B00001|db|prot",
    26, 82.5, 2, 1, 26, 1, 26, 3e-12, 142.6,
  ]);
  const s = parseAlignment(MMSEQS_SPACE_12);
  if (s.kind !== "mmseqs") return;
  assert.equal(s.fields.length, 12);
  assert.equal(s.rows[0]![10], 142.6);
  assert.equal(typeof s.rows[0]![11], "string");
  const ten = parseAlignment("A|db|p B|db|p 26 82.5 2 1 26 1 26 3e-12\n");
  if (ten.kind !== "mmseqs") return;
  assert.equal(ten.fields.length, 10);
});

test("mmseqs .result: malformed rows are typed errors, never silent", () => {
  assert.throws(() => parseAlignment("A p B p 10 90.0 1 1 10 1\n"), MsaParseError); // 9 fields
  assert.throws(() => parseAlignment("A p B p xx 90.0 1 1 10 1 2e-3 5.0\n"), MsaParseError); // non-numeric field 3
  assert.throws(() => parseAlignment("# only a comment\n"), MsaParseError); // no rows
});

test("BOM + CRLF are normalized; empty content is a typed error", () => {
  const crlf = "\uFEFF" + FASTA_ALIGNED.replace(/\n/g, "\r\n");
  assert.deepEqual(parseAlignment(crlf), parseAlignment(FASTA_ALIGNED));
  assert.throws(() => parseAlignment(""), MsaParseError);
  assert.throws(() => parseAlignment("  \n\n"), MsaParseError);
});

test("unrecognized content throws MsaParseError with a reason", () => {
  try {
    parseAlignment("hello world\njust text\n");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof MsaParseError);
    assert.ok((e as MsaParseError).reason.length > 0);
  }
});
