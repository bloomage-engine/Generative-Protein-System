/**
 * The client's ONE spelling of a request's scope — the `(Project, Worktree,
 * Session)` claim every scoped route reads (docs/adr/0009, 0025).
 *
 * The service resolves a request's scope in exactly one place
 * (`services/transport-service/src/project-scope.ts`): the query first, then the
 * body, `projectId`/`worktreeId`/`threadId`, with the Project's `main` worktree
 * and the default Project as fallbacks. The client had no such module — every
 * hook re-derived the query by hand, and the spellings drifted (`project=` in
 * the workspace helpers, `projectId=` elsewhere; the Worktree dropped from some
 * surfaces; key order differing between two `URLSearchParams` builders). This
 * module is that missing home.
 *
 * Scope RESOLUTION is NOT here: which Project/Worktree/Session a browser last
 * worked in stays in `apps/web/lib/scope-memory.ts` and `studio-store.ts`
 * (docs/adr/0009). This module only turns an already-resolved scope into wire
 * bytes — a query, a body claim, or a URL.
 */

/** The claim a scoped request carries. `projectId` is required (nullable). */
export interface ClientScope {
  projectId: string | null;
  /** The Worktree whose checkout the request acts on; omitted → the service's `main`. */
  worktreeId?: string | null;
  /** The Session claim (a runtime session key, 1:1 with the record id). */
  threadId?: string | null;
}

/**
 * The claim keys, in the order the query emits them. Fixed so two callers with
 * the same scope produce byte-identical URLs (the previous builders disagreed).
 */
const CLAIM_KEYS = ["projectId", "worktreeId", "threadId"] as const;

/** The values of the EXTRA params {@link scopedUrl} appends before the scope. */
export type ScopeQueryParams = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * The scope as a query string, WITHOUT a leading `?`. Empty/absent claims are
 * omitted, so a scope that names nothing yields `""` (the service falls back to
 * its defaults — docs/adr/0025).
 */
export function scopeQuery(scope: ClientScope): string {
  const params = new URLSearchParams();
  for (const key of CLAIM_KEYS) {
    const value = scope[key];
    if (typeof value === "string" && value.length > 0) params.set(key, value);
  }
  return params.toString();
}

/**
 * Append the scope to a URL that may ALREADY carry a query (the file routes
 * build `?path=…` first). This is the one place the `?`-vs-`&` decision is made;
 * getting it wrong on a base with a query produced a malformed URL.
 */
export function withScope(url: string, scope: ClientScope): string {
  const query = scopeQuery(scope);
  if (query === "") return url;
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

/**
 * A scoped URL for `api + path`, with optional non-scope params first (e.g.
 * `{ path, download }`). `true` renders as `1` (the existing `download=1` /
 * `includeArchived=1` convention); `false`/`null`/`undefined`/`""` are omitted.
 * A trailing slash on `api` is trimmed so `${api}/entries` is well-formed.
 */
export function scopedUrl(
  api: string,
  path: string,
  scope: ClientScope,
  params?: ScopeQueryParams,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined || value === false || value === "") continue;
    search.set(key, value === true ? "1" : String(value));
  }
  const query = search.toString();
  return withScope(`${trimSlashes(api)}${path}${query ? `?${query}` : ""}`, scope);
}

/**
 * The scope as a request BODY claim — for the routes that carry it in JSON
 * rather than the query (a Session create, the mount probe). The service reads
 * the body only when the query names nothing, so a URL-scoped request never
 * depends on this (docs/adr/0009's probe puts the scope in both).
 */
export function scopeBody(scope: ClientScope): Record<string, string> {
  const body: Record<string, string> = {};
  for (const key of CLAIM_KEYS) {
    const value = scope[key];
    if (typeof value === "string" && value.length > 0) body[key] = value;
  }
  return body;
}

/** Trim trailing slashes so joining a leading-`/` path never doubles them. */
function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}
