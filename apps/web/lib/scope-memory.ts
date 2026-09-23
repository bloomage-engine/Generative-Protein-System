/**
 * The remembered Project/Worktree/Session scope — the workbench's chrome state,
 * kept in this browser so a reload (or a bookmark-less fresh open) lands where
 * the user left off (docs/adr/0009, 0025).
 *
 * Everything here is a CLAIM until the record answers. The transport route MINTS
 * a Project row and a Session row for an unknown key rather than refusing it
 * (`resolveOrCreateSession`), so an id this browser remembers — or one a URL
 * carries — must be validated against `/api/projects*` and `/api/worktrees*`
 * before it is opened, or a stale id silently becomes a fabricated record row.
 * That is why the resolution below takes the record's lists as input and drops
 * what they do not list.
 *
 * The pure half (parse/resolve/`scopePath`) is the whole decision table and is
 * unit-tested without a browser; only `read`/`write`/`syncScopeUrl` touch the
 * browser, and each tolerates a browser that refuses (private mode, quota).
 */
import type { Project, Session, Worktree } from "@science-studio/transport-client";

/**
 * The reserved `main` Worktree id. Mirrors `DEFAULT_WORKTREE_ID` in the record /
 * transport-client packages, but is declared here on purpose: this module is a
 * pure, browserless decision table, and a VALUE import of the client package
 * would runtime-load its whole entry (React/assistant-ui/markdown) and require a
 * built `dist`. The type-only import above erases under Node type stripping.
 */
export const DEFAULT_WORKTREE_ID = "main";

/** The one key we own. Versioned, so a future shape can migrate instead of guess. */
export const SCOPE_MEMORY_KEY = "science-studio.scope.v1";

/**
 * The separator in a session key. A Worktree id is only unique within a Project
 * (`main` is reserved per Project), so the Project has to be part of the key; a
 * NUL cannot appear in either id and so can never collide with one.
 */
const SESSION_KEY_SEP = "\u0000";

/** The `sessions` key for a (Project, Worktree) pair. */
function sessionKey(projectId: string, worktreeId: string): string {
  return `${projectId}${SESSION_KEY_SEP}${worktreeId}`;
}

/** The Project id half of a session key (a key without one is its own Project). */
function sessionKeyProject(key: string): string {
  const sep = key.indexOf(SESSION_KEY_SEP);
  return sep === -1 ? key : key.slice(0, sep);
}

export interface ScopeMemory {
  version: 1;
  /** The Project the workbench was last scoped to. */
  lastProjectId: string | null;
  /**
   * Per Project: the Worktree last in effect inside it. Per-Project on purpose —
   * a single global field would let a Project switch adopt another Project's
   * same-named checkout (a Worktree id is only unique within its Project).
   */
  worktrees: Record<string, string>;
  /** Per `(projectId, worktreeId)`: the Session it last had in effect (docs/adr/0009). */
  sessions: Record<string, string>;
}

/** The scope the workbench is showing. Any part may be absent. */
export interface Scope {
  projectId: string | null;
  worktreeId: string | null;
  sessionId: string | null;
}

