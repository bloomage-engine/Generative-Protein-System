# MSA Viewer for File Preview

Work on branch `molstar-msa`.

## Summary

Alignments and pairwise-search result files are common in a research workspace, but today the workbench shows them as raw text. This adds an interactive MSA viewer on the human-preview path, mirroring the existing structure-viewer pattern:

- a new package `@science-studio/msa-viewer` that owns the pure, Node-testable logic (format parsing, column statistics, the mention codec) plus the browser-only React components (alignment grid, mmseqs result table);
- a new `"msa"` file kind in `apps/web` and a new `MsaRenderer` center-pane renderer that routes to the right sub-view (aligned grid / unaligned rows / mmseqs hit table / plain-text fallback) and inserts viewer mentions into the composer through the same seam the structure renderer uses.

No new service routes, no agent-side plugin, no record change, and no molstar dependency: the MSA grid is a text grid, and Mol\* 5.9.0 ships no MSA component (only a single-sequence strip and a two-sequence alignment algorithm — verified against the installed tree). The agent already has the alignment file in its own cwd and can read it as plain text; the viewer mention doubles as a stable reference the agent can follow.

## Motivation

Researchers drop alignment and search output into a Project workspace: ClustalW/Stockholm/aligned-FASTA MSAs and mmseqs2 `.result` hit tables. There is no way to read them as alignments — no per-column conservation, no click-to-select, no selection reference they can hand to the agent. The structure files already have a specialist viewer (`StructureRenderer` + `@science-studio/molql-viewer`); sequence alignments need the equivalent.

## Scope

**In scope:**

- New workspace package `packages/msa-viewer` (root `workspaces` + root build chain).
- Parsers (pure, Node-testable): aligned multi-sequence FASTA, unaligned FASTA, **a3m** (ColabFold/AlphaFold MSA — lowercase insertion residues are stripped to recover the match-state alignment), ClustalW (with optional consensus line), Stockholm (sequence lines + `#=GC`/`#=PC` per-position annotation blocks), and the mmseqs2 whitespace-separated `.result` table (BLAST-tabular order, 11/12-field rows).
- Column statistics (pure, Node-testable): per-column identity and gap fraction, per-sequence gap fraction and length, whole-table average identity, plus a "conserved column" predicate with documented defaults.
- Mention codec (pure, Node-testable): `@<project>/<path>/<seqName>@<col>` and `@<project>/<path>/<seqName>@<start>-<end>`, formatted and parsed, compatible with a trailing ` #label` (stripped before parse, same convention as structure mentions).
- React components (browser entry): `MsaGrid` (row-virtualized monospace grid, crosshair selection, conservation band, 10/100 column ruler, sequence-name column sticky on the left, sequence-name search, "conserved only" / gap filters, statistics readout, plain-text degradation for very large alignments), `MsaResultTable` (sortable columns, identity / E-value threshold filters), and a simple unaligned-rows list.
- `apps/web`: `"msa"` in `kindFor` (by file name, per the repo convention), an `MsaRenderer` that fetches its own bytes (like the other specialist viewers), routes by parse result, and offers a plain-text fallback on parse failure; mention insertion via the existing `ComposerInsertProvider` seam, double-click toggling an already-inserted target off (same keying as structure mentions).
- Tests: package-level Node tests for formats / stats / mention; a `kindFor` case in `apps/web/test/file-kinds.test.mjs`; `npm run build` (the real type gate) and `npm run test` green.

**Out of scope:**

- Agent-side plugins, service routes, or record changes (the agent reads the text file directly from its cwd).
- Any molstar dependency in the package (there is nothing to render in 3D).
- Running any alignment algorithm here (msa-viewer does not compare sequences; it parses and presents).
- GenBank / FASTA internal-feature parsing; Stockholm annotations are surfaced as rows, not parsed into a full annotation model.
- Canvas-based grid rendering (DOM row virtualization first; add a canvas path later if a real file demands it).
- Side-by-side comparison of multiple MSA files, export, or editing.
- A source-view editor for MSA files (the specialist renderer is the pane; "open as plain text" is the fallback — the same decision structure files already made).

