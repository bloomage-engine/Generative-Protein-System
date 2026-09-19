/**
 * `createJsonlRecordStore` — a dependency-free, durable `RecordStore`.
 *
 * The whole store is an append-only JSONL log (`{ "t": <table>, "v": <row> }`
 * per line) plus in-memory indexes rebuilt on load. It exists so the single-user
 * service's Project/Session/Run lists and their Runs survive a restart without
 * adding a database dependency (docs/adr/0007); SQLite/Postgres stay swappable
 * behind the same `RecordStore` contract.
 *
 * Durability: appends are serialized so lines never interleave, and the loader
 * skips a torn final line — the crash semantics are "the last record may be
 * lost, earlier ones survive". Startup compacts the log (one row per entity, via
 * a temp file + rename) so restarts also bound its growth.
 */
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RecordStore } from "./index.js";
import type { Id, Project, Run, Session, PersistedTranscript, Subagent } from "./types.js";

type Row =
  | { t: "project"; v: Project }
  | { t: "session"; v: Session }
  | { t: "run"; v: Run }
  /**
   * A deletion tombstone. Deletes must be durable, and the log is append-only,
   * so a removed row leaves a drop behind; the loader applies it and compaction
   * simply never writes it (it serializes the in-memory tables).
   */
  | { t: "drop"; table: "project" | "session" | "run"; id: Id };

interface Tables {
  projects: Map<Id, Project>;
  sessions: Map<Id, Session>;
  runs: Map<Id, Run>;
}

function apply(tables: Tables, row: Row): void {
  switch (row.t) {
    case "project":
      tables.projects.set(row.v.id, row.v);
      break;
    case "session":
      tables.sessions.set(row.v.id, row.v);
      break;
    case "run":
      tables.runs.set(row.v.id, row.v);
      break;
    case "drop":
      if (row.table === "project") tables.projects.delete(row.id);
      else if (row.table === "session") tables.sessions.delete(row.id);
      else tables.runs.delete(row.id);
      break;
  }
}

function parseLine(line: string): Row | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const parsed = JSON.parse(trimmed) as Row;
    if (
      parsed &&
      (parsed.t === "project" ||
        parsed.t === "session" ||
        parsed.t === "run" ||
        parsed.t === "drop")
    ) {
      return parsed;
    }
    return null;
  } catch {
    // A torn final line from a crashed append (or any unparsable line): skip.
    return null;
  }
}

async function load(path: string, tables: Tables): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  for (const line of raw.split("\n")) {
    const row = parseLine(line);
    if (row) apply(tables, row);
  }
  return true;
}

