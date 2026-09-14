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
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RecordStore } from "./index.js";
import type { Id, Project, Run, Session } from "./types.js";

type Row =
  | { t: "project"; v: Project }
  | { t: "session"; v: Session }
  | { t: "run"; v: Run };

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
  }
}

function parseLine(line: string): Row | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const parsed = JSON.parse(trimmed) as Row;
    if (parsed && (parsed.t === "project" || parsed.t === "session" || parsed.t === "run")) {
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
    async archiveProject(id: Id, archivedAt: string): Promise<Project> {
      const prev = tables.projects.get(id);
      if (!prev) throw new Error(`project not found: ${id}`);
      const next = { ...prev, archivedAt };
      await append({ t: "project", v: next });
      tables.projects.set(id, clone(next));
      return clone(next);
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
    async listSessions(projectId: Id): Promise<Session[]> {
      return ordered(tables.sessions, (s) => s.projectId === projectId);
    },
    async addRun(run: Run): Promise<Run> {
      await append({ t: "run", v: run });
      tables.runs.set(run.id, clone(run));
      return clone(run);
    },
    async listRuns(projectId: Id): Promise<Run[]> {
      return ordered(tables.runs, (r) => r.projectId === projectId);
    },
  };
}
