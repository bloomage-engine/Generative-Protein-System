# MSA Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An interactive MSA (multiple sequence alignment) viewer in the workbench file preview: aligned grid with click-select, double-click composer mentions, search/filters and conservation; mmseqs2 hit tables; unaligned-FASTA rows; plain-text fallback.

**Architecture:** A new zero-dependency package `@science-studio/msa-viewer` owns the pure, Node-testable logic (parsers for ClustalW / Stockholm / FASTA / mmseqs `.result`, column statistics, the mention codec, row-windowing/span-grouping/ruler/band scales) and thin React views over it (`MsaGrid`, `MsaResultTable`, `UnalignedList`). `apps/web` gains an `"msa"` file kind (by name, per repo convention), a `MsaRenderer` shell that fetches its own bytes and routes by parse result, and mention insertion through the existing `ComposerInsertProvider` seam. No service routes, no agent-side plugin, no record change, no molstar.

**Tech Stack:** TypeScript (ES2022, strict), React 19 (peer), `node:test` + `tsx` for Node tests, Next.js 15 + Tailwind v4 in the web shell, `tsc -b` build.

**Spec:** `docs/superpowers/specs/2026-09-23-msa-viewer-design.md` (executor: read the spec AND this plan).

## Global Constraints

- Work happens on branch `molstar-msa` (already created; the spec is committed as `7d96749`).
- Artifacts and commit messages are **English** (repo convention, `AGENTS.md`); conversation happens in Chinese.
- `@science-studio/msa-viewer` has **no runtime dependencies** except `react` (peer) and **no monorepo imports** and **no molstar**. Pure entries (`./formats`, `./stats`, `./mention`, `./grid`) must import cleanly under plain Node (`node --import tsx --test`) — no DOM globals at module top level.
- The root `workspaces` (`packages/*`) already absorb the new directory; `tsconfig.tests.json` already covers `packages/*/test/**` — neither needs editing unless tests drift.
- `npm run test --workspaces --if-present` (root) automatically includes the new package's `test` script; `npm run build` (root) is the real type gate and gains the new package in its chain (Task 6).
- **Renderer rule (from `AGENTS.md`):** a renderer inside an open-file tab must NEVER assert its own `visibility` — hidden tabs use `visibility:hidden` and a child's `visibility:visible` resurrects it above the active tab. Loading/error states go on overlays, never on the content element.
- Mentions are **plain composer text** (not a directive; the service lifts nothing into an `AttachmentRef`) — the same policy as structure mentions.
- Package components are React-only: inline `style` objects + a `className` prop for the host (web) to theme; no Tailwind imports inside the package, no `next` imports (the web shell loads `.` dynamically with `ssr:false`).
- `isTextEditable` excludes `"msa"` — MSA files have no source-view editor; the "Raw text" affordance lives in the renderer.
- No new service routes, no agent-side plugins, no record changes (the agent reads the alignment text from its own cwd).

## Review Focus

Inputs/failure modes the spec implies but no task's tests fully exercise — each line is pinned to the task that owns the behavior (tests for the pure parts ARE in those tasks; the UI parts are code-review points named here).

1. **Name says MSA, content isn't** (e.g. `notes.result` is actually prose, or a `report.fa` for another tool) → `sniffFormat` rejects and/or the parser throws a typed `MsaParseError`, and the UI shows a friendly error + "Open as plain text" — never a crash, never a blank pane. Pinned to Task 1 (pure rejection tests) + Task 6 (fallback render, code review).
2. **mmseqs `.result` exported with TABS**, and any of the 10/11/12-field shapes → parses identically to the space-separated form; a malformed row (<10 fields, non-numeric in a numeric slot) is a typed error, not `NaN` cells. Pinned to Task 1.
3. **CRLF + BOM** files (copied off a Windows box) and Clustal re-wrapped at a different width (multi-block) → parse identically to LF single-block. Pinned to Task 1.
4. **Alignment past 250 000 cells** (e.g. 1 000 seqs × 500 cols, mmseqs cluster output) → plain-text mode with a notice; the pane must stay responsive (no per-cell spans, no 1 M `<span>`). Pinned to Task 4 (`shouldUsePlainText`) + Task 7 manual smoke.
5. **Duplicate / degenerate names** (two records with the same name; an empty `>` header) → a typed error or a harmless duplicate row, no `NaN` in stats, no key collisions in the web table. Pinned to Task 1 (empty-name error test) + Task 5 (React keys include the index).

---

### Task 1: `msa-viewer` package skeleton + `./formats` (all parsers + sniffing + `isMsaFile`)

**Files:**
- Create: `packages/msa-viewer/package.json`
- Create: `packages/msa-viewer/tsconfig.json`
- Create: `packages/msa-viewer/src/index.ts`
- Create: `packages/msa-viewer/src/formats.ts`
- Test: `packages/msa-viewer/test/formats.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `isMsaFile(name: string): boolean`; `sniffFormat(text: string): MsaFormat | null`; `parseAlignment(text: string): MsaParseResult`; `class MsaParseError extends Error` (`.subject`, `.reason`); types `MsaSequence`, `MsaAnnotation`, `MsaAligned`, `MsaUnaligned`, `MmseqsResult`, `MsaParseResult`, `MsaFormat`. Later tasks build on `MsaParseResult`.

- [ ] **Step 1: Create the package scaffolding**

`packages/msa-viewer/package.json`:

```json
{
  "name": "@science-studio/msa-viewer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./formats": {
      "types": "./dist/formats.d.ts",
      "default": "./dist/formats.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit",
    "test": "node --import tsx --test test/*.test.ts"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0"
  }
}
```

`packages/msa-viewer/tsconfig.json` (mirrors `packages/molql-viewer/tsconfig.json`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

Add to `packages/msa-viewer/package.json` `exports` NOW for the entries this task's siblings will need (keep the map complete from the start so later tasks never edit it):

```json
    "./stats": {
      "types": "./dist/stats.d.ts",
      "default": "./dist/stats.js"
    },
    "./mention": {
      "types": "./dist/mention.d.ts",
      "default": "./dist/mention.js"
    },
    "./grid": {
      "types": "./dist/grid.d.ts",
      "default": "./dist/grid.js"
    }
```

- [ ] **Step 2: Link the workspace**

```bash
cd /home/zhonghua/workspace/science-studio
npm install
ls node_modules/@science-studio | grep msa
```

Expected: `msa-viewer` listed (symlink into the root `node_modules`).

- [ ] **Step 3: Write the failing tests**

`packages/msa-viewer/test/formats.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and watch them fail**

```bash
cd /home/zhonghua/workspace/science-studio
npm run test -w @science-studio/msa-viewer
```

Expected: FAIL — modules not found (`../src/formats.js` does not exist yet).

- [ ] **Step 5: Implement `src/formats.ts`**

```ts
/**
 * MSA format codec — pure, browser-free, Node-testable on purpose.
 *
 * Recognized content (sniff order, decided by the FIRST real content line):
 *   Stockholm    — `# STOCKHOLM` header, or any `#=GS` / `#=PC` line
 *   ClustalW     — a line starting with `CLUSTAL`
 *   FASTA        — a line starting with `>` (aligned: all equal length; else unaligned)
 *   mmseqs .result — ≥ 10 whitespace-separated fields with numeric fields 3..10
 *
 * Anything else throws MsaParseError — the renderer turns that into a friendly
 * plain-text fallback, never a crash.
 */

export interface MsaSequence {
  name: string;
  seq: string;
}

export interface MsaAnnotation {
  label: string;
  chars: string;
}

export interface MsaAligned {
  kind: "aligned";
  sequences: MsaSequence[];
  columns: number;
  annotations: MsaAnnotation[];
}

export interface MsaUnaligned {
  kind: "unaligned";
  sequences: MsaSequence[];
}

export interface MmseqsResult {
  kind: "mmseqs";
  /** Canonical field order, one entry per column the file actually carries (10–12). */
  fields: string[];
  rows: (string | number)[][];
}

export type MsaParseResult = MsaAligned | MsaUnaligned | MmseqsResult;

export type MsaFormat = "clustalw" | "stockholm" | "fasta" | "mmseqs";

export class MsaParseError extends Error {
  constructor(
    readonly subject: string,
    readonly reason: string,
  ) {
    super(`Cannot parse "${subject}": ${reason}`);
    this.name = "MsaParseError";
  }
}

const MSA_SUFFIXES = [
  ".clustal",
  ".clustal.om",
  ".sto",
  ".stockholm",
  ".fasta",
  ".fa",
  ".faa",
  ".fna",
  ".aln",
  ".result",
  "_result",
] as const;

/** True when the file name looks like a recognized alignment/search-result file (case-insensitive). */
export function isMsaFile(name: string): boolean {
  const lower = name.toLowerCase();
  return MSA_SUFFIXES.some((s) => lower.endsWith(s));
}

function normalize(text: string): string {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return t.replace(/\r\n?/g, "\n");
}

function contentLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "");
}

