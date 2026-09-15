/**
 * The remembered Project/Session scope — the workbench's chrome state, kept in
 * this browser so a reload (or a bookmark-less fresh open) lands where the user
 * left off (docs/adr/0009).
 *
 * Everything here is a CLAIM until the record answers. The transport route MINTS
 * a Project row and a Session row for an unknown key rather than refusing it
 * (`resolveOrCreateSession`), so an id this browser remembers — or one a URL
 * carries — must be validated against `/api/projects*` before it is opened, or a
 * stale id silently becomes a fabricated record row. That is why the resolution
 * below takes the record's lists as input and drops what they do not list.
 *
 * The pure half (parse/resolve/`scopePath`) is the whole decision table and is
 * unit-tested without a browser; only `read`/`write`/`syncScopeUrl` touch the
 * browser, and each tolerates a browser that refuses (private mode, quota).
 */
import type { Project, Session } from "@science-studio/transport-client";

/** The one key we own. Versioned, so a future shape can migrate instead of guess. */
export const SCOPE_MEMORY_KEY = "science-studio.scope.v1";

export interface ScopeMemory {
  version: 1;
  /** The Project the workbench was last scoped to. */
  lastProjectId: string | null;
  /** Per Project: the Session it last had in effect (docs/adr/0009). */
  sessions: Record<string, string>;
}

/** The scope the workbench is showing. Either half may be absent. */
export interface Scope {
  projectId: string | null;
  sessionId: string | null;
}

/** Read persisted JSON. Anything unreadable or unrecognized reads as "no memory". */
export function parseScopeMemory(raw: string | null | undefined): ScopeMemory {
  const empty: ScopeMemory = { version: 1, lastProjectId: null, sessions: {} };
  if (!raw) return empty;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof value !== "object" || value === null) return empty;

  const candidate = value as { version?: unknown; lastProjectId?: unknown; sessions?: unknown };
  // v1 is the only shape there is: an unversioned or future blob is not guessed at.
  if (candidate.version !== 1) return empty;

  const sessions: Record<string, string> = {};
  if (typeof candidate.sessions === "object" && candidate.sessions !== null) {
    for (const [projectId, sessionId] of Object.entries(candidate.sessions)) {
      if (typeof sessionId === "string" && sessionId.length > 0) sessions[projectId] = sessionId;
    }
  }

  const lastProjectId = candidate.lastProjectId;
  return {
    version: 1,
    lastProjectId:
      typeof lastProjectId === "string" && lastProjectId.length > 0 ? lastProjectId : null,
    sessions,
  };
}

export function readScopeMemory(): ScopeMemory {
  if (typeof window === "undefined") return parseScopeMemory(null);
  try {
    return parseScopeMemory(window.localStorage.getItem(SCOPE_MEMORY_KEY));
  } catch {
    // Storage denied (private mode): no memory, never an error.
    return parseScopeMemory(null);
  }
}

export function writeScopeMemory(memory: ScopeMemory): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SCOPE_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    /* a full or denied store must not break the workbench */
  }
}

/**
 * Point the memory at a scope. A scope with no Session only moves the Project —
 * the Project's own remembered Session is not disproven by a switch that is
 * still resolving, and the caller may never get an answer (a failed list must
 * not prune: docs/adr/0009).
 */
export function rememberScope(memory: ScopeMemory, scope: Scope): ScopeMemory {
  const sessions = { ...memory.sessions };
  if (scope.projectId && scope.sessionId) sessions[scope.projectId] = scope.sessionId;
  return { version: 1, lastProjectId: scope.projectId, sessions };
}

/** Set or clear one Project's Session — the record has answered about it. */
function writeSession(memory: ScopeMemory, projectId: string, sessionId: string | null): ScopeMemory {
  const sessions = { ...memory.sessions };
  if (sessionId) sessions[projectId] = sessionId;
  else delete sessions[projectId];
  return { version: 1, lastProjectId: memory.lastProjectId, sessions };
}