## Design

### `packages/msa-viewer`

Mirrors the shape of `packages/molql-viewer`: explicit exports (no `export *`), pure modules in their own entries (Node-testable), React in the browser entry. The package has **no dependencies** beyond `react` (peer) and dev tooling; it imports nothing from the rest of the monorepo.

| Entry | Contents | Node-testable |
|---|---|---|
| `.` | `MsaGrid`, `MsaResultTable`, `UnalignedList` (React, browser-only) | no |
| `./formats` | `parseAlignment(text)` with content sniffing + per-format parsers, `MsaParseResult` types | yes |
| `./stats` | per-column / per-sequence / table statistics, `isConservedCol` | yes |
| `./mention` | `formatMsaMention(...)`, `parseMsaMention(text)` | yes |

Build: `tsc -b` like its siblings; tests: `node --import tsx --test test/*.test.ts`.

### Data model (`./formats`)

```ts
type MsaSequence = { id: number; name: string; seq: string };
type MsaParseResult =
  | { kind: "aligned";   sequences: MsaSequence[];
                            columns: number; annotations: { label: string; chars: string }[];
                            insertionsStripped?: boolean }
  | { kind: "unaligned"; sequences: MsaSequence[] }
  | { kind: "mmseqs";    fields: string[]; rows: (string | number)[][] };
```

- `aligned`: every `seq` has length `columns` (gaps are `-`); `annotations` holds Clustal consensus lines and Stockholm `#=GC`/`#=PC` blocks (label + one char per column), each **merged across blocks** into one full-length string per label.
- `unaligned`: FASTA whose sequences do not all share a length; `seq` is the raw concatenated record.
- `mmseqs`: `fields` is the canonical order — the real `mmseqs easy-search` / BLAST-tabular layout: **query, target, pident, length, mismatch, gapopen, qstart, qend, tstart, tend, evalue, [score]**; numeric cells are numbers, accessions stay strings; no alignment-string column (the `convertalis` detail output is a different, unsupported file).

**Parsing rules.**

- Content sniffing decides the parser first, the (declared) extension second: a `# STOCKHOLM 1.0` header or a line starting `#=GS`/`#=GC`/`#=PC` → Stockholm; a line matching `^CLUSTAL` → ClustalW; a `>` record header → FASTA; a whitespace row of ≥ 10 fields with numeric columns 3–10 → mmseqs. Unrecognized content is a typed parse error (the renderer catches it), never a crash.
- ClustalW: name + wrapped sequence lines (re-wrapped to any width are re-joined); the line(s) following each sequence block, present for every block, are consensus annotations, with the block's name-field indent stripped (a space for an unmarked column survives) and the per-block fragments **merged per label**; sequences may be interleaved (multi-block).
- FASTA: the sequence `name` is the first whitespace-delimited token of the `>` header (a description part in the header is dropped in v1). A repeated header starts a distinct record — real ColabFold/UniRef a3m files carry the same accession more than once — so `name` is not assumed unique; `id` is the record's position and is the viewer's row identity. **a3m**: when the records are ragged and at least one carries lowercase letters, and removing those lowercase letters makes every record the same length, the result is that reduced alignment with `insertionsStripped: true`. An already-uniform file is left alone (its lowercase is not treated as insertion), and a ragged file without lowercase stays `unaligned`.
- Stockholm: sequence lines `NAME  SEQ...`; `#=GS NAME VALUE` are kept as sequence metadata (name only in v1); `#=GC LABEL SEQ...` (the real per-column annotation tag: `#=GC RF`, `#=GC ss_cons`) and the legacy `#=PC LABEL SEQ...` become `annotations`; parsing runs until `//` **or end-of-file** (a missing terminator is tolerated, since some tools omit it).
- mmseqs `.result`: split on runs of whitespace; a row needs **11 or 12** fields; fields 3–11 (`pident`…`evalue`) are numbers, and the optional 12th (`score`) is a number too — non-numeric where a number is required is a typed error, never `NaN` cells; > 12 fields is a typed error (a `convertalis` detail column is not supported).
- BOM and CRLF are normalized; NUL and other control bytes are stripped (tab/newline preserved) so a stray junk byte cannot count as a residue and defeat the a3m length check; blank lines are skipped; parsers are pure (`text` in, value out) and total over the recognized set (recognized content never throws; it is either parsed or classified as unrecognized).

