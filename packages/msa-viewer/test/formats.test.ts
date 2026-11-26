import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MsaParseError,
  isMsaFile,
  mergeAnnotations,
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

// Real `mmseqs easy-search` / BLAST-tabular `.result`: query, target, pident, length,
// mismatch, gapopen, qstart, qend, tstart, tend, evalue, [score]. 12 columns with the
// bit score, 11 without.
const MMSEQS_12 = "A00001|db|prot\tB00001|db|prot\t82.5\t26\t4\t1\t1\t26\t1\t26\t3e-12\t142.6\n";
const MMSEQS_12_SPACED = MMSEQS_12.replace(/\t/g, " ");
const MMSEQS_11 = "A00001|db|prot B00001|db|prot 82.5 26 4 1 1 26 1 26 3e-12\n";

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
  // ColabFold / AlphaFold MSA
  assert.equal(isMsaFile("fold_a.a3m"), true);
  assert.equal(isMsaFile("MSA.A3M"), true);
  assert.equal(isMsaFile("data/fold_2025_06_27_18_45_paired_msa_chains_a.a3m"), true);
});

test("sniffFormat recognizes each format from the first content line", () => {
  assert.equal(sniffFormat(CLUSTAL), "clustalw");
  assert.equal(sniffFormat(STOCKHOLM), "stockholm");
  assert.equal(sniffFormat("#=GS Seq1 AC x\nSeq1  ABC\n//"), "stockholm");
  assert.equal(sniffFormat("#=GC RF xxxx\nSeq1  ABC\n//"), "stockholm"); // Pfam-style GC-first
  assert.equal(sniffFormat(FASTA_ALIGNED), "fasta");
  assert.equal(sniffFormat(MMSEQS_12), "mmseqs");
});

test("sniffFormat skips comment lines and rejects unrecognized content", () => {
  assert.equal(sniffFormat("# from mmseqs\n" + MMSEQS_12_SPACED), "mmseqs");
  assert.equal(sniffFormat("hello world\njust some text\n"), null);
  assert.equal(sniffFormat(""), null);
});

test("ClustalW: two blocks re-join per sequence; consensus blocks MERGE into one full-length annotation", () => {
  const r = parseAlignment(CLUSTAL);
  assert.equal(r.kind, "aligned");
  if (r.kind !== "aligned") return;
  assert.deepEqual(r.sequences.map((s) => s.name), ["Seq1", "Seq2"]);
  assert.equal(r.columns, 27);
  assert.equal(r.sequences[0]!.seq, "MAAVLTTVLLLLLLAAPAKAAAADGAG");
  assert.equal(r.sequences[1]!.seq, "MAALVTTVLLLLLLAAPAKAAAADGGA");
  // one merged annotation (not one fragment per block — those would misplace
  // every block after the first and collide on the React key)
  assert.equal(r.annotations.length, 1);
  assert.equal(r.annotations[0]!.label, "consensus");
  assert.equal(r.annotations[0]!.chars, "*".repeat(27));
});

test("ClustalW: a consensus line's name-field indent is stripped, an unmarked leading column is preserved", () => {
  const INDENT = " ".repeat(15); // "Seq1" + 11 spaces = the name field
  const text = [
    "CLUSTAL W 1.85",
    "",
    `Seq1${" ".repeat(11)}MKA`,
    `Seq2${" ".repeat(11)}M-A`,
    `${INDENT} **`, // column 1 unmarked, then conserved
    "",
    `Seq1${" ".repeat(11)}TTV`,
    `Seq2${" ".repeat(11)}TTV`,
    `${INDENT}***`,
    "",
  ].join("\n");
  const r = parseAlignment(text);
  assert.equal(r.kind, "aligned");
  if (r.kind !== "aligned") return;
  assert.equal(r.columns, 6);
  assert.equal(r.annotations.length, 1);
  assert.equal(r.annotations[0]!.chars, " *****"); // space preserved, blocks joined in order
});

