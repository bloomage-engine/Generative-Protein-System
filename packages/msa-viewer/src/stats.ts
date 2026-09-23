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