### Statistics (`./stats`)

- `columnStats(result): { identity: number; gapFraction: number }[]` — identity = share of the most frequent non-gap character, gapFraction = share of `-` (per column).
- `sequenceStats(result): { name: string; length: number; gapFraction: number }[]`.
- `tableStats(result): { sequences: number; columns: number; averageIdentity: number; conservedColumns: number }`.
- `isConservedCol({identity, gapFraction}, opts?)` — defaults `minIdentity: 0.9`, `maxGapFraction: 0.1` (documented on the function; overridable).

Everything is total over `aligned` results; `unaligned` and `mmseqs` are answered with empty/`null` shapes, not exceptions.

### Mention codec (`./mention`)

```
@<project>/<path>/<seqName>@<col>            one cell
@<project>/<path>/<seqName>@<start>-<end>    a run (start <= end, 1-based)
```

- `formatMsaMention(project, path, seqName, col?: [start, end])` — emits the canonical form.
- `parseMsaMention(text)`: a `#label` suffix (leading space + `#`, the structure-mention convention) is stripped first; the body splits as `@` + `project` (first segment) + middle segments = `path` (may itself contain `/`) + last segment; the last segment splits on the first unescaped `@` into `seqName` and the position. Returns a typed result; malformed input is a typed `MentionParseError` (with reason), never a partial object.
- The grammar is intentionally the shape of the structure mention (`@<project>/<path>/<expression>`), so future agent-side tools can reuse one reading rule (`parseSelectionItem`-adjacent) across both viewer kinds.
- Mentions are **plain composer text** (a directive is not emitted and the service lifts nothing) — identical policy to structure mentions.

### React components (browser entry)

Common props: `{ project: string; path: string; data: MsaParseResult }` plus `onMention(target)` where `target = { seqName, start, end }` (the web renderer formats it through `formatMsaMention`).