export function sniffFormat(text: string): MsaFormat | null {
  for (const raw of contentLines(text)) {
    const t = raw.trim();
    if (/^#\s*STOCKHOLM/i.test(t) || t.startsWith("#=GS") || t.startsWith("#=PC")) return "stockholm";
    if (t.startsWith("#")) continue; // comment (mmseqs output may carry one) — not a decision line
    if (/^CLUSTAL\b/i.test(t)) return "clustalw";
    if (t.startsWith(">")) return "fasta";
    const fields = t.split(/\s+/);
    if (fields.length >= 10 && fields.slice(2, 10).every((f) => f !== "" && !Number.isNaN(Number(f)))) {
      return "mmseqs";
    }
    return null; // the first real content line decides
  }
  return null;
}

export function parseAlignment(text: string): MsaParseResult {
  const clean = normalize(text);
  if (clean.trim() === "") {
    throw new MsaParseError(text.slice(0, 48) || "<empty>", "the file is empty");
  }
  const fmt = sniffFormat(clean);
  if (fmt === null) {
    throw new MsaParseError(text.slice(0, 48) || "<unknown>", "no recognized alignment format");
  }
  switch (fmt) {
    case "stockholm":
      return parseStockholm(clean);
    case "clustalw":
      return parseClustal(clean);
    case "fasta":
      return parseFasta(clean);
    case "mmseqs":
      return parseMmseqs(clean);
  }
}

function alignOrUnalign(
  names: string[],
  chunks: Map<string, string>,
  annotations: MsaAnnotation[] = [],
): MsaAligned | MsaUnaligned {
  if (names.length === 0) throw new MsaParseError("<none>", "no sequences found");
  const firstLen = chunks.get(names[0]!)?.length ?? 0;
  if (names.every((n) => (chunks.get(n) ?? "").length === firstLen && firstLen > 0)) {
    return {
      kind: "aligned",
      sequences: names.map((n) => ({ name: n, seq: chunks.get(n) ?? "" })),
      columns: firstLen,
      annotations,
    };
  }
  // Uneven lengths: still renderable as rows — degrade instead of crashing.
  return { kind: "unaligned", sequences: names.map((n) => ({ name: n, seq: chunks.get(n) ?? "" })) };
}

function parseClustal(raw: string): MsaParseResult {
  const names: string[] = [];
  const chunks = new Map<string, string>();
  const annotations: MsaAnnotation[] = [];
  let blockConsensus: string | null = null;

  const flushBlock = (): void => {
    if (blockConsensus !== null && blockConsensus !== "") {
      annotations.push({ label: "consensus", chars: blockConsensus });
    }
    blockConsensus = null;
  };

  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      flushBlock();
      continue;
    }
    if (/^CLUSTAL\b/i.test(line)) continue;
    const first = line[0];
    if (first === undefined || first === " " || first === "*") {
      // A consensus/comment line starts at indent 0 with `* : . -` symbols (a name
      // starts at column 0 with a letter/digit). Anything else here is garbage.
      if (!/^[*.: \-]+$/.test(line)) {
        throw new MsaParseError("clustalw", `unrecognized line: ${line.trim().slice(0, 40)}`);
      }
      blockConsensus = (blockConsensus ?? "") + line.trim();
      continue;
    }
    const m = line.match(/^\s*([^\s]+)\s+([A-Za-z\-*.:_]+)\s*$/);
    if (!m) {
      throw new MsaParseError("clustalw", `sequence line does not parse: ${line.trim().slice(0, 40)}`);
    }
    const name = m[1]!;
    const seq = m[2]!;
    if (!chunks.has(name)) {
      chunks.set(name, "");
      names.push(name);
    }
    chunks.set(name, (chunks.get(name) ?? "") + seq);
  }
  flushBlock();
  return alignOrUnalign(names, chunks, annotations);
}

function parseStockholm(raw: string): MsaParseResult {
  const names: string[] = [];
  const seqs = new Map<string, string>();
  const annotations: MsaAnnotation[] = [];

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (/^#\s*STOCKHOLM/i.test(t)) continue;
    if (t === "//") break;
    if (t.startsWith("#=GS")) {
      const parts = t.split(/\s+/);
      // `#=GS <seq_id> <tag> <value...>` — the seq id is the FIRST token; v1 keeps
      // the name only (tags/values are dropped by design)
      const name = parts[1];
      if (name !== undefined && !names.includes(name) && !seqs.has(name)) names.push(name);
      continue;
    }
    if (t.startsWith("#=PC")) {
      const parts = t.split(/\s+/);
      // `#=PC <label> <chars...>`
      annotations.push({ label: parts[1] ?? "annot", chars: parts.slice(2).join("") });
      continue;
    }
    if (t.startsWith("#")) continue; // other annotation kinds: ignored in v1
    const m = t.match(/^([^\s]+)\s+([^\s]+)$/);
    if (!m) {
      throw new MsaParseError("stockholm", `sequence line does not parse: ${t.slice(0, 40)}`);
    }
    const name = m[1]!;
    const seq = m[2]!;
    if (!seqs.has(name)) {
      seqs.set(name, "");
      if (!names.includes(name)) names.push(name);
    }
    seqs.set(name, (seqs.get(name) ?? "") + seq);
  }
  return alignOrUnalign(names, seqs, annotations);
}

function parseFasta(raw: string): MsaParseResult {
  const names: string[] = [];
  const chunks = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (t.startsWith(">")) {
      const name = t.slice(1).trim().split(/\s+/)[0] ?? "";
      if (name === "") throw new MsaParseError("fasta", "a record header has no name");
      if (!chunks.has(name)) {
        chunks.set(name, "");
        names.push(name);
      }
      continue;
    }
    if (chunks.size === 0) {
      throw new MsaParseError("fasta", "sequence data before any '>' record header");
    }
    const name = names[names.length - 1]!;
    chunks.set(name, (chunks.get(name) ?? "") + t);
  }
  return alignOrUnalign(names, chunks);
}

const MMSEQS_FIELDS = [
  "query",
  "target",
  "length",
  "id",
  "gapopen",
  "qstart",
  "qend",
  "tstart",
  "tend",
  "evalue",
  "score",
  "alignment",
] as const;

function parseMmseqs(raw: string): MmseqsResult {
  const rows: (string | number)[][] = [];
  let maxFields = 10;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const fields = t.split(/\s+/);
    if (fields.length < 10) {
      throw new MsaParseError("mmseqs", `row has ${fields.length} fields (needs 10+): ${t.slice(0, 48)}`);
    }
    if (fields.length > 12) {
      throw new MsaParseError("mmseqs", `row has ${fields.length} fields (max 12): ${t.slice(0, 48)}`);
    }
    const row: (string | number)[] = [fields[0]!, fields[1]!];
    for (let i = 2; i <= 9; i++) {
      const f = fields[i]!;
      const n = Number(f);
      if (!Number.isFinite(n)) {
        throw new MsaParseError("mmseqs", `field ${i + 1} is not numeric: "${f}"`);
      }
      row.push(n);
    }
    if (fields.length === 11) {
      const f = fields[10]!;
      const n = Number(f);
      row.push(Number.isFinite(n) ? n : f);
      maxFields = 11;
    } else if (fields.length === 12) {
      const f11 = fields[10]!;
      const n11 = Number(f11);
      row.push(Number.isFinite(n11) ? n11 : f11, fields[11]!);
      maxFields = 12;
    }
    rows.push(row);
  }
  if (rows.length === 0) throw new MsaParseError("mmseqs", "no result rows found");
  return { kind: "mmseqs", fields: [...MMSEQS_FIELDS].slice(0, maxFields), rows };
}
```

- [ ] **Step 6: Create `src/index.ts` (formats only for now; later tasks add exports)**

```tsx
"use client";

export {
  isMsaFile,
  parseAlignment,
  sniffFormat,
  MsaParseError,
  type MsaAnnotation,
  type MsaAligned,
  type MsaFormat,
  type MsaParseResult,
  type MsaSequence,
  type MsaUnaligned,
  type MmseqsResult,
} from "./formats.js";
```

- [ ] **Step 7: Run the tests and build — both green**

```bash
cd /home/zhonghua/workspace/science-studio
npm run test -w @science-studio/msa-viewer
npm run build -w @science-studio/msa-viewer
```

Expected: all tests PASS; `tsc -b` emits `dist/` cleanly.

- [ ] **Step 8: Commit**

```bash
git add packages/msa-viewer
git commit -m "feat(msa-viewer): package skeleton + format parsers (Clustal/Stockholm/FASTA/mmseqs)"
```

---

### Task 2: `./stats` (column/sequence/table statistics + conservation predicate)

**Files:**
- Create: `packages/msa-viewer/src/stats.ts`
- Modify: `packages/msa-viewer/src/index.ts`
- Test: `packages/msa-viewer/test/stats.test.ts`

**Interfaces:**
- Consumes: `MsaParseResult` from `./formats.js` (Task 1).
- Produces: `columnStats(result): ColumnStat[]`, `sequenceStats(result): SequenceStat[]`, `tableStats(result, opts?): TableStat`, `isConservedCol(stat, opts?): boolean`, `DEFAULT_CONSERVED`; types `ColumnStat`, `SequenceStat`, `TableStat`, `ConservedOptions`.

- [ ] **Step 1: Write the failing tests**

`packages/msa-viewer/test/stats.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONSERVED,
  columnStats,
  isConservedCol,
  sequenceStats,
  tableStats,
} from "../src/stats.js";
import type { MsaAligned } from "../src/formats.js";

const ALIGNED: MsaAligned = {
  kind: "aligned",
  sequences: [
    { name: "a", seq: "MK--" },
    { name: "b", seq: "MK-M" },
    { name: "c", seq: "MKMM" },
  ],
  columns: 4,
  annotations: [],
};

test("columnStats: identity = share of the most frequent non-gap char; gapFraction = share of gaps", () => {
  const stats = columnStats(ALIGNED);
  assert.equal(stats.length, 4);
  assert.equal(stats[0]!.identity, 1);   // col 1: M,M,M
  assert.equal(stats[0]!.gapFraction, 0);
  assert.equal(stats[1]!.identity, 1);   // col 2: K,K,K
  assert.equal(stats[1]!.gapFraction, 0);
  assert.equal(stats[2]!.identity, 1 / 3); // col 3: -,-,M
  assert.equal(stats[2]!.gapFraction, 2 / 3);
  assert.equal(stats[3]!.gapFraction, 1 / 3); // col 4: -,M,M
  assert.equal(stats[3]!.identity, 2 / 3);
});

test("isConservedCol: defaults and overrides", () => {
  assert.equal(isConservedCol(stats0()), true);
  assert.equal(isConservedCol({ column: 3, identity: 1 / 3, gapFraction: 2 / 3 }), false);
  assert.equal(
    isConservedCol({ column: 2, identity: 1 / 3, gapFraction: 0 }, { minIdentity: 0.2, maxGapFraction: 1 }),
    true,
  );
});

function stats0() {
  return columnStats(ALIGNED)[0]!;
}