/** Read persisted JSON. Anything unreadable or unrecognized reads as "no memory". */
export function parseScopeMemory(raw: string | null | undefined): ScopeMemory {
  const empty: ScopeMemory = {
    version: 1,
    lastProjectId: null,
    worktrees: {},
    sessions: {},
  };
  if (!raw) return empty;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof value !== "object" || value === null) return empty;

  const candidate = value as {
    version?: unknown;
    lastProjectId?: unknown;
    worktrees?: unknown;
    sessions?: unknown;
  };
  // v1 is the only shape there is: an unversioned or future blob is not guessed at.
  if (candidate.version !== 1) return empty;

  const sessions: Record<string, string> = {};
  if (typeof candidate.sessions === "object" && candidate.sessions !== null) {
    for (const [key, sessionId] of Object.entries(candidate.sessions)) {
      if (typeof sessionId === "string" && sessionId.length > 0) sessions[key] = sessionId;
    }
  }

  const worktrees: Record<string, string> = {};
  if (typeof candidate.worktrees === "object" && candidate.worktrees !== null) {
    for (const [projectId, worktreeId] of Object.entries(candidate.worktrees)) {
      if (typeof worktreeId === "string" && worktreeId.length > 0) worktrees[projectId] = worktreeId;
    }
  }

  const lastProjectId = candidate.lastProjectId;
  return {
    version: 1,
    lastProjectId:
      typeof lastProjectId === "string" && lastProjectId.length > 0 ? lastProjectId : null,
    worktrees,
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
 * Point the memory at a scope. A scope with no Session only moves the
 * Project/Worktree — the pair's own remembered Session is not disproven by a
 * switch that is still resolving, and the caller may never get an answer (a
 * failed list must not prune: docs/adr/0009).
 */
export function rememberScope(memory: ScopeMemory, scope: Scope): ScopeMemory {
  const sessions = { ...memory.sessions };
  if (scope.projectId && scope.worktreeId && scope.sessionId) {
    sessions[sessionKey(scope.projectId, scope.worktreeId)] = scope.sessionId;
  }
  const worktrees = { ...memory.worktrees };
  if (scope.projectId && scope.worktreeId) {
    worktrees[scope.projectId] = scope.worktreeId;
  }
  return {
    version: 1,
    lastProjectId: scope.projectId,
    // A scope that names no Worktree leaves that Project's remembered one alone.
    worktrees,
    sessions,
  };
}

/** Set or clear one (Project, Worktree)'s Session — the record has answered. */
function writeSession(
  memory: ScopeMemory,
  projectId: string,
  worktreeId: string,
  sessionId: string | null,
): ScopeMemory {
  const key = sessionKey(projectId, worktreeId);
  const sessions = { ...memory.sessions };
  if (sessionId) sessions[key] = sessionId;
  else delete sessions[key];
  return {
    version: 1,
    lastProjectId: memory.lastProjectId,
    worktrees: memory.worktrees,
    sessions,
  };
}

/**
 * Drop what the record no longer lists. Only ever called with a list the record
 * actually answered with — an unreachable store is not an empty one. A
 * remembered Worktree goes only when its own Project does.
 */
export function pruneScopeMemory(memory: ScopeMemory, projects: Project[]): ScopeMemory {
  const live = new Set(projects.map((project) => project.id));
  const sessions: Record<string, string> = {};
  for (const [key, sessionId] of Object.entries(memory.sessions)) {
    if (live.has(sessionKeyProject(key))) sessions[key] = sessionId;
  }
  const worktrees: Record<string, string> = {};
  for (const [projectId, worktreeId] of Object.entries(memory.worktrees)) {
    if (live.has(projectId)) worktrees[projectId] = worktreeId;
  }
  const projectSurvives = memory.lastProjectId !== null && live.has(memory.lastProjectId);
  return {
    version: 1,
    lastProjectId: projectSurvives ? memory.lastProjectId : null,
    worktrees,
    sessions,
  };
}

export interface ProjectChoice {
  projectId: string | null;
  /**
   * The Session that Project should open: the URL's claim when the URL named the
   * Project, otherwise the remembered Session for the Project's remembered
   * Worktree. Still only a claim — `resolveSession` checks it against the
   * Worktree's own list.
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
  const worktreeId = projectId ? rememberedWorktree(memory, projectId) : DEFAULT_WORKTREE_ID;
  const sessionHint = claimed
    ? (input.claimedSessionId ?? rememberedSession(memory, claimed, worktreeId))
    : projectId
      ? rememberedSession(memory, projectId, worktreeId)
      : null;

  return { projectId, sessionHint, memory: rememberScope(memory, { projectId, worktreeId: null, sessionId: null }) };
}

/** The Worktree a Project remembers, else `main` (per-Project, so it can never leak across). */
function rememberedWorktree(memory: ScopeMemory, projectId: string): string {
  return memory.worktrees[projectId] ?? DEFAULT_WORKTREE_ID;
}

function rememberedSession(
  memory: ScopeMemory,
  projectId: string,
  worktreeId: string,
): string | null {
  return memory.sessions[sessionKey(projectId, worktreeId)] ?? null;
}

export interface SessionChoice {
  sessionId: string | null;
  memory: ScopeMemory;
}

/**
 * Pick the Session inside an already-chosen (Project, Worktree): the hint when
 * that pair's list holds it, else its NEWEST Session (Sessions list in creation
 * order), else none. A list that does not hold the hint settles it — the
 * remembered entry is dropped rather than retried on every load.
 */
export function resolveSession(input: {
  projectId: string | null;
  worktreeId: string | null;
  hint: string | null;
  sessions: Session[];
  memory: ScopeMemory;
}): SessionChoice {
  const { projectId, worktreeId, sessions } = input;
  if (!projectId || !worktreeId) return { sessionId: null, memory: input.memory };

  const hinted =
    input.hint !== null && sessions.some((session) => session.id === input.hint) ? input.hint : null;
  const sessionId = hinted ?? sessions[sessions.length - 1]?.id ?? null;

  return { sessionId, memory: writeSession(input.memory, projectId, worktreeId, sessionId) };
}

/**
 * Pick the Worktree to open inside an already-chosen Project: the URL's claim
 * when the Project's list holds it, else the Worktree that PROJECT remembered
 * (`memory.worktrees[projectId]`) when it is still listed, else `main`. A claim
 * the record does not list is never opened (docs/adr/0025); the returned memory
 * remembers the pick under the Project, so it can never leak to another one.
 */
export function resolveWorktree(input: {
  projectId: string | null;
  claimedWorktreeId: string | null;
  memory: ScopeMemory;
  worktrees: Worktree[];
}): { worktreeId: string; memory: ScopeMemory } {
  const listed = new Set(input.worktrees.map((w) => w.id));
  const rememberedForProject = input.projectId
    ? input.memory.worktrees[input.projectId]
    : undefined;
  const claimed =
    input.claimedWorktreeId !== null && listed.has(input.claimedWorktreeId) ? input.claimedWorktreeId : null;
  const remembered =
    rememberedForProject !== undefined && listed.has(rememberedForProject) ? rememberedForProject : null;
  const worktreeId = claimed ?? remembered ?? DEFAULT_WORKTREE_ID;
  const worktrees = { ...input.memory.worktrees };
  if (input.projectId) worktrees[input.projectId] = worktreeId;
  return { worktreeId, memory: { ...input.memory, worktrees } };
}

/**
 * The URL of a scope: the deep-link route when it names all three parts, else
 * the SPA home (a scoped route with no Session does not exist).
 */
export function scopePath(scope: Scope): string {
  return scope.projectId && scope.worktreeId && scope.sessionId
    ? `/projects/${encodeURIComponent(scope.projectId)}/worktrees/${encodeURIComponent(scope.worktreeId)}/sessions/${encodeURIComponent(scope.sessionId)}`
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
