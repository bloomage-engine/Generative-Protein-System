import { isValidSchedule } from "./schedule.js";

export const CRON_DIR = ".science-studio/cron";

const TASK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_SUFFIX = ".md";
const LOG_SUFFIX = ".log.md";

export interface CronTask {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  sessionId?: string;
  prompt: string;
  createdAt?: string;
  updatedAt?: string;
}

export type ParseResult = { task: CronTask } | { error: string };

export function isValidTaskId(id: string): boolean {
  return TASK_ID.test(id);
}

export function cronTaskPath(id: string): string {
  return `${CRON_DIR}/${id}${TASK_SUFFIX}`;
}

export function cronLogPath(id: string): string {
  return `${CRON_DIR}/${id}${LOG_SUFFIX}`;
}

export function taskIdFromPath(path: string): string | null {
  const prefix = `${CRON_DIR}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.includes("/")) return null;
  if (!rest.endsWith(TASK_SUFFIX) || rest.endsWith(LOG_SUFFIX)) return null;
  const id = rest.slice(0, -TASK_SUFFIX.length);
  return isValidTaskId(id) ? id : null;
}

export function isCronTaskPath(path: string): boolean {
  return taskIdFromPath(path) !== null;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  return trimmed;
}

export function parseTaskDoc(id: string, text: string): ParseResult {
  if (!isValidTaskId(id)) return { error: `invalid task id: ${id}` };
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { error: "missing frontmatter" };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { error: "unterminated frontmatter" };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "");
  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) return { error: `malformed frontmatter line: ${line}` };
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const name = unquote(fields.get("name") ?? "");
  if (name === "") return { error: "missing name" };
  const schedule = unquote(fields.get("schedule") ?? "");
  if (!isValidSchedule(schedule)) return { error: `invalid schedule: ${schedule}` };
  const enabledRaw = (fields.get("enabled") ?? "true").trim();
  if (enabledRaw !== "true" && enabledRaw !== "false") return { error: `invalid enabled: ${enabledRaw}` };
  const sessionId = unquote(fields.get("sessionId") ?? "");
  const createdAt = unquote(fields.get("createdAt") ?? "");
  const updatedAt = unquote(fields.get("updatedAt") ?? "");
  return {
    task: {
      id,
      name,
      schedule,
      enabled: enabledRaw === "true",
      prompt: body,
      ...(sessionId ? { sessionId } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    },
  };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function serializeTaskDoc(task: CronTask): string {
  const lines = [
    "---",
    `name: ${quote(task.name)}`,
    `schedule: ${quote(task.schedule)}`,
    `enabled: ${task.enabled ? "true" : "false"}`,
  ];
  if (task.sessionId) lines.push(`sessionId: ${quote(task.sessionId)}`);
  if (task.createdAt) lines.push(`createdAt: ${quote(task.createdAt)}`);
  if (task.updatedAt) lines.push(`updatedAt: ${quote(task.updatedAt)}`);
  lines.push("---", "", task.prompt);
  return lines.join("\n");
}
