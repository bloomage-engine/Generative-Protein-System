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

export function latestLogEntry(existing: string): CronLogEntry | null {
  const headers = [...existing.matchAll(new RegExp(HEADER_SOURCE, "gm"))];
  const last = headers[headers.length - 1];
  if (!last || last.index === undefined) return null;
  const section = existing.slice(last.index + last[0].length).split(/^## /m)[0] ?? "";
  const sessionId = /^- session: (.+)$/m.exec(section)?.[1]?.trim();
  const runId = /^- run: (.+)$/m.exec(section)?.[1]?.trim();
  const message = section.replace(/^- (?:session|run): .+$/gm, "").trim();
  return {
    at: last[1]!,
    status: last[2] as CronRunStatus,
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(message ? { message } : {}),
  };
}