- **`MsaGrid`** (aligned):
  - Rendering: monospace; sequence-name column sticky on the left (so row labels survive horizontal scrolling) with an opaque background; a ruler row over the **compacted** column set — rows, band, ruler and annotation rows all render exactly the kept columns, and each ruler label is the column's original 1-based number glued to its character (never a blank-padded full-width ruler, which drifts out of alignment as soon as a column is filtered out); **row virtualization only** (a dependency-free window over the visible rows; each visible row is rendered as grouped same-class character spans, not one span per cell); the conservation band is a strip above the grid, one cell per column, colored on an identity scale (red = conserved → gray = variable), toggleable. The sticky header is as wide as the grid so it scrolls horizontally with the rows.
  - Selection: single click selects one cell (cross-highlight of its row and column) — selecting does **not** touch the composer; a drag over a row selects a contiguous run; a second single click on the same cell clears the selection; `Esc` clears.
  - Mention: **double-click** (or the per-selection "insert" affordance) calls `onMention({seqName, start, end})`; a double-click on a target that already carries a mention **removes** it — the toggle is keyed in the web renderer (target key), and the grid only reports "this target was (re-)activated". So: single clicks manage selection, double clicks manage the mention, and they never fight. The pointer→column hit test is a pure function (`columnAtOffset`) so it is testable without a DOM.
  - In plain-text mode the pointer handlers are inert — the notice's promise ("selection … disabled at this size") is the actual behavior, and no mention is inserted from a size whose columns are not selectable.
  - Hover: full row + column light highlight and a tooltip (sequence name, 1-based column, that column's identity / gap fraction).
  - Filters: sequence-name search (rows), "conserved columns only" (columns, via `isConservedCol`), "hide gaps" (columns where every sequence is `-`).
  - Scale guard (cost model, see Amendment 2): the grid auto-degrades to a **plain-text mode** (virtualized raw text rows, no per-character spans, no statistics pass) with a one-line notice and a search that still works when the alignment has more than **20 000 columns** (per-row DOM/width cost) or more than **20 000 000 cells** (the one-time statistics pass). Real ColabFold/AlphaFold MSAs — tens of thousands of rows, a few hundred columns — stay a grid, because rows are virtualized and same-class characters are grouped into runs.
  - Like every renderer in a tab, it never asserts its own `visibility` (the open-file pane hides tabs with `visibility:hidden`, and a child's `visibility:visible` would resurrect it).
- **`MsaResultTable`** (mmseqs): a table over `fields` (numeric right-aligned, sortable header), with two threshold inputs — identity ≥ (default 30, read from the real `pident` column) and E-value ≤ (default 1, read from the real `evalue` column) — and a row-count readout. There is no row expansion: the BLAST-tabular `.result` carries no alignment string (see the amendment below).
- **`UnalignedList`** (unaligned FASTA): one row per sequence — name, length, and an "insert" affordance that calls `onMention({seqName, start: 1, end: length})`.

### `apps/web` wiring

| File | Change |
|---|---|
| `components/studio/file-utils.ts` | `kindFor` gains `"msa"` for `.clustal`, `.clustal.om`, `.sto`, `.stockholm`, `.fasta`, `.fa`, `.faa`, `.fna`, `.aln`, `.result`, and any name ending in `_result` (name-based, per the repo convention; the mime map does not decide this) |
| `components/studio/file-preview-pane.tsx` | the `Preview` switch routes kind `"msa"` to the new renderer |
| `components/studio/renderers/MsaRenderer.tsx` | new; thin shell over `MsaParser` |
| `components/studio/renderers/MsaParser.tsx` | new; fetch → parse → route to `MsaGrid` / `UnalignedList` / `MsaResultTable` / fallback |
| `test/file-kinds.test.mjs` | new `"msa"` cases + regression of the existing routing |

- **Fetching, like the specialist viewers, is the renderer's own job** — `MsaRenderer` fetches `workspaceFileUrl(api, path, { project })`, reads it as a byte stream and decodes UTF-8, and classifies failures through the existing 503/404 helpers. **A 413 (the inline cap) is retried on the streaming `download=1` variant and only then refused (past a 64 MB viewer ceiling)**, because a real alignment easily passes the inline cap while the viewer legitimately wants the whole file; the request is aborted when the tab switches away. This keeps the two text-mime lists that "must stay in sync" (`mimeFor` in `packages/workspace`, `looksTextual` in `transport-client`) untouched; an alignment arriving as `application/octet-stream` then still renders (the viewer does not depend on the server calling it text).
- **Routing on the parse result**: `aligned` → `MsaGrid`; `unaligned` → `UnalignedList`; `mmseqs` → `MsaResultTable`; a parse error or an empty file → a friendly error / hint block with an **"open as plain text"** action that renders the already-fetched bytes through the existing `PlainTextRenderer` (no second fetch).
- **Mentions**: `MsaRenderer` consumes `useComposerInsert()` (the same context `StructureRenderer` uses); each target carries a key of `path|seqName|start|end`, and re-activating an already-inserted target (double-click or the "insert" affordance) **removes** that mention — the toggle is keyed exactly like structure mentions' `molqlTargetKey` — then the conversation pane is revealed via the store, as structure clicks do today.
- Tabs, StrictMode double-mount, and the status bar need no changes: kind routing is the only entry point.

### Errors and edge cases

| Case | Behavior |
|---|---|
| content matches no known format | parse error surfaced as a friendly block + "open as plain text" |
| empty file / single empty record | hint + "open as plain text" |
| alignment too large for the grid | auto plain-text mode (250 k-cell guard) with a notice |
| 404 / 503 (no workspace) / over inline cap | the existing `requestError` / `isWorkspaceUnavailable` classification and message lines, unchanged |
| BOM / CRLF / re-wrapped sequence lines | normalized inside the parsers, invisible to the UI |

### Testing

| Layer | What | How |
|---|---|---|
| `msa-viewer/test/formats.test.ts` | ClustalW (incl. consensus + multi-block), Stockholm (incl. `#=PC`), aligned FASTA, unaligned FASTA, mmseqs `.result` (10 / 11 / 12-field rows, alignment column), sniffing, BOM/CRLF, unrecognized content → typed error | `node --import tsx --test` (pure Node) |
| `msa-viewer/test/stats.test.ts` | identity / gap fraction / table stats; all-gap and single-sequence columns; `unaligned`/`mmseqs` total shapes; `isConservedCol` defaults and overrides | same |
| `msa-viewer/test/mention.test.ts` | format/parse round-trip (cell + run), ` #label` tolerance, project-with-slashes path, malformed inputs → typed error | same |
| `apps/web/test/file-kinds.test.mjs` | `kindFor` → `"msa"` for every listed extension and the `_result` suffix; existing kinds unchanged | web e2e command |
| `apps/web` renderers | the pure logic is already covered above; the four-state routing and the mention seam follow the established StructureRenderer pattern and are not given a separate browser-e2e in v1 | — |

Gates: `npm run build` (build chain gains `msa-viewer` between `molql-viewer` and `transport-openclaw`; it has no monorepo imports, so position is free) and `npm run test` (the package's suite joins the root run) both green.

### Delivery

1. `git switch -c molstar-msa` (done — branch exists on `f5042fa`).
2. This spec, committed on the branch.
3. `writing-plans` produces the implementation plan; execution method chosen at that gate.
4. Implementation strictly in plan order, TDD for the pure modules first (parsers → stats → mention → components → web wiring), with `npm run build` + `npm run test` + the web `file-kinds` cases green at each step's end.

## Amendment — post-review corrections (2026-09-23)

The whole-branch review found two defects the spec itself carried, plus geometry/annotation
behavior the spec was silent on. All are corrected above; recorded here so the change of
intent is visible.

1. **mmseqs `.result` column order (spec defect).** The original data model invented the
   order `query, target, length, id, gapopen, …`. Real `mmseqs easy-search` (and BLAST
   `-outfmt 6`) output is `query, target, pident, length, mismatch, gapopen, qstart, qend,
   tstart, tend, evalue, [score]`. With the invented order the table mislabeled every
   column from the third on, and — because the `evalue` header landed on a coordinate
   column — the default "E-value ≤ 1" filter hid essentially every real hit. The parser
   now implements the real layout and accepts 11 or 12 columns; the table's identity
   filter reads `pident` and its E-value filter reads `evalue`.
2. **The alignment-string column and the row expansion are removed (spec defect).** They
   existed only because of the invented layout; the real `.result` has no alignment
   column. A `convertalis` detail file (a different shape) is out of scope and fails as a
   typed error rather than rendering misleadingly.
3. **Stockholm annotation tag corrected (spec defect).** Stockholm 1.0 defines `#=GC` for
   per-column annotations (`#=GC RF`, `#=GC ss_cons`); the spec's `#=PC` is not a standard
   feature line. Both are now accepted (`#=GC` is what real Pfam/Rfam files carry).
4. **Multi-block annotations are merged per label (spec silence).** One annotation per
   block would misplace every block after the first (fragments are indexed by original
   column) and collide on a label-only React key. `mergeAnnotations` joins them into one
   full-length string per label; the Clustal parser also strips the block's name-field
   indent instead of `trim()`-ing the consensus line (an unmarked leading column is a
   space and must survive).
5. **One column geometry, applied to rows, band, ruler and annotations (spec silence).**
   Rows render the compacted kept columns, so the ruler does too, each label carrying its
   original 1-based number; a blank-padded full-width ruler drifts one position right of
   its character after the first filtered column. The sticky header is as wide as the grid
   so it scrolls with the rows, and the sequence-name column is sticky-left with an opaque
   background (both were specified but unimplemented).
6. **The pointer hit test is a pure function (implementation defect).** The character-width
   probe was a block-level element measuring its container, which corrupted every
   click/drag/double-click column mapping (and therefore every composer mention).
   `columnAtOffset` now owns that arithmetic and is covered by Node tests; the probe is
   absolutely positioned so it shrink-wraps its text.
7. **A repeated FASTA header is a typed error (spec silence).** Concatenating two records
   with the same name silently corrupts data (and can fake an aligned length match);
   interleaved blocks are a Clustal/Stockholm concept only.
8. **Plain-text mode is inert (spec silence).** The notice promised that selection is
   disabled at the ≥ 250 000-cell size; the pointer handlers now honor that literally
   instead of inserting a mention at an unselectable column.

### Amendment 2 — a3m and large alignments (2026-09-23)

Found by opening a real research file: `data/fold_2025_06_27_18_45_paired_msa_chains_a.a3m`
(8 469 973 bytes, 14 633 records). The viewer could not open it at all, for four
independent reasons — all fixed:

1. **`.a3m` was not a recognized name**, so the file never reached the MSA viewer: it fell
   through to the generic text preview, whose inline-capped read produced the 413 the
   researcher saw. `.a3m` (and `.A3M`) now map to the `"msa"` kind.
2. **The renderer's own fetch was inline-only**, so routing alone would have hit the same
   8 MiB cap. A 413 is now retried on the streaming `download=1` variant (which the
   service already offers for exactly this), with a 64 MB viewer ceiling and an
   `AbortController` so a switched-away tab does not leave the download running.
3. **a3m is ragged until lowercase insertions are removed** (the file had 52 distinct raw
   record lengths, 427–484; after stripping lowercase: exactly one length, 427). Stripping
   is the format's own semantics — insertion residues are not part of the alignment — and
   the parse reports `insertionsStripped` so the grid says so instead of silently showing
   something other than the file (the "Raw text" toggle shows the file as written).
4. **The 250 000-cell guard was measured wrong for this design.** It assumed the grid cost
   scales with the total cell count, but rows are virtualized and same-class characters are
   grouped into runs. Measured on that file (14 633 × 427 = 6.25M cells): ~400–500 ms for
   the one-time column statistics, ~2 ms to render 30 visible rows (~18 spans per row),
   ~3 ms for the band. The guard is now a cost model: plain text only above **20 000
   columns** (per-row DOM/width) or **20 000 000 cells** (the statistics pass), and the
   statistics are skipped entirely in plain mode; `tableStats` accepts already-computed
   column statistics so the grid's pass is not repeated.

Name detection learned `.a3m` in both `isMsaFile` and `kindFor`; the web regression suite
covers it.

### Amendment 3 — real a3m record names and control bytes (2026-10-26)

Found by opening a real ColabFold/UniRef `uniref.a3m`: it repeats a record name
(`UniRef100_A0A371H0J5`), which the FASTA parser rejected with a typed error. A repeated
`>` header is a distinct record, not Clustal/Stockholm-style interleaving, and refusing the
whole file is disproportionate for a viewer. FASTA parsing now keeps every record in file
order; `MsaSequence.id` (the record's position) is the viewer's row identity, so duplicate
names no longer collide on hover, drag-selection or React keys. Clustal/Stockholm keep their
name-based block merging, and the mention codec remains name-based
(`@<project>/<path>/<seqName>@<col>`): a duplicated name refers to every row sharing it.

The same investigation found a second real-file failure: a generated
`bfd.mgnify30.metaeuk30.smag30.a3m` (2937 records × 485 match states) had one record with a
trailing NUL, making its stripped length 486 and forcing the whole file into the unaligned
list. NUL and other control bytes are now stripped during normalization (tab/newline
preserved), so the file renders as an aligned grid without altering the source.