test("mergeAnnotations: per-label concatenation in first-seen order", () => {
  const merged = mergeAnnotations([
    { label: "consensus", chars: "ab" },
    { label: "RF", chars: "xx" },
    { label: "consensus", chars: "cd" },
  ]);
  assert.deepEqual(merged, [
    { label: "consensus", chars: "abcd" },
    { label: "RF", chars: "xx" },
  ]);
  assert.deepEqual(mergeAnnotations([]), []);
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

test("FASTA: repeated record names are distinct records (real ColabFold/UniRef a3m repeats ids)", () => {
  const r = parseAlignment(">Seq1 first\nMAAVL\n>Seq1 second\nMAAVL\n>Seq2\nMAAVL\n");
  assert.equal(r.kind, "aligned");
  if (r.kind !== "aligned") return;
  assert.equal(r.sequences.length, 3);
  assert.deepEqual(r.sequences.map((s) => s.name), ["Seq1", "Seq1", "Seq2"]);
  assert.deepEqual(r.sequences.map((s) => s.id), [0, 1, 2]);
  assert.deepEqual(r.sequences.map((s) => s.seq), ["MAAVL", "MAAVL", "MAAVL"]);
});

test("a3m: lowercase insertions are not part of the alignment — the grid shows the gapless match states", () => {
  // ragged raw lengths on purpose: the insertions differ per record
  const text = [">query", "MKavltTTVLL", ">hit1", "MKqTTVLL", ">hit2", "MKTTVLL"].join("\n");
  const r = parseAlignment(text);
  assert.equal(r.kind, "aligned");
  if (r.kind !== "aligned") return;
  assert.equal(r.columns, 7);
  assert.deepEqual(r.sequences.map((s) => s.seq), ["MKTTVLL", "MKTTVLL", "MKTTVLL"]);
  assert.equal(r.insertionsStripped, true);
});

test("a3m: duplicate record names are kept as separate rows and still reduce to the match states", () => {
  const text = [
    ">UniRef100_A0A371H0J5 first",
    "MKavltTTVLL",
    ">UniRef100_A0A371H0J5 second",
    "MKqTTVLL",
    ">hit2",
    "MKTTVLL",
  ].join("\n");
  const r = parseAlignment(text);
  assert.equal(r.kind, "aligned");
  if (r.kind !== "aligned") return;
  assert.equal(r.columns, 7);
  assert.equal(r.sequences.length, 3);
  assert.deepEqual(r.sequences.map((s) => s.name), [
    "UniRef100_A0A371H0J5",
    "UniRef100_A0A371H0J5",
    "hit2",
  ]);
  assert.deepEqual(r.sequences.map((s) => s.id), [0, 1, 2]);
  assert.deepEqual(r.sequences.map((s) => s.seq), ["MKTTVLL", "MKTTVLL", "MKTTVLL"]);
  assert.equal(r.insertionsStripped, true);
});

test("a3m: a stray NUL (or other control byte) does not defeat the match-state check", () => {
  const text = [">query", "MKavltTTVLL", ">hit1", "MKqTTVLL", ">hit2", "MKTTVLL\u0000"].join("\n");
  const r = parseAlignment(text);
  assert.equal(r.kind, "aligned");
  if (r.kind !== "aligned") return;
  assert.equal(r.columns, 7);
  assert.deepEqual(r.sequences.map((s) => s.seq), ["MKTTVLL", "MKTTVLL", "MKTTVLL"]);
  assert.equal(r.insertionsStripped, true);
});

test("an equal-length FASTA keeps its lowercase (soft-masked residues are not insertions)", () => {
  const r = parseAlignment(">a\nMKavlt\n>b\nMK--lt\n");
  assert.equal(r.kind, "aligned");
  if (r.kind !== "aligned") return;
  assert.equal(r.sequences[0]!.seq, "MKavlt"); // untouched
  assert.equal(r.insertionsStripped, undefined);
});

test("a ragged FASTA WITHOUT lowercase stays unaligned (the a3m reduction does not apply)", () => {
  const r = parseAlignment(">a\nMKAVLTT\n>b\nMKTT\n");
  assert.equal(r.kind, "unaligned");
});

test("Stockholm: a real Pfam-style #=GC per-column annotation is kept (alongside #=PC)", () => {
  const text = [
    "# STOCKHOLM 1.0",
    `Seq1 ${SEQ26}`,
    `Seq2 ${SEQ26B}`,
    `#=GC RF        ${"x".repeat(26)}`,
    `#=GC ss_cons   ${">".repeat(26)}`,
    "//",
  ].join("\n");
  const r = parseAlignment(text);
  assert.equal(r.kind, "aligned");
  if (r.kind !== "aligned") return;
  assert.equal(r.annotations.length, 2);
  assert.deepEqual(r.annotations.map((a) => a.label), ["RF", "ss_cons"]);
  assert.equal(r.annotations[0]!.chars.length, 26);
  assert.equal(r.annotations[1]!.chars, ">".repeat(26));
});

test("mmseqs .result: real BLAST-tabular order, tab or space separated, numeric cells become numbers", () => {
  const t = parseAlignment(MMSEQS_12);
  assert.equal(t.kind, "mmseqs");
  if (t.kind !== "mmseqs") return;
  assert.deepEqual(t.fields, [
    "query", "target", "pident", "length", "mismatch", "gapopen",
    "qstart", "qend", "tstart", "tend", "evalue", "score",
  ]);
  assert.deepEqual(t.rows[0], [
    "A00001|db|prot", "B00001|db|prot",
    82.5, 26, 4, 1, 1, 26, 1, 26, 3e-12, 142.6,
  ]);
  // tabs and spaces are the same table
  assert.deepEqual(parseAlignment(MMSEQS_12_SPACED), t);
  // 11 columns: no bit score, evalue last
  const noScore = parseAlignment(MMSEQS_11);
  if (noScore.kind !== "mmseqs") return;
  assert.equal(noScore.fields.length, 11);
  assert.equal(noScore.rows[0]!.length, 11);
  assert.equal(noScore.rows[0]![10], 3e-12); // evalue, read from the real column
});

test("mmseqs .result: malformed rows are typed errors, never NaN cells", () => {
  // 10 fields (ends at tstart — no evalue)
  assert.throws(() => parseAlignment("A00001|db|prot B00001|db|prot 82.5 26 4 1 1 26 1\n"), MsaParseError);
  // non-numeric pident
  assert.throws(() => parseAlignment("A00001|db|prot B00001|db|prot xx 26 4 1 1 26 1 26 3e-12 142.6\n"), MsaParseError);
  // too many fields (a convertalis detail column is not supported)
  assert.throws(
    () => parseAlignment("A00001|db|prot B00001|db|prot 82.5 26 4 1 1 26 1 26 3e-12 142.6 qaln taln\n"),
    MsaParseError,
  );
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