/**
 * Drop what the record no longer lists. Only ever called with a list the record
 * actually answered with — an unreachable store is not an empty one.
 */
export function pruneScopeMemory(memory: ScopeMemory, projects: Project[]): ScopeMemory {
  const live = new Set(projects.map((project) => project.id));
  const sessions: Record<string, string> = {};
  for (const [projectId, sessionId] of Object.entries(memory.sessions)) {
    if (live.has(projectId)) sessions[projectId] = sessionId;
  }
  return {
    version: 1,
    lastProjectId: memory.lastProjectId && live.has(memory.lastProjectId) ? memory.lastProjectId : null,
    sessions,
  };
}

export interface ProjectChoice {
  projectId: string | null;
  /**
   * The Session that Project should open: the URL's claim when the URL named the
   * Project, otherwise that Project's remembered Session. Still only a claim —
   * `resolveSession` checks it against the Project's own list.
   */
  sessionHint: string | null;
  /** The memory to persist: pruned, and pointed at the chosen Project. */
  memory: ScopeMemory;
}

/**
 * Pick the Project to open: the URL's claim when the record lists it, else the
 * remembered Project when it still exists, else the FIRST Project.
 */
export function resolveProject(input: {
  claimedProjectId: string | null;
  claimedSessionId: string | null;
  memory: ScopeMemory;
  projects: Project[];
}): ProjectChoice {
  const memory = pruneScopeMemory(input.memory, input.projects);
  const claimed =
    input.claimedProjectId !== null && input.projects.some((p) => p.id === input.claimedProjectId)
      ? input.claimedProjectId
      : null;

  const projectId = claimed ?? memory.lastProjectId ?? input.projects[0]?.id ?? null;
  const sessionHint = claimed
    ? (input.claimedSessionId ?? memory.sessions[claimed] ?? null)
    : projectId
      ? (memory.sessions[projectId] ?? null)
      : null;

  return { projectId, sessionHint, memory: rememberScope(memory, { projectId, sessionId: null }) };
}

export interface SessionChoice {
  sessionId: string | null;
  memory: ScopeMemory;
}

/**
 * Pick the Session inside an already-chosen Project: the hint when the Project's
 * list holds it, else the Project's NEWEST Session (Sessions list in creation
 * order), else none. A list that does not hold the hint settles it — the
 * remembered entry is dropped rather than retried on every load.
 */
export function resolveSession(input: {
  projectId: string | null;
  hint: string | null;
  sessions: Session[];
  memory: ScopeMemory;
}): SessionChoice {
  const { projectId, sessions } = input;
  if (!projectId) return { sessionId: null, memory: input.memory };

  const hinted =
    input.hint !== null && sessions.some((session) => session.id === input.hint) ? input.hint : null;
  const sessionId = hinted ?? sessions[sessions.length - 1]?.id ?? null;

  return { sessionId, memory: writeSession(input.memory, projectId, sessionId) };
}

/**
 * The URL of a scope: the deep-link route when it names both halves, else the
 * SPA home (a scoped route with no Session does not exist).
 */
export function scopePath(scope: Scope): string {
  return scope.projectId && scope.sessionId
    ? `/projects/${encodeURIComponent(scope.projectId)}/sessions/${encodeURIComponent(scope.sessionId)}`
    : "/";
}

/**
 * Mirror the scope in the URL with the native History API, never a router
 * navigation: `/` and the scoped route are different segments, so navigating
 * would swap the whole page subtree — remounting the runtime mid-run, whose
 * probe then hits the one-run-per-session 409 and never imports its history
 * (docs/adr/0009). A replaced URL is what a reload and a copy-paste both need.
 */
export function syncScopeUrl(scope: Scope): void {
  if (typeof window === "undefined") return;
  const path = scopePath(scope);
  if (window.location.pathname === path) return;
  window.history.replaceState(null, "", `${path}${window.location.search}${window.location.hash}`);
}