test("sequenceStats: length + gapFraction per sequence", () => {
  const ss = sequenceStats(ALIGNED);
  assert.deepEqual(ss, [
    { name: "a", length: 4, gapFraction: 0.5 }, // "MK--"
    { name: "b", length: 4, gapFraction: 0.25 }, // "MK-M"
    { name: "c", length: 4, gapFraction: 0 }, // "MKMM"
  ]);
});

test("stats are total over every MsaParseResult shape", () => {
  const mmseqs = { kind: "mmseqs" as const, fields: ["query", "target"], rows: [[ "a", "b" ]] };
  assert.deepEqual(columnStats(mmseqs), []);
  assert.deepEqual(sequenceStats(mmseqs), []);
  const t0 = tableStats(mmseqs);
  assert.equal(t0.sequences, 0);
  const unaligned = { kind: "unaligned" as const, sequences: [{ name: "x", seq: "ABC" }] };
  assert.deepEqual(sequenceStats(unaligned)[0], { name: "x", length: 3, gapFraction: 0 });
});

test("tableStats: averages + conserved count use the same predicate", () => {
  const t = tableStats(ALIGNED);
  assert.equal(t.sequences, 3);
  assert.equal(t.columns, 4);
  assert.equal(t.averageIdentity, (1 + 1 + 1 / 3 + 2 / 3) / 4); // = 0.75
  assert.equal(t.conservedColumns, 2); // cols 1 and 2 (identity 1.0, gaps 0)
  assert.deepEqual(DEFAULT_CONSERVED, { minIdentity: 0.9, maxGapFraction: 0.1 });
});
```

- [ ] **Step 2: Run — expect FAIL** (`./stats.js` not found)

```bash
npm run test -w @science-studio/msa-viewer
```

- [ ] **Step 3: Implement `src/stats.ts`**

```ts
import type { MsaParseResult } from "./formats.js";

export interface ColumnStat {
  /** 1-based column index. */
  column: number;
  /** Share of ALL sequences occupied by the most frequent non-gap character. */
  identity: number;
  /** Share of sequences carrying a gap (`-`) in this column. */
  gapFraction: number;
}

export interface SequenceStat {
  name: string;
  length: number;
  gapFraction: number;
}

export interface TableStat {
  sequences: number;
  columns: number;
  averageIdentity: number;
  conservedColumns: number;
}

export interface ConservedOptions {
  minIdentity: number;
  maxGapFraction: number;
}

export const DEFAULT_CONSERVED: ConservedOptions = { minIdentity: 0.9, maxGapFraction: 0.1 };

function gapCount(seq: string): number {
  return seq.split("-").length - 1;
}

export function columnStats(result: MsaParseResult): ColumnStat[] {
  if (result.kind !== "aligned" || result.sequences.length === 0) return [];
  const out: ColumnStat[] = [];
  for (let c = 0; c < result.columns; c++) {
    const counts = new Map<string, number>();
    let max = 0;
    let gaps = 0;
    for (const s of result.sequences) {
      const ch = s.seq[c];
      if (ch === undefined || ch === "-") {
        gaps++;
        continue;
      }
      const n = (counts.get(ch) ?? 0) + 1;
      counts.set(ch, n);
      if (n > max) max = n;
    }
    const total = result.sequences.length;
    out.push({
      column: c + 1,
      identity: total > 0 ? max / total : 0,
      gapFraction: total > 0 ? gaps / total : 0,
    });
  }
  return out;
}

export function sequenceStats(result: MsaParseResult): SequenceStat[] {
  if (result.kind === "mmseqs") return [];
  return result.sequences.map((s) => ({
    name: s.name,
    length: s.seq.length,
    gapFraction: s.seq.length > 0 ? gapCount(s.seq) / s.seq.length : 0,
  }));
}

export function isConservedCol(stat: ColumnStat, opts: ConservedOptions = DEFAULT_CONSERVED): boolean {
  return stat.identity >= opts.minIdentity && stat.gapFraction <= opts.maxGapFraction;
}

export function tableStats(result: MsaParseResult, opts: ConservedOptions = DEFAULT_CONSERVED): TableStat {
  if (result.kind !== "aligned") {
    return { sequences: 0, columns: 0, averageIdentity: 0, conservedColumns: 0 };
  }
  const cols = columnStats(result);
  const averageIdentity = cols.length > 0 ? cols.reduce((a, c) => a + c.identity, 0) / cols.length : 0;
  return {
    sequences: result.sequences.length,
    columns: result.columns,
    averageIdentity,
    conservedColumns: cols.filter((c) => isConservedCol(c, opts)).length,
  };
}
```

- [ ] **Step 4: Extend `src/index.ts`** — add this block after the formats export:

```tsx
export {
  DEFAULT_CONSERVED,
  columnStats,
  isConservedCol,
  sequenceStats,
  tableStats,
  type ColumnStat,
  type ConservedOptions,
  type SequenceStat,
  type TableStat,
} from "./stats.js";
```

- [ ] **Step 5: Tests + build green**

```bash
npm run test -w @science-studio/msa-viewer
npm run build -w @science-studio/msa-viewer
```

- [ ] **Step 6: Commit**

```bash
git add packages/msa-viewer/src/stats.ts packages/msa-viewer/src/index.ts packages/msa-viewer/test/stats.test.ts
git commit -m "feat(msa-viewer): column/sequence/table statistics and the conserved-column predicate"
```

---

### Task 3: `./mention` (format / parse / key for `@<project>/<path>/<seqName>@<col>`)

**Files:**
- Create: `packages/msa-viewer/src/mention.ts`
- Modify: `packages/msa-viewer/src/index.ts`
- Test: `packages/msa-viewer/test/mention.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent module).
- Produces: `MsaTarget {seqName, start, end}` (1-based, inclusive), `formatMsaMention(project, path, target): string`, `parseMsaMention(text): ParsedMsaMention`, `msaMentionKey(target): string`, `class MsaMentionError`. The web renderer (Task 6) and the React components (Task 5) import `MsaTarget` + `msaMentionKey`/`formatMsaMention`.

- [ ] **Step 1: Write the failing tests**

`packages/msa-viewer/test/mention.test.ts`:

```ts
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
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

```bash
npm run test -w @science-studio/msa-viewer
```

- [ ] **Step 3: Implement `src/mention.ts`**

```ts
/**
 * The MSA viewer-mention codec — the same plain-text shape the structure mentions
 * use (`@<project>/<path>/<expression>`): `@<project>/<path>/<seqName>@<col>` or
 * `@.../<seqName>@<start>-<end>`. A trailing ` #label` (structure convention) is
 * stripped before parsing. Pure + total: malformed input is a typed error, never
 * a partial object.
 */

export interface MsaTarget {
  seqName: string;
  /** 1-based inclusive start column (or 1 for a whole-sequence mention). */
  start: number;
  /** 1-based inclusive end column (>= start). */
  end: number;
}

export interface ParsedMsaMention {
  project: string;
  path: string;
  target: MsaTarget;
}

export class MsaMentionError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid MSA mention: ${reason}`);
    this.name = "MsaMentionError";
  }
}

export function formatMsaMention(project: string, path: string, target: MsaTarget): string {
  if (project === "") throw new MsaMentionError("project is required");
  if (path === "") throw new MsaMentionError("path is required");
  if (target.seqName === "") throw new MsaMentionError("seqName is required");
  if (!Number.isInteger(target.start) || target.start < 1) {
    throw new MsaMentionError("start must be a positive integer");
  }
  if (!Number.isInteger(target.end) || target.end < target.start) {
    throw new MsaMentionError("end must be an integer >= start");
  }
  const pos = target.end === target.start ? String(target.start) : `${target.start}-${target.end}`;
  return `@${project}/${path}/${target.seqName}@${pos}`;
}

export function parseMsaMention(text: string): ParsedMsaMention {
  let body = text.trim();
  if (!body.startsWith("@")) throw new MsaMentionError("the mention must start with '@'");
  const label = body.indexOf(" #");
  if (label !== -1) body = body.slice(0, label); // trailing " #label" (structure-mention convention)
  const rest = body.slice(1);
  const firstSlash = rest.indexOf("/");
  if (firstSlash === -1) throw new MsaMentionError("missing project");
  const project = rest.slice(0, firstSlash);
  if (project === "") throw new MsaMentionError("project must not be empty");
  const tail = rest.slice(firstSlash + 1);
  const lastSlash = tail.lastIndexOf("/");
  if (lastSlash === -1) throw new MsaMentionError("missing path");
  const path = tail.slice(0, lastSlash);
  if (path === "") throw new MsaMentionError("path must not be empty");
  const sel = tail.slice(lastSlash + 1);
  const at = sel.indexOf("@");
  if (at === -1) throw new MsaMentionError("missing column position");
  const seqName = sel.slice(0, at);
  if (seqName === "") throw new MsaMentionError("seqName must not be empty");
  const m = sel.slice(at + 1).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new MsaMentionError(`column position must be N or N-M`);
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (end < start) throw new MsaMentionError("end must be >= start");
  return { project, path, target: { seqName, start, end } };
}

export function msaMentionKey(target: MsaTarget): string {
  return `${target.seqName}@${target.start}-${target.end}`;
}
```

- [ ] **Step 4: Extend `src/index.ts`** — add after the stats block:

```tsx
export {
  MsaMentionError,
  formatMsaMention,
  msaMentionKey,
  parseMsaMention,
  type MsaTarget,
  type ParsedMsaMention,
} from "./mention.js";
```

- [ ] **Step 5: Tests + build green**

```bash
npm run test -w @science-studio/msa-viewer
npm run build -w @science-studio/msa-viewer
```

- [ ] **Step 6: Commit**

```bash
git add packages/msa-viewer/src/mention.ts packages/msa-viewer/src/index.ts packages/msa-viewer/test/mention.test.ts
git commit -m "feat(msa-viewer): the viewer-mention codec (@project/path/seqName@col, label-tolerant)"
```

---

### Task 4: `./grid` (pure grid math: windowing, span grouping, ruler, band scale, filters)

