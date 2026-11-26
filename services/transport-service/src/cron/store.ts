import {
  CRON_DIR,
  appendLogEntry,
  cronLogPath,
  cronTaskPath,
  latestLogEntry,
  parseTaskDoc,
  serializeTaskDoc,
  taskIdFromPath,
  type CronLogEntry,
  type CronTask,
} from "@gps/cron";
import { WorkspaceNotFoundError, type Workspace } from "@gps/transport";

export interface CronTaskSummary extends CronTask {
  path: string;
  lastRun?: CronLogEntry;
}

export interface CronListResult {
  tasks: CronTaskSummary[];
  invalid: { path: string; error: string }[];
}

export interface CronStore {
  list(workspace: Workspace): Promise<CronListResult>;
  read(workspace: Workspace, id: string): Promise<CronTask | null>;
  write(workspace: Workspace, task: CronTask): Promise<CronTask>;
  remove(workspace: Workspace, id: string): Promise<void>;
  appendLog(workspace: Workspace, id: string, entry: CronLogEntry): Promise<void>;
}

async function readText(workspace: Workspace, path: string): Promise<string | null> {
  try {
    const content = await workspace.open(path);
    return await new Response(content.body).text();
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) return null;
    throw err;
  }
}

async function writeText(workspace: Workspace, path: string, text: string): Promise<void> {
  await workspace.write(path, new TextEncoder().encode(text), { createParents: true });
}

export function createCronStore(opts: { now?: () => string } = {}): CronStore {
  const now = opts.now ?? (() => new Date().toISOString());
  return {
    async list(workspace) {
      let entries;
      try {
        ({ entries } = await workspace.list(CRON_DIR));
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError) return { tasks: [], invalid: [] };
        throw err;
      }
      const tasks: CronTaskSummary[] = [];
      const invalid: { path: string; error: string }[] = [];
      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        const id = taskIdFromPath(entry.path);
        if (id === null) continue;
        const text = await readText(workspace, entry.path);
        if (text === null) continue;
        const parsed = parseTaskDoc(id, text);
        if ("error" in parsed) {
          invalid.push({ path: entry.path, error: parsed.error });
          continue;
        }
        const log = await readText(workspace, cronLogPath(id));
        const lastRun = log === null ? null : latestLogEntry(log);
        tasks.push({ ...parsed.task, path: entry.path, ...(lastRun ? { lastRun } : {}) });
      }
      tasks.sort((a, b) => a.id.localeCompare(b.id));
      return { tasks, invalid };
    },
    async read(workspace, id) {
      const text = await readText(workspace, cronTaskPath(id));
      if (text === null) return null;
      const parsed = parseTaskDoc(id, text);
      return "error" in parsed ? null : parsed.task;
    },
    async write(workspace, task) {
      const timestamp = now();
      const next = { ...task, createdAt: task.createdAt ?? timestamp, updatedAt: timestamp };
      await writeText(workspace, cronTaskPath(task.id), serializeTaskDoc(next));
      return next;
    },
    async remove(workspace, id) {
      if (typeof workspace.delete !== "function") return;
      for (const path of [cronTaskPath(id), cronLogPath(id)]) {
        try {
          await workspace.delete(path);
        } catch (err) {
          if (!(err instanceof WorkspaceNotFoundError)) throw err;
        }
      }
    },
    async appendLog(workspace, id, entry) {
      const existing = (await readText(workspace, cronLogPath(id))) ?? "";
      await writeText(workspace, cronLogPath(id), appendLogEntry(existing, entry));
    },
  };
}
