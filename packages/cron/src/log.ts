export type CronRunStatus = "success" | "skipped-busy" | "error";

export interface CronLogEntry {
  at: string;
  status: CronRunStatus;
  sessionId?: string;
  runId?: string;
  message?: string;
}

const HEADER_SOURCE = "^## (\\S+) · (success|skipped-busy|error)$";

export function appendLogEntry(existing: string, entry: CronLogEntry): string {
  const block = [`## ${entry.at} · ${entry.status}`];
  if (entry.sessionId) block.push(`- session: ${entry.sessionId}`);
  if (entry.runId) block.push(`- run: ${entry.runId}`);
  block.push("");
  if (entry.message) block.push(entry.message);
  block.push("");
  const base = existing.trim() === "" ? "" : `${existing.replace(/\s+$/, "")}\n\n`;
  return `${base}${block.join("\n")}`;
}

function entryFromSection(at: string, status: CronRunStatus, section: string): CronLogEntry {
  const sessionId = /^- session: (.+)$/m.exec(section)?.[1]?.trim();
  const runId = /^- run: (.+)$/m.exec(section)?.[1]?.trim();
  const message = section.replace(/^- (?:session|run): .+$/gm, "").trim();
  return {
    at,
    status,
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(message ? { message } : {}),
  };
}

/** Every run section in the log, newest first. Malformed sections are ignored. */
export function parseLogEntries(existing: string): CronLogEntry[] {
  const headers = [...existing.matchAll(new RegExp(HEADER_SOURCE, "gm"))].filter(
    (header): header is RegExpExecArray & { index: number } => header.index !== undefined,
  );
  const entries = headers.map((header, index) => {
    const next = headers[index + 1];
    const section = existing.slice(header.index + header[0].length, next ? next.index : undefined);
    return entryFromSection(header[1]!, header[2] as CronRunStatus, section);
  });
  return entries.reverse();
}

export function latestLogEntry(existing: string): CronLogEntry | null {
  return parseLogEntries(existing)[0] ?? null;
}