/** Rewrite the log as one row per entity (temp sibling + rename). */
async function compact(path: string, tables: Tables): Promise<void> {
  const rows: Row[] = [
    ...[...tables.projects.values()].map((v): Row => ({ t: "project", v })),
    ...[...tables.sessions.values()].map((v): Row => ({ t: "session", v })),
    ...[...tables.runs.values()].map((v): Row => ({ t: "run", v })),
  ];
  const body = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

async function writeFileAtomic(path: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

async function readJSONOrNull<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return (JSON.parse(raw) as T) ?? null;
  } catch {
    // A corrupt/torn file: degrade to absent (the record's own parseLine does the same).
    return null;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

export async function createJsonlRecordStore(path: string): Promise<RecordStore> {
  const tables: Tables = { projects: new Map(), sessions: new Map(), runs: new Map() };

  await mkdir(dirname(path), { recursive: true });
  const existed = await load(path, tables);
  if (existed) await compact(path, tables);

  // One append at a time: interleaved writes would corrupt lines.
  let tail: Promise<void> = Promise.resolve();
  const append = (row: Row): Promise<void> => {
    const line = `${JSON.stringify(row)}\n`;
    tail = tail.then(() => appendFile(path, line, "utf8"));
    return tail;
  };

  const clone = <T>(v: T): T => structuredClone(v);
  const ordered = <T>(map: Map<Id, T>, matches: (v: T) => boolean): T[] =>
    [...map.values()].filter(matches).map(clone);
  const drop = (table: "project" | "session" | "run", id: Id): Promise<void> =>
    append({ t: "drop", table, id });

  const rootDir = dirname(path);
  const transcriptsDir = join(rootDir, "transcripts");
  const subagentsDir = join(rootDir, "subagents");

  return {
    async createProject(project: Project): Promise<Project> {
      await append({ t: "project", v: project });
      tables.projects.set(project.id, clone(project));
      return clone(project);
    },
    async getProject(id: Id): Promise<Project | null> {
      const p = tables.projects.get(id);
      return p ? clone(p) : null;
    },
    async listProjects(opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
      return ordered(tables.projects, (p) => opts.includeArchived === true || p.archivedAt === undefined);
    },
    async updateProject(id: Id, patch: { name: string }): Promise<Project> {
      const prev = tables.projects.get(id);
      if (!prev) throw new Error(`project not found: ${id}`);
      const next = { ...prev, name: patch.name };
      await append({ t: "project", v: next });
      tables.projects.set(id, clone(next));
      return clone(next);
    },
    async archiveProject(id: Id, archivedAt: string): Promise<Project> {
      const prev = tables.projects.get(id);
      if (!prev) throw new Error(`project not found: ${id}`);
      const next = { ...prev, archivedAt };
      await append({ t: "project", v: next });
      tables.projects.set(id, clone(next));
      return clone(next);
    },
    async unarchiveProject(id: Id): Promise<Project> {
      const prev = tables.projects.get(id);
      if (!prev) throw new Error(`project not found: ${id}`);
      const { archivedAt: _dropped, ...rest } = prev;
      await append({ t: "project", v: rest });
      tables.projects.set(id, clone(rest));
      return clone(rest);
    },
    async deleteProject(id: Id): Promise<void> {
      for (const session of [...tables.sessions.values()]) {
        if (session.projectId === id) {
          await drop("session", session.id);
          tables.sessions.delete(session.id);
        }
      }
      for (const run of [...tables.runs.values()]) {
        if (run.projectId === id) {
          await drop("run", run.id);
          tables.runs.delete(run.id);
        }
      }
      await drop("project", id);
      tables.projects.delete(id);
    },
    async addSession(session: Session): Promise<Session> {
      await append({ t: "session", v: session });
      tables.sessions.set(session.id, clone(session));
      return clone(session);
    },
    async getSession(id: Id): Promise<Session | null> {
      const s = tables.sessions.get(id);
      return s ? clone(s) : null;
    },
    async listSessions(
      projectId: Id,
      opts: { includeArchived?: boolean } = {},
    ): Promise<Session[]> {
      return ordered(
        tables.sessions,
        (s) => s.projectId === projectId && (opts.includeArchived === true || s.archivedAt === undefined),
      );
    },
    async updateSession(id: Id, patch: { title: string; updatedAt: string }): Promise<Session> {
      const prev = tables.sessions.get(id);
      if (!prev) throw new Error(`session not found: ${id}`);
      const next = { ...prev, title: patch.title, updatedAt: patch.updatedAt };
      await append({ t: "session", v: next });
      tables.sessions.set(id, clone(next));
      return clone(next);
    },
    async archiveSession(id: Id, archivedAt: string): Promise<Session> {
      const prev = tables.sessions.get(id);
      if (!prev) throw new Error(`session not found: ${id}`);
      const next = { ...prev, archivedAt };
      await append({ t: "session", v: next });
      tables.sessions.set(id, clone(next));
      return clone(next);
    },
    async unarchiveSession(id: Id): Promise<Session> {
      const prev = tables.sessions.get(id);
      if (!prev) throw new Error(`session not found: ${id}`);
      const { archivedAt: _dropped, ...rest } = prev;
      await append({ t: "session", v: rest });
      tables.sessions.set(id, clone(rest));
      return clone(rest);
    },
    async deleteSession(id: Id): Promise<void> {
      for (const run of [...tables.runs.values()]) {
        if (run.sessionId === id) {
          await drop("run", run.id);
          tables.runs.delete(run.id);
        }
      }
      await drop("session", id);
      tables.sessions.delete(id);
    },
    async addRun(run: Run): Promise<Run> {
      await append({ t: "run", v: run });
      tables.runs.set(run.id, clone(run));
      return clone(run);
    },
    async listRuns(projectId: Id): Promise<Run[]> {
      return ordered(tables.runs, (r) => r.projectId === projectId);
    },
    async saveSessionTranscript(sessionId: Id, doc: PersistedTranscript): Promise<void> {
      await writeFileAtomic(join(transcriptsDir, `${encodeURIComponent(sessionId)}.json`), doc);
    },
    async loadSessionTranscript(sessionId: Id): Promise<PersistedTranscript | null> {
      return readJSONOrNull<PersistedTranscript>(join(transcriptsDir, `${encodeURIComponent(sessionId)}.json`));
    },
    async upsertSubagent(subagent: Subagent): Promise<void> {
      await writeFileAtomic(join(subagentsDir, `${encodeURIComponent(subagent.id)}.json`), subagent);
    },
    async loadSubagent(id: Id): Promise<Subagent | null> {
      return readJSONOrNull<Subagent>(join(subagentsDir, `${encodeURIComponent(id)}.json`));
    },
    async listSubagents(parentSessionId: Id): Promise<Subagent[]> {
      const names = await listDir(subagentsDir);
      const out: Subagent[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const s = (await readJSONOrNull<Subagent>(join(subagentsDir, name))) ?? null;
        if (s && s.parentSessionId === parentSessionId) out.push(s);
      }
      return out;
    },
  };
}