**Files:**
- Create: `packages/msa-viewer/src/grid.ts`
- Modify: `packages/msa-viewer/src/index.ts`
- Test: `packages/msa-viewer/test/grid.test.ts`

**Interfaces:**
- Consumes: `MsaSequence` from `./formats.js` (Task 1); `ColumnStat` / `isConservedCol` / `ConservedOptions` from `./stats.js` (Task 2).
- Produces: `rowWindow(totalRows, scrollTop, viewportHeight, rowHeight, overscan?): RowWindow`; `groupSpans(text, classify): Span[]`; `rulerLabel(c): string`; `rulerLine(columns, keep?): string`; `conservationBandColor(identity, gapFraction): string`; `shouldUsePlainText(rows, cols, limit?): boolean`; `PLAIN_TEXT_CELL_LIMIT`; `filterRowsByQuery(seqs, query): MsaSequence[]`; `columnsToKeep(columns, seqs, stats, filter, conservedOpts?): number[]`; types `Span`, `RowWindow`, `ColumnFilter`.

- [ ] **Step 1: Write the failing tests**

`packages/msa-viewer/test/grid.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAIN_TEXT_CELL_LIMIT,
  columnsToKeep,
  conservationBandColor,
  filterRowsByQuery,
  groupSpans,
  rowWindow,
  rulerLabel,
  rulerLine,
  shouldUsePlainText,
} from "../src/grid.js";

test("rowWindow: overscan, clamping, and scroll position", () => {
  assert.deepEqual(rowWindow(100, 0, 400, 20, 4), { start: 0, count: 28 });
  assert.deepEqual(rowWindow(100, 1000, 400, 20, 4), { start: 46, count: 28 });
  assert.deepEqual(rowWindow(5, 1000, 400, 20, 4), { start: 5, count: 0 }); // past the end
  assert.deepEqual(rowWindow(0, 0, 400, 20), { start: 0, count: 0 });
  assert.deepEqual(rowWindow(10, 0, 40, 20, 4), { start: 0, count: 10 }); // clamped to total
});

test("groupSpans merges consecutive same-class runs, minimum run 1", () => {
  const text = "aabaa";
  const spans = groupSpans(text, (i) => (text.charAt(i) === "b" ? "Y" : "X"));
  assert.deepEqual(spans, [
    { text: "aa", cls: "X" },
    { text: "b", cls: "Y" },
    { text: "aa", cls: "X" },
  ]);
  assert.deepEqual(groupSpans("", () => "X"), []);
});

test("ruler: the 1..9/0 cycle with the hundreds digit every 100", () => {
  assert.equal(rulerLabel(1), "1");
  assert.equal(rulerLabel(9), "9");
  assert.equal(rulerLabel(10), "0");
  assert.equal(rulerLabel(15), "5");
  assert.equal(rulerLabel(100), "1");
  assert.equal(rulerLabel(200), "2");
  assert.equal(rulerLine(12), "123456789012");
});

test("rulerLine blanks the dropped (filtered-out) columns but keeps their width", () => {
  const keep = new Set([0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]); // the 4th column (1-based) dropped
  assert.equal(rulerLine(12, keep), "123\u00A056789012");
});

test("conservationBandColor: identity scale, gap-heavy override, clamped input", () => {
  assert.equal(conservationBandColor(1, 0), "#c92a2a");
  assert.equal(conservationBandColor(0.95, 0), "#e8590c");
  assert.equal(conservationBandColor(0.75, 0.2), "#facc15");
  assert.equal(conservationBandColor(0.85, 0.2), "#f59f00");
  assert.equal(conservationBandColor(0.75, 0.8), "#8b8f96"); // gap-heavy wins
  assert.equal(conservationBandColor(0.1, 0), "#cbd5e1");
  assert.equal(conservationBandColor(1.7, -1), "#c92a2a");   // inputs are clamped
});

test("shouldUsePlainText: the 250k-cell guard (and a custom limit)", () => {
  assert.equal(PLAIN_TEXT_CELL_LIMIT, 250_000);
  assert.equal(shouldUsePlainText(1000, 300), true);      // 300k > 250k
  assert.equal(shouldUsePlainText(100, 1000), false);     // 100k
  assert.equal(shouldUsePlainText(250, 1000), false);     // exactly 250k is still fine
  assert.equal(shouldUsePlainText(10, 11, 100), true);    // 110 > 100
  assert.equal(shouldUsePlainText(10, 10, 100), false);   // exactly 100 is still fine
  assert.equal(shouldUsePlainText(0, 5), false);          // degenerate input
});

test("filterRowsByQuery: case-insensitive name substring; empty query is identity", () => {
  const seqs = [
    { name: "Seq1", seq: "ABC" },
    { name: "myseq2", seq: "DEF" },
  ];
  assert.equal(filterRowsByQuery(seqs, ""), seqs);
  assert.deepEqual(filterRowsByQuery(seqs, "SEQ").map((s) => s.name), ["Seq1", "myseq2"]);
  assert.deepEqual(filterRowsByQuery(seqs, "  seq2  ").map((s) => s.name), ["myseq2"]);
});

test("columnsToKeep: conserved-only and hide-gaps, over the ORIGINAL columns", () => {
  const seqs = [
    { name: "a", seq: "A--B" },
    { name: "b", seq: "CD--" },
  ];
  // col1 (A,C): identity .5, gap 0 · col2 (-,D): identity .5, gap .5
  // col3 (-,-): identity 0,  gap 1 · col4 (B,-): identity .5, gap .5
  const stats = [
    { column: 1, identity: 0.5, gapFraction: 0 },
    { column: 2, identity: 0.5, gapFraction: 0.5 },
    { column: 3, identity: 0, gapFraction: 1 },
    { column: 4, identity: 0.5, gapFraction: 0.5 },
  ];
  // hideGaps drops only the ALL-gap column (1-based col 3)
  assert.deepEqual(columnsToKeep(4, seqs, stats, { hideGaps: true }), [0, 1, 3]);
  // conservedOnly keeps exactly the columns that pass the (parameterized) predicate
  assert.deepEqual(
    columnsToKeep(4, seqs, stats, { conservedOnly: true }, { minIdentity: 0.5, maxGapFraction: 0.5 }),
    [0, 1, 3],
  );
  // a stricter gap predicate drops the half-gap columns too
  assert.deepEqual(
    columnsToKeep(4, seqs, stats, { conservedOnly: true }, { minIdentity: 0.5, maxGapFraction: 0.4 }),
    [0],
  );
  // no filter keeps everything
  assert.deepEqual(columnsToKeep(4, seqs, stats, {}), [0, 1, 2, 3]);
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

```bash
npm run test -w @science-studio/msa-viewer
```

- [ ] **Step 3: Implement `src/grid.ts`**

```ts
import type { MsaSequence } from "./formats.js";
import { isConservedCol, type ColumnStat, type ConservedOptions } from "./stats.js";

export interface Span {
  text: string;
  cls: string;
}

export interface RowWindow {
  start: number;
  count: number;
}

/** The (inclusive) window of rows to render: visible plus overscan, clamped. */
export function rowWindow(
  totalRows: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscanRows: number = 4,
): RowWindow {
  if (totalRows <= 0 || rowHeight <= 0) return { start: 0, count: 0 };
  let start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows);
  if (start > totalRows) start = totalRows;
  const count = Math.min(totalRows - start, Math.ceil(viewportHeight / rowHeight) + overscanRows * 2);
  return { start, count: Math.max(0, count) };
}

/** Merge consecutive same-class characters into runs (minimum run length 1). */
export function groupSpans(text: string, classify: (index: number) => string): Span[] {
  const out: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const cls = classify(i);
    let j = i + 1;
    while (j < text.length && classify(j) === cls) j++;
    out.push({ text: text.slice(i, j), cls });
    i = j;
  }
  return out;
}

/** Classic alignment ruler: the 1..9/0 cycle, with the hundreds digit (always one char) every 100 columns. */
export function rulerLabel(column: number): string {
  if (column <= 0) return " ";
  if (column % 100 === 0) return String((column / 100) % 10);
  return String(column % 10);
}

/** The ruler string over `columns`; dropped columns keep their width but lose their label. */
export function rulerLine(columns: number, keep?: ReadonlySet<number>): string {
  let out = "";
  for (let c = 0; c < columns; c++) {
    if (keep !== undefined && !keep.has(c)) out += "\u00A0";
    else out += rulerLabel(c + 1);
  }
  return out;
}

/** Deterministic identity → color scale (red = conserved → gray = variable). */
export function conservationBandColor(identity: number, gapFraction: number): string {
  if (gapFraction >= 0.5) return "#8b8f96"; // gap-heavy column: neutral
  const v = Math.max(0, Math.min(1, identity));
  if (v >= 0.99) return "#c92a2a";
  if (v >= 0.9) return "#e8590c";
  if (v >= 0.8) return "#f59f00";
  if (v >= 0.7) return "#facc15";
  if (v >= 0.5) return "#94a3b8";
  return "#cbd5e1";
}

export const PLAIN_TEXT_CELL_LIMIT = 250_000;

/** Above this many cells the grid auto-degrades to plain text (spec scale guard). */
export function shouldUsePlainText(
  rowCount: number,
  columns: number,
  limit: number = PLAIN_TEXT_CELL_LIMIT,
): boolean {
  return rowCount > 0 && columns > 0 && rowCount * columns > limit;
}

export function filterRowsByQuery(sequences: MsaSequence[], query: string): MsaSequence[] {
  const q = query.trim().toLowerCase();
  if (q === "") return sequences;
  return sequences.filter((s) => s.name.toLowerCase().includes(q));
}

export interface ColumnFilter {
  conservedOnly?: boolean;
  hideGaps?: boolean;
}

