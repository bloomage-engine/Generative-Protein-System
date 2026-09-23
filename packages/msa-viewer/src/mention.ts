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
