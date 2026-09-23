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