/** The ORIGINAL 0-based column indices that survive the filters, in order. */
export function columnsToKeep(
  columns: number,
  seqs: MsaSequence[],
  stats: ColumnStat[],
  filter: ColumnFilter,
  conservedOpts?: ConservedOptions,
): number[] {
  const keep: number[] = [];
  for (let c = 0; c < columns; c++) {
    const st = stats[c];
    if (filter.conservedOnly && (st === undefined || !isConservedCol(st, conservedOpts))) continue;
    if (filter.hideGaps && seqs.length > 0 && seqs.every((s) => s.seq[c] === "-")) continue;
    keep.push(c);
  }
  return keep;
}
```

- [ ] **Step 4: Extend `src/index.ts`** — add after the mention block:

```tsx
export {
  PLAIN_TEXT_CELL_LIMIT,
  columnsToKeep,
  conservationBandColor,
  filterRowsByQuery,
  groupSpans,
  rowWindow,
  rulerLabel,
  rulerLine,
  shouldUsePlainText,
  type ColumnFilter,
  type RowWindow,
  type Span,
} from "./grid.js";
```

- [ ] **Step 5: Tests + build green**

```bash
npm run test -w @science-studio/msa-viewer
npm run build -w @science-studio/msa-viewer
```

- [ ] **Step 6: Commit**

```bash
git add packages/msa-viewer/src/grid.ts packages/msa-viewer/src/index.ts packages/msa-viewer/test/grid.test.ts
git commit -m "feat(msa-viewer): grid math — row windowing, span grouping, ruler, band scale, filters"
```

---

### Task 5: React components (`MsaGrid`, `MsaResultTable`, `UnalignedList`) + `index` completion

**Files:**
- Create: `packages/msa-viewer/src/react/MsaGrid.tsx`
- Create: `packages/msa-viewer/src/react/MsaResultTable.tsx`
- Create: `packages/msa-viewer/src/react/UnalignedList.tsx`
- Modify: `packages/msa-viewer/src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–4 (all of `./formats`, `./stats`, `./mention`, `./grid`).
- Produces: `MsaGrid({ data: MsaAligned, className?, onMention? })`, `MsaResultTable({ data: MmseqsResult, className? })`, `UnalignedList({ data: MsaUnaligned, className?, onMention? })`, with `onMention?: (target: MsaTarget) => void` — the host (Task 6) decides insert-vs-remove via its mention key; the grid only reports (re-)activation.

**Test note (Review Focus #4/#5):** the components are thin views over the Task-4 pure functions, so they carry no Node tests — the same precedent as `packages/molql-viewer/src/react/` (only pure modules are tested there). They are gated by the package build (typecheck), the web `tsc --noEmit`, and the Task-7 manual smoke. React keys ALWAYS include the row index (duplicate names must not collide).

- [ ] **Step 1: Write `src/react/MsaGrid.tsx`**

```tsx
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { MsaAligned } from "../formats.js";
import { DEFAULT_CONSERVED, columnStats, isConservedCol, tableStats } from "../stats.js";
import type { MsaTarget } from "../mention.js";
import {
  PLAIN_TEXT_CELL_LIMIT,
  columnsToKeep,
  conservationBandColor,
  filterRowsByQuery,
  groupSpans,
  rowWindow,
  rulerLine,
  shouldUsePlainText,
} from "../grid.js";

const ROW_HEIGHT = 20;
const OVERSCAN = 4;
const NAME_WIDTH = 168; // px
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

type CellClass = "seq" | "gap" | "conserved" | "selected" | "hoverCell" | "hoverRow" | "hoverCol";

const CELL_COLOR: Partial<Record<CellClass, string>> = {
  gap: "#9aa0a6",
  conserved: "#e8590c",
  selected: "#1d4ed8",
  hoverCell: "#7c3aed",
  hoverRow: "#475569",
  hoverCol: "#475569",
};
const CELL_BG: Partial<Record<CellClass, string>> = {
  selected: "#dbeafe",
  hoverCell: "#ede9fe",
  hoverRow: "#f1f5f9",
  hoverCol: "#f8fafc",
};

export interface MsaGridProps {
  data: MsaAligned;
  className?: string;
  /** Double-click (or a run) reports the target back; the host toggles the mention. */
  onMention?: (target: MsaTarget) => void;
}

interface Drag {
  seqName: string;
  anchor: number; // 0-based ORIGINAL column index
}

export function MsaGrid({ data, className, onMention }: MsaGridProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [hover, setHover] = useState<{ row: string; col: number } | null>(null);
  const [selection, setSelection] = useState<MsaTarget | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [query, setQuery] = useState("");
  const [conservedOnly, setConservedOnly] = useState(false);
  const [hideGaps, setHideGaps] = useState(false);
  const [showBand, setShowBand] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const charProbeRef = useRef<HTMLSpanElement | null>(null);
  const [charWidth, setCharWidth] = useState(7.2);

  // Measure one character so column hit-testing matches the rendered grid.
  useLayoutEffect(() => {
    const el = charProbeRef.current;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    if (width > 0) setCharWidth(width / 10);
  });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = (): void => setViewport(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (drag === null) return;
    const finish = (): void => setDrag(null);
    window.addEventListener("mouseup", finish);
    return () => window.removeEventListener("mouseup", finish);
  }, [drag]);

  const colStats = useMemo(() => columnStats(data), [data]);
  const rows = useMemo(() => filterRowsByQuery(data.sequences, query), [data.sequences, query]);
  const keep = useMemo(
    () => columnsToKeep(data.columns, data.sequences, colStats, { conservedOnly, hideGaps }, DEFAULT_CONSERVED),
    [data.columns, data.sequences, colStats, conservedOnly, hideGaps],
  );
  const keepSet = useMemo(() => new Set(keep), [keep]);
  const table = useMemo(() => tableStats(data), [data]);
  const plain = shouldUsePlainText(data.sequences.length, data.columns);

  const windowed = rowWindow(rows.length, scrollTop, viewport > 0 ? viewport : 480, ROW_HEIGHT, OVERSCAN);
  const visible = rows.slice(windowed.start, windowed.start + windowed.count);

  const inSelection = useCallback(
    (seqName: string, col: number) =>
      selection !== null &&
      selection.seqName === seqName &&
      col >= selection.start - 1 &&
      col <= selection.end - 1,
    [selection],
  );

  const cellClass = (char: string, seqName: string, col: number): CellClass => {
    if (inSelection(seqName, col)) return "selected";
    if (hover !== null) {
      if (hover.row === seqName && hover.col === col) return "hoverCell";
      if (hover.row === seqName) return "hoverRow";
      if (hover.col === col) return "hoverCol";
    }
    if (char === "-" || char === undefined) return "gap";
    const st = colStats[col];
    if (st !== undefined && isConservedCol(st, DEFAULT_CONSERVED)) return "conserved";
    return "seq";
  };

  const columnFromEvent = (e: ReactMouseEvent<HTMLDivElement>, rowEl: HTMLDivElement): number => {
    const rect = rowEl.getBoundingClientRect();
    const x = e.clientX - rect.left - NAME_WIDTH;
    if (x < 0) return -1;
    const colInText = Math.floor(x / charWidth);
    const c = keep[colInText];
    return c === undefined ? -1 : c;
  };

  const onRowMouseDown = (e: ReactMouseEvent<HTMLDivElement>, seqName: string): void => {
    const col = columnFromEvent(e, e.currentTarget);
    if (col < 0) return;
    e.preventDefault();
    if (inSelection(seqName, col)) {
      setSelection(null); // a second click on the selected cell clears it
      return;
    }
    setDrag({ seqName, anchor: col });
    setSelection({ seqName, start: col + 1, end: col + 1 });
  };

  const onRowMouseMove = (e: ReactMouseEvent<HTMLDivElement>, seqName: string): void => {
    const col = columnFromEvent(e, e.currentTarget);
    if (col < 0) {
      setHover(null);
      return;
    }
    setHover({ row: seqName, col });
    if (drag !== null && drag.seqName === seqName && e.buttons === 1) {
      const start = Math.min(drag.anchor, col);
      const end = Math.max(drag.anchor, col);
      setSelection({ seqName, start: start + 1, end: end + 1 });
    }
  };

  const onRowDoubleClick = (e: ReactMouseEvent<HTMLDivElement>, seqName: string): void => {
    if (!onMention) return;
    const col = columnFromEvent(e, e.currentTarget);
    const target =
      col >= 0 && selection !== null && inSelection(seqName, col)
        ? { seqName, start: selection.start, end: selection.end }
        : { seqName, start: col + 1, end: col + 1 };
    setSelection({ seqName, start: target.start, end: target.end });
    onMention(target);
  };

  const gridWidth = NAME_WIDTH + (plain ? data.columns : keep.length) * charWidth + 8;
  const hoverStat = hover !== null ? colStats[hover.col] : undefined;

  const inputStyle: CSSProperties = {
    fontSize: 12,
    padding: "2px 6px",
    border: "1px solid rgba(148,163,184,0.4)",
    borderRadius: 4,
    background: "transparent",
    color: "inherit",
  };
  const labelStyle: CSSProperties = { fontSize: 12, display: "inline-flex", gap: 4, alignItems: "center" };

  return (
    <div
      className={className}
      style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setSelection(null);
          setHover(null);
        }
      }}
      onMouseLeave={() => setHover(null)}
    >
      {/* Toolbar */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "4px 8px" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sequences…"
          aria-label="Search sequences"
          style={inputStyle}
        />
        <label style={labelStyle}>
          <input type="checkbox" checked={conservedOnly} disabled={plain} onChange={(e) => setConservedOnly(e.target.checked)} />
          conserved only
        </label>
        <label style={labelStyle}>
          <input type="checkbox" checked={hideGaps} disabled={plain} onChange={(e) => setHideGaps(e.target.checked)} />
          hide gaps
        </label>
        <label style={labelStyle}>
          <input type="checkbox" checked={showBand} disabled={plain} onChange={(e) => setShowBand(e.target.checked)} />
          conservation band
        </label>
        <button type="button" style={{ fontSize: 12 }} onClick={() => setShowStats((v) => !v)}>
          {showStats ? "hide stats" : "show stats"}
        </button>
      </div>

      {showStats && (
        <div style={{ fontSize: 12, padding: "0 8px 4px", opacity: 0.85 }}>
          {table.sequences} sequences · {table.columns} columns · avg identity{" "}
          {(table.averageIdentity * 100).toFixed(1)}% · {table.conservedColumns} conserved columns
        </div>
      )}

      {plain && (
        <p style={{ fontSize: 12, padding: "0 8px 4px", opacity: 0.8 }}>
          {(data.sequences.length * data.columns).toLocaleString()} cells is above{" "}
          {PLAIN_TEXT_CELL_LIMIT.toLocaleString()} — showing the plain-text view (search still works;
          selection, the band and the column filters are disabled at this size).
        </p>
      )}

      <div
        ref={scrollerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: `${ROW_HEIGHT}px`,
        }}
      >
        {/* Sticky header: annotations, conservation band, ruler */}
        <div style={{ position: "sticky", top: 0, zIndex: 2, background: "transparent" }}>
          <span ref={charProbeRef} aria-hidden style={{ visibility: "hidden", display: "block", height: 0, overflow: "hidden" }}>
            0000000000
          </span>
          {data.annotations.map((a) => (
            <div key={`${a.label}`} style={{ display: "flex", whiteSpace: "pre", height: 16, color: "#64748b" }}>
              <span
                style={{ width: NAME_WIDTH, flex: "0 0 auto", overflow: "hidden", textOverflow: "ellipsis" }}
                title={a.label}
              >
                {a.label}
              </span>
              <span style={{ overflow: "hidden" }}>{keep.map((c) => a.chars[c] ?? "·").join("")}</span>
            </div>
          ))}
          {!plain && showBand && (
            <div style={{ display: "flex", whiteSpace: "pre", height: 6 }}>
              <span style={{ width: NAME_WIDTH, flex: "0 0 auto" }} />
              {groupSpans("·".repeat(keep.length), (i) => {
                const c = keep[i];
                const st = c === undefined ? undefined : colStats[c];
                return conservationBandColor(st?.identity ?? 0, st?.gapFraction ?? 1);
              }).map((sp, k) => (
                <span key={k} style={{ color: sp.cls }}>
                  {sp.text}
                </span>
              ))}
            </div>
          )}
          {!plain && (
            <div style={{ display: "flex", whiteSpace: "pre", height: 14, color: "#64748b" }}>
              <span style={{ width: NAME_WIDTH, flex: "0 0 auto" }} />
              <span>{rulerLine(data.columns, keepSet)}</span>
            </div>
          )}
        </div>

        {/* Virtualized body */}
        <div style={{ position: "relative", height: rows.length * ROW_HEIGHT, width: gridWidth }}>
          {visible.map((s, i) => {
            const y = (windowed.start + i) * ROW_HEIGHT;
            return (
              <div
                key={`${s.name}-${windowed.start + i}`}
                style={{ position: "absolute", top: y, left: 0, width: "100%", height: ROW_HEIGHT, whiteSpace: "pre" }}
                onMouseDown={(e) => onRowMouseDown(e, s.name)}
                onMouseMove={(e) => onRowMouseMove(e, s.name)}
                onDoubleClick={(e) => onRowDoubleClick(e, s.name)}
              >
                <span
                  style={{ display: "inline-block", width: NAME_WIDTH, overflow: "hidden", textOverflow: "ellipsis", opacity: 0.9 }}
                  title={s.name}
                >
                  {s.name}
                </span>
                {plain ? (
                  <span style={{ opacity: 0.9 }}>{s.seq}</span>
                ) : (
                  groupSpans(
                    keep.map((c) => s.seq[c] ?? "-").join(""),
                    (i) => cellClass(keep[i] === undefined ? "-" : s.seq[keep[i]!] ?? "-", s.name, keep[i] ?? -1),
                  ).map((sp, k) => (
                    <span key={k} style={{ color: CELL_COLOR[sp.cls as CellClass], background: CELL_BG[sp.cls as CellClass] }}>
                      {sp.text}
                    </span>
                  ))
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer: hover info + selection + hint */}
      <div style={{ fontSize: 11, padding: "3px 8px", opacity: 0.85, display: "flex", gap: 12, alignItems: "center" }}>
        {hover !== null && hoverStat !== undefined ? (
          <span>
            {hover.row}:{hover.col + 1} · identity {(hoverStat.identity * 100).toFixed(0)}% · gap{" "}
            {(hoverStat.gapFraction * 100).toFixed(0)}%
          </span>
        ) : (
          <span>click selects · drag selects a run · double-click inserts the mention · Esc clears</span>
        )}
        {selection !== null && (
          <span>
            selected {selection.seqName}:{selection.start}
            {selection.end !== selection.start ? `–${selection.end}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `src/react/MsaResultTable.tsx`**

```tsx
"use client";

import { Fragment, useMemo, useState, type CSSProperties } from "react";
import type { MmseqsResult } from "../formats.js";

export interface MsaResultTableProps {
  data: MmseqsResult;
  className?: string;
}

interface Sort {
  field: number;
  dir: 1 | -1;
}

const TH: CSSProperties = { textAlign: "left", padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.4)", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" };
const TD: CSSProperties = { padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.13)", whiteSpace: "nowrap" };
const NUM_INPUT: CSSProperties = { width: 64, fontSize: 12, padding: "1px 4px", border: "1px solid rgba(148,163,184,0.4)", borderRadius: 4, background: "transparent", color: "inherit" };

export function MsaResultTable({ data, className }: MsaResultTableProps) {
  const [sort, setSort] = useState<Sort>({ field: 9, dir: 1 }); // evalue ascending
  const [identityMin, setIdentityMin] = useState(30);
  const [evalueMax, setEvalueMax] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const idIdx = data.fields.indexOf("id");
  const evIdx = data.fields.indexOf("evalue");
  const alignIdx = data.fields.lastIndexOf("alignment");

  const rows = useMemo(() => {
    const filtered = data.rows.filter((r) => {
      if (idIdx !== -1) {
        const v = r[idIdx];
        if (typeof v === "number" && v < identityMin) return false;
      }
      if (evIdx !== -1) {
        const v = r[evIdx];
        if (typeof v === "number" && v > evalueMax) return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      const av = a[sort.field];
      const bv = b[sort.field];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * sort.dir;
    });
  }, [data.rows, identityMin, evalueMax, sort, idIdx, evIdx]);

  const toggleSort = (i: number): void =>
    setSort((s) => (s.field === i ? { field: i, dir: (s.dir * -1) as 1 | -1 } : { field: i, dir: 1 }));

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", padding: "4px 8px", fontSize: 12 }}>
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          identity ≥
          <input type="number" min={0} max={100} value={identityMin} onChange={(e) => setIdentityMin(Math.max(0, Number(e.target.value) || 0))} style={NUM_INPUT} />
        </label>
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          E-value ≤
          <input type="number" min={0} step="any" value={evalueMax} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setEvalueMax(v); }} style={{ ...NUM_INPUT, width: 80 }} />
        </label>
        <span style={{ opacity: 0.7 }}>
          {rows.length.toLocaleString()} of {data.rows.length.toLocaleString()} hits
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {data.fields.map((f, i) => (
                <th key={`${f}-${i}`} style={TH} onClick={() => toggleSort(i)}>
                  {f}
                  {sort.field === i ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const key = `${String(r[0])}|${String(r[1])}|${String(r[3] ?? "")}|${String(r[4] ?? "")}|${idx}`;
              const alignVal = alignIdx === -1 ? undefined : r[alignIdx];
              const hasAlign = typeof alignVal === "string" && alignVal.length > 0;
              return (
                <Fragment key={key}>
                  <tr
                    style={expanded === key ? { background: "rgba(148,163,184,0.08)" } : undefined}
                    onClick={() => hasAlign && setExpanded(expanded === key ? null : key)}
                  >
                    {data.fields.map((f, i) => {
                      const v = r[i];
                      return (
                        <td key={`${f}-${i}`} style={TD}>
                          {hasAlign && i === 0 ? "▸ " : ""}
                          {v === null || v === undefined ? "" : String(v)}
                        </td>
                      );
                    })}
                  </tr>
                  {expanded === key && hasAlign && (
                    <tr>
                      <td colSpan={data.fields.length} style={{ padding: "4px 8px" }}>
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 11,
                            lineHeight: "16px",
                            whiteSpace: "pre-wrap",
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                          }}
                        >
                          {alignVal}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ margin: 0, fontSize: 11, padding: "4px 8px", opacity: 0.7 }}>
        click a hit row to show the raw mmseqs alignment string for that pair
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Write `src/react/UnalignedList.tsx`**

```tsx
"use client";

import { useMemo, useState } from "react";
import type { MsaUnaligned } from "../formats.js";
import type { MsaTarget } from "../mention.js";

export interface UnalignedListProps {
  data: MsaUnaligned;
  className?: string;
  onMention?: (target: MsaTarget) => void;
}

export function UnalignedList({ data, className, onMention }: UnalignedListProps) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? data.sequences : data.sequences.filter((s) => s.name.toLowerCase().includes(q));
  }, [data.sequences, query]);
  const totalLength = rows.reduce((a, s) => a + s.seq.length, 0);

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 8px", fontSize: 12 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sequences…"
          aria-label="Search sequences"
          style={{ fontSize: 12, padding: "2px 6px", border: "1px solid rgba(148,163,184,0.4)", borderRadius: 4, background: "transparent", color: "inherit" }}
        />
        <span style={{ opacity: 0.7 }}>
          {rows.length} sequences · {totalLength.toLocaleString()} aa total (unaligned — no columns)
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.4)" }}>sequence</th>
              <th style={{ textAlign: "right", padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.4)" }}>length</th>
              <th style={{ padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.4)" }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr key={`${s.name}-${i}`}>
                <td style={{ padding: "2px 8px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{s.name}</td>
                <td style={{ padding: "2px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{s.seq.length}</td>
                <td style={{ padding: "2px 8px", textAlign: "right" }}>
                  <button
                    type="button"
                    disabled={s.seq.length === 0}
                    onClick={() => onMention?.({ seqName: s.name, start: 1, end: s.seq.length })}
                    style={{ fontSize: 11, cursor: "pointer" }}
                  >
                    insert
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Complete `src/index.ts`** — replace the file's export list so the React entries are included (keep everything already there; the final file must export exactly `./formats`, `./stats`, `./mention`, `./grid` plus):

```tsx
export { MsaGrid, type MsaGridProps } from "./react/MsaGrid.js";
export { MsaResultTable, type MsaResultTableProps } from "./react/MsaResultTable.js";
export { UnalignedList, type UnalignedListProps } from "./react/UnalignedList.js";
```

- [ ] **Step 5: Package green** (build typechecks the components; tests unchanged)

```bash
cd /home/zhonghua/workspace/science-studio
npm run build -w @science-studio/msa-viewer
npm run test -w @science-studio/msa-viewer
```

Expected: build clean; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/msa-viewer/src/react packages/msa-viewer/src/index.ts
git commit -m "feat(msa-viewer): the React views — MsaGrid, MsaResultTable, UnalignedList"
```

---

### Task 6: web wiring (kind, renderer, mention seam, build chain, `file-kinds` regression)

**Files:**
- Modify: `apps/web/package.json` (dependency)
- Modify: `apps/web/components/studio/file-utils.ts`
- Create: `apps/web/components/studio/renderers/MsaRenderer.tsx`
- Modify: `apps/web/components/studio/file-preview-pane.tsx`
- Modify: `package.json` (root — build chain)
- Modify: `apps/web/test/file-kinds.test.mjs` (new tests)

**Interfaces:**
- Consumes: `@science-studio/msa-viewer` (Tasks 1–5), `useWorkspaceApi` / `workspaceFileUrl` from `@science-studio/transport-client`, `useComposerInsert()` from `@/components/assistant-ui/composer-insert`, `useStudioStore((s) => s.revealLeftView)`, `PlainTextRenderer` (`content: string`).
- Produces: `FileKind` gains `"msa"`; `kindFor(..., "any-mime")` → `"msa"` for MSA names; `isTextEditable(msa-name)` → `false`; `MsaRenderer({ path, name })`.

- [ ] **Step 1: Add the dependency + link**

`apps/web/package.json` `dependencies` — add beside `"@science-studio/molql-viewer": "*"`:

```json
    "@science-studio/msa-viewer": "*",
```

Then:

```bash
cd /home/zhonghua/workspace/science-studio
npm install
ls apps/web/node_modules/@science-studio 2>/dev/null || ls node_modules/@science-studio | grep msa
```

- [ ] **Step 2: Write the failing web tests** (append to `apps/web/test/file-kinds.test.mjs`)

Add ONE new import to the existing import block: `isMsaFile` (from `../components/studio/file-utils.ts`), then append:

```js
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
```

- [ ] **Step 3: Run — expect FAIL** (`kindFor` does not know `"msa"`; `isMsaFile` not exported)

```bash
cd /home/zhonghua/workspace/science-studio/apps/web
node --test test/file-kinds.test.mjs
```

Note: this single file is pure Node (type stripping) — no Chromium, no dev server, matching the existing suite header.

- [ ] **Step 4: Update `file-utils.ts`** — three exact changes:

(a) the new import (next to the existing `molql-viewer` import at line 2):

```ts
import { isMsaFile } from "@science-studio/msa-viewer/formats";
```

(b) the kind union + re-export (after the existing line 16 re-export):

```ts
export type FileKind = "markdown" | "json" | "code" | "text" | "pdf" | "structure" | "image" | "msa";

export { isMsaFile } from "@science-studio/msa-viewer/formats";
```

(c) `kindFor` — insert the msa case after the structure case (line 31), and `isTextEditable` (line 117) becomes:

```ts
export function kindFor(name: string, mime?: string | null): FileKind {
  if (isPdfFile(name)) return "pdf";
  if (isStructureFile(name)) return "structure";
  if (isMsaFile(name)) return "msa";
  if (isImageFile(name)) return "image";
  ...
}

export function isTextEditable(name: string): boolean {
  const kind = kindFor(name);
  return kind !== "pdf" && kind !== "structure" && kind !== "image" && kind !== "msa";
}
```

- [ ] **Step 5: Run the web tests — green**

```bash
cd /home/zhonghua/workspace/science-studio/apps/web
node --test test/file-kinds.test.mjs
```

- [ ] **Step 6: Create `apps/web/components/studio/renderers/MsaRenderer.tsx`**

```tsx
"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MsaGrid,
  MsaResultTable,
  UnalignedList,
  formatMsaMention,
  msaMentionKey,
  parseAlignment,
  type MsaTarget,
} from "@science-studio/msa-viewer";
import { useWorkspaceApi, workspaceFileUrl } from "@science-studio/transport-client";
import { useComposerInsert } from "@/components/assistant-ui/composer-insert";
import { useStudioStore } from "@/store/studio-store";
import { PlainTextRenderer } from "./PlainTextRenderer";

/**
 * The MSA preview: fetches the file's own bytes (like the other specialist viewers —
 * the text hook would double-download, and the server may serve these as
 * `application/octet-stream`, which `useWorkspaceFile` classifies as binary),
 * parses them with `@science-studio/msa-viewer`, and routes:
 *   aligned  → MsaGrid · unaligned → UnalignedList · mmseqs → MsaResultTable
 * Parse failure and an oversized file fall back to plain text — never a blank pane.
 *
 * A double-click / "insert" toggles `@<project>/<path>/<seqName>@<col>[-<col>]` in
 * the composer through the existing seam (a plain-text mention, exactly like structure
 * mentions).
 */

type FetchState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

function friendlyError(status: number): string {
  if (status === 404) return "This file no longer exists in the workspace.";
  if (status === 413) return "This file is over the inline size cap — use download to inspect it.";
  if (status === 503) return "The workspace is not available in this deployment.";
  return `The workspace answered HTTP ${status}; the alignment could not be loaded.`;
}

export function MsaRenderer({ path, name }: { path: string; name: string }) {
  const { api, project } = useWorkspaceApi();
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setShowRaw(false);
    void (async () => {
      try {
        const res = await fetch(workspaceFileUrl(api, path, { project }));
        if (!res.ok) {
          if (!cancelled) setState({ status: "error", message: friendlyError(res.status) });
          return;
        }
        const text = new TextDecoder("utf-8").decode(await res.arrayBuffer());
        if (!cancelled) setState({ status: "ready", text });
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, path, project]);

  const parsed = useMemo(() => {
    if (state.status !== "ready") return null;
    try {
      return { ok: true as const, value: parseAlignment(state.text) };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  }, [state]);

  // Double-click / "insert" toggles the mention on the existing seam (a second
  // activation of the same target REMOVES it — the provider tracks it by key).
  const composer = useComposerInsert();
  const revealLeftView = useStudioStore((s) => s.revealLeftView);
  const onMention = useCallback(
    (target: MsaTarget) => {
      if (!composer) return;
      const key = `${project ?? ""}/${path}::${msaMentionKey(target)}`;
      composer.toggleMention(key, formatMsaMention(project ?? "", path, target));
      revealLeftView("thread");
    },
    [composer, project, path, revealLeftView],
  );

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="p-4 text-sm text-destructive" role="alert">
        <p>{state.message}</p>
        <p className="mt-1 text-muted-foreground">
          <code>{name}</code> at <code>/{path}</code> could not be loaded or rendered.
        </p>
      </div>
    );
  }

  const text = state.text;

  if (parsed !== null && !parsed.ok) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border/70 px-3 py-2" role="alert">
          <p className="text-sm text-destructive">Could not render {name} as an alignment: {parsed.message}</p>
          <button
            type="button"
            className="mt-2 rounded px-2 py-1 text-xs bg-accent hover:bg-accent/70"
            onClick={() => setShowRaw(true)}
          >
            Open as plain text
          </button>
        </div>
        {showRaw && (
          <div className="min-h-0 flex-1 overflow-auto">
            <PlainTextRenderer content={text} />
          </div>
        )}
      </div>
    );
  }

  const value = parsed?.ok ? parsed.value : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5">
        <span className="text-xs text-muted-foreground">alignment viewer</span>
        <button
          type="button"
          className="ml-auto rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? "Back to viewer" : "Raw text"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {showRaw ? (
          <div className="h-full overflow-auto">
            <PlainTextRenderer content={text} />
          </div>
        ) : value === null ? (
          <p className="p-4 text-sm text-muted-foreground">Nothing to show.</p>
        ) : value.kind === "aligned" ? (
          <MsaGrid data={value} onMention={onMention} />
        ) : value.kind === "unaligned" ? (
          <UnalignedList data={value} onMention={onMention} />
        ) : (
          <MsaResultTable data={value} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Wire the preview pane** — `apps/web/components/studio/file-preview-pane.tsx`:

(a) after the `StructureRenderer` dynamic import (lines 40–43):

```tsx
const MsaRenderer = dynamic(
  () => import("./renderers/MsaRenderer").then((m) => m.MsaRenderer),
  { ssr: false, loading: () => <ViewerLoading /> },
);
```

(b) the `Preview` dispatch — insert the msa case after the structure case (line 250–251):

```tsx
          ) : kind === "structure" ? (
            <StructureRenderer path={path} name={name} />
          ) : kind === "msa" ? (
            <MsaRenderer path={path} name={name} />
          ) : (
            <TextPreview
```

- [ ] **Step 8: Add the package to the root build chain** — in the ROOT `package.json` `scripts.build`, insert `&& npm run build -w @science-studio/msa-viewer` between `molql-viewer` and `transport-openclaw`:

```json
    "build": "npm run build -w @science-studio/record && npm run build -w @science-studio/transport && npm run build -w @science-studio/workspace && npm run build -w @science-studio/cron && npm run build -w @science-studio/hpc && npm run build -w @science-studio/contract-tests && npm run build -w @science-studio/transport-client && npm run build -w @science-studio/molql-viewer && npm run build -w @science-studio/msa-viewer && npm run build -w @science-studio/transport-openclaw && npm run build -w @science-studio/transport-dsh && npm run build -w @science-studio/transport-service && npm run typecheck:tests",
```

- [ ] **Step 9: Type and test — green**

```bash
cd /home/zhonghua/workspace/science-studio
npm run build -w @science-studio/web 2>&1 | tail -5   # next build = the web type gate (or at least: cd apps/web && npx tsc --noEmit)
cd apps/web && npx tsc --noEmit                          # the cheaper, always-available gate
node --test test/file-kinds.test.mjs
```

Expected: `tsc --noEmit` clean; `file-kinds` suite green.

- [ ] **Step 10: Commit**

```bash
cd /home/zhonghua/workspace/science-studio
git add apps/web/package.json apps/web/components/studio/file-utils.ts apps/web/components/studio/renderers/MsaRenderer.tsx apps/web/components/studio/file-preview-pane.tsx package.json apps/web/test/file-kinds.test.mjs
git commit -m "feat(web): msa file kind + MsaRenderer (grid/table/rows + plain-text fallback + composer mentions)"
```

---

### Task 7: whole-repo gate, manual smoke, `AGENTS.md`

**Files:**
- Modify: `AGENTS.md` (structure line + a short MSA section)

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: a green `npm run build` + `npm run test` (root) + a verified manual smoke + updated `AGENTS.md`.

- [ ] **Step 1: Whole-repo gate**

```bash
cd /home/zhonghua/workspace/science-studio
npm run build    # record→…→msa-viewer→…→transport-service→typecheck:tests (checks packages/*/test/**)
npm run test     # every workspace with a test script, including msa-viewer
```

Expected: all green. If `typecheck:tests` or any suite fails, fix the owning code (the failure names the file) and re-run before continuing.

- [ ] **Step 2: Web e2e (pure) + type gate**

```bash
cd apps/web
node --test test/file-kinds.test.mjs
npx tsc --noEmit
```

(Chromium browser suites SKIP without a browser and are dev-only — the pure files always run. Run the full `npm run test:e2e` only if a Chromium is available and the user wants it.)

- [ ] **Step 3: Manual smoke (needs a running dev pair)**

```bash
# from the repo root
npm run dev
# in the workbench: create/use any Project, write two fixture files into its workspace
# (the agent can do this via its own shell tools):
#   <workspace>/align.clustal  (the Task-1 CLUSTAL fixture, wrapped to 20+7)
#   <workspace>/hits_result    (the Task-1 MMSEQS_TAB_11 fixture)
```

Then, in the browser workbench (http://localhost:3000):

1. click `align.clustal` in the file tree → the grid renders: two sequences, ruler, conservation band, stats line; a second consensus annotation row is visible (Clustal).
2. click a cell → it highlights + row/column crosshair; click it again → cleared; drag across a run → the run highlights; `Esc` clears.
3. double-click a cell → the composer on the left gains `@<project>/<path>/<seqName>@<col>`; double-click the SAME cell again → the mention is removed (toggle) — and the conversation pane is revealed.
4. toggle "conserved only" / "hide gaps" → columns disappear and the ruler keeps their width blank; search `Seq2` → only Seq2's row shows.
5. open `hits_result` → the table with identity ≥ / E-value ≤ filters; click a row with an alignment column → its raw alignment string expands.
6. write a garbage file `bad.clustal` (`hello world`) → opening it shows the friendly error + "Open as plain text" works; on `align.clustal` the "Raw text" toggle shows the source and back.
7. **tab state rule:** open two MSA tabs, hover/select in the first, switch to the second and back — selection and scroll survive, and no `visibility` oddity (the hidden tab must not bleed through the visible one).

If any step fails: do NOT patch blindly — load `superpowers:systematic-debugging`, find the root cause in the owning layer (pure logic vs. component vs. wiring), fix, re-run Steps 1–2 to keep the gate green, and only then re-smoke the failing step.

- [ ] **Step 4: Update `AGENTS.md`**

(a) In the `## Structure` listing, after the `packages/molql-viewer …` line, add:

```
packages/msa-viewer             MSA (multiple sequence alignment) view + interaction (spec docs/superpowers/specs/2026-09-23-msa-viewer-design.md): pure Node-testable codec — ClustalW / Stockholm / aligned-FASTA / unaligned-FASTA / mmseqs2-`.result` parsers (`./formats`, `sniffFormat`, `isMsaFile`), column statistics + the conservative `isConservedCol` (`./stats`), the `@<project>/<path>/<seqName>@<col>[-<col>]` mention codec (`./mention`), and the grid math — row windowing, span grouping, ruler, band scale, 250k-cell plain-text guard (`./grid`); `.` is the React entry — `MsaGrid` (virtualized grid, crosshair, double-click mention, conservation band, conserved/gap column filters), `MsaResultTable` (sortable mmseqs hits with identity/E-value thresholds), `UnalignedList`. Zero deps (react peer), zero molstar
```

(b) After the "## Molecular-structure preview and the `molql` tool" section (before "## Architecture rules"), add a short section:

```markdown
## MSA (sequence alignment) preview

- **Name-based kind, self-fetch, four-state routing.** `kindFor` recognizes `"msa"` by
  name (`.clustal/.clustal.om/.sto/.stockholm/.fasta/.fa/.faa/.fna/.aln/.result`, and
  names ending in `*_result`) and `renderers/MsaRenderer.tsx` (dynamic `ssr:false`,
  like StructureRenderer) fetches its OWN bytes and decodes UTF-8 — deliberately NOT
  through `useWorkspaceFile`, which would classify an `application/octet-stream`
  answer as binary (the two must-stay-in-sync mime lists stay untouched). It routes
  by parse result: aligned → `MsaGrid`, unaligned → `UnalignedList`, mmseqs →
  `MsaResultTable`; a parse failure or a file over 250 000 cells falls back to
  plain text — never a blank pane.
- **The package is the boundary (zero molstar).** MSA is a text grid, not a 3D
  scene, and Mol\* 5.9.0 ships no MSA component (verified against the installed
  tree) — so `@science-studio/msa-viewer` owns the parsing/stats/mention/grid math
  (pure, Node-tested: `npm run test -w @science-studio/msa-viewer`) and the React
  views are thin over it, the same precedent as `@science-studio/molql-viewer`'s
  `react/` folder. `isTextEditable` excludes `"msa"` (no source editor — the
  renderer's "Raw text" toggle is that affordance).
- **Mentions are plain text over the existing seam.** Double-click (or the
  "insert" button) toggles `@<project>/<path>/<seqName>@<col>[-<col>]` in the
  composer through `ComposerInsertProvider`, keyed `path|seqName|start|end` —
  exactly the structure-mention `molqlTargetKey` rule — then reveals the
  conversation pane. No new directive, no service route, no agent-side plugin:
  the agent reads the alignment TEXT from its own cwd; if tools are ever added,
  `parseMsaMention` is the parse rule they reuse.
```

- [ ] **Step 5: Final gate + commit**

```bash
cd /home/zhonghua/workspace/science-studio
npm run build
npm run test
git add AGENTS.md
git commit -m "docs(msa-viewer): AGENTS.md structure line + the MSA preview section"
git status --short   # expected: clean (dist/ is gitignored)
```

**Stop here.** The branch `molstar-msa` carries: spec (`7d96749`) + 7 implementation/doc commits. Do NOT push unless the user asks. Do NOT merge — the user reviews the branch.

---

## Self-Review (run after writing the plan; fix inline; do not re-review)

**Spec coverage:**
- package + entries `. / ./formats / ./stats / ./mention` → Tasks 1–5 (`./grid` added as the pure home for the Task-4 math; the spec's "browser entry + pure entries" intent is preserved and the extra entry is additive, not a conflict).
- all five file formats + sniffing + BOM/CRLF + name-only detection → Task 1 (tests pin tabs, 10/11/12 fields, multi-block Clustal, Stockholm `//` optional, `#label`-free GS names, empty-name error).
- statistics + `isConservedCol` defaults (0.9 / 0.1) → Task 2 (defaults asserted verbatim).
- mention grammar + ` #label` tolerance + typed errors + round-trip → Task 3.
- grid: windowing, span grouping, ruler (10/100), band scale, plain-text guard at 250 000, filters (conserved / gaps / search) → Task 4 (pure) + Task 5 (UI).
- mmseqs table: sortable, identity ≥ / E-value ≤ filters, raw alignment expand → Task 5.
- web: kind by name, `ssr:false` shell, four-state routing, plain-text fallback, source-editor exclusion, toggling composer mention keyed like structure, reveal pane → Task 6.
- tests + gates (package Node suite, `tsconfig.tests.json` absorption, root build chain, `file-kinds`, web `tsc --noEmit`) → Tasks 1–6 + Task 7 Step 1/2.
- **NOT implemented (per spec Out-of-scope):** agent tools, service routes, record changes, molstar, alignment algorithms, canvas rendering, multi-MSA compare, GenBank, editing — confirmed absent from every task.

**Placeholder scan:** none — every code step carries full code or exact file/line edits; the only procedural step (manual smoke) is a verification gate with concrete fixtures and expectations, not an implementation placeholder.

**Type consistency:** `MsaTarget` is defined ONCE in `./mention.ts` (Task 3) and imported by `MsaGrid` / `UnalignedList` (Task 5) and `MsaRenderer` (Task 6) — no second definition. `MsaParseResult` variants (`MsaAligned` / `MsaUnaligned` / `MmseqsResult`) are named in Task 1 and referenced identically in Tasks 2/4/5/6. `isConservedCol(stat, opts?)` / `DEFAULT_CONSERVED` (Task 2) is the predicate Task 4's `columnsToKeep` and Task 5's band/conserved classes both call. `rowWindow` / `groupSpans` / `rulerLine(columns, keep?)` / `conservationBandColor` / `columnsToKeep` / `shouldUsePlainText` / `PLAIN_TEXT_CELL_LIMIT` signatures in Task 4 match the Task-5 component call sites.
