# The workbench resumes a scope it only trusts after the record confirms it

Until now the workbench had **no memory of where the user was**. The URL was a
one-shot seed: the deep-link route (`/projects/<id>/sessions/<id>`) passed its
params down, and the SPA home `/` adopted `projects[0]` and *its* `sessions[0]`.
Every switch (Project, Session, create) was a pure store write — no writer ever
went back to the URL, and nothing survived a reload. So a refresh always reset to
the oldest Project (in practice the auto-ensured `project-default`) and that
Project's OLDEST Session, whatever the user had been working in.

The fix is deliberately not "navigate to the scoped route on every switch".
`/` and `/projects/[projectId]/sessions/[sessionId]` are different route
segments: a router navigation replaces the whole page subtree, which remounts the
component that owns `useTransport` — the one thing this architecture forbids
(ADR-0005's memoized runtime owner). The mount probe would re-import the
transcript, and a switch made mid-run would hit the service's one-in-flight-run
409 for that session, so the probe would never import at all. The URL is
therefore MIRRORED with `window.history.replaceState`, which gives the same
refresh-safe, shareable URL with no React involvement whatsoever.

The second constraint is harder. **A remembered id must be validated against the
record before it is opened.** `POST /api/transport` resolves a claimed session key
through `resolveOrCreateSession`, which MINTS the Session row (and its Project
row, named after the raw id) for a key it does not know; `projectOf()` has no
existence check either, and the record surface's only refusing path is the
explicit `POST /api/projects/:id/sessions` (404 for an unknown Project). So an
optimistically opened stale id — a cleared record store, a bookmark with a typo,
a browser that remembers a Project someone archived — does not fail: it
fabricates exactly the rows it claims to resume, in the authoritative JSONL. The
workbench therefore resolves the scope BEFORE the shell renders, so the runtime
(whose mount probe *is* the minting request) never mounts on an unvalidated
Session. A record that does not answer shows the error instead of guessing — a
failed fetch proves nothing, so the memory is left untouched.

The scope lives in `localStorage` (`science-studio.scope.v1`), one versioned blob
`{ lastProjectId, sessions: { <projectId>: <sessionId> } }` — per Project, so
returning to a Project returns to the Session it was on. Resolution prefers the
URL's claim when the record lists it, else the remembered Project when it still
exists, else the first Project; the Session is the claim when that Project's list
holds it, else the Project's newest Session, else none (which lands on the
Projects pane, since only a Session is conversable). Only an AUTHORITATIVE "no"
prunes: an id absent from a list the record returned is dropped from the memory,
while an unreachable record drops nothing.

> **Amended by ADR-0025 (Worktree).** The blob grew a Worktree dimension:
> `{ version: 1, lastProjectId, worktrees: { <projectId>: <worktreeId> },
> sessions: { "<projectId>\u0000<worktreeId>": <sessionId> } }`. A session key is
> the `(projectId, worktreeId)` pair joined by NUL — a Worktree id is unique only
> within its Project, so the Project has to be part of the key — and `worktrees`
> is keyed per Project for the same reason. Resolution is now three levels —
> Project, then Worktree, then Session: the URL's Project when the record lists
> it, else the remembered Project, else the first Project; the URL's Worktree when
> THAT Project's worktree list holds it, else the Project's remembered one, else
> `main`; then the Session from that `(Project, Worktree)` pair's own list, else
> its newest, else none. The rationale above is unchanged: a claim neither the
> record nor a list confirms is never opened, the URL is still mirrored with
> `history.replaceState`, and only an authoritative "no" prunes. A deep-link now
> also pays the Project's Worktree list before the Sessions it already fetched.

- **Status**: accepted
- **Considered options**:
  - *A `lastOpenedAt` on the record, or "most recent Session" as a record query* —
    the record layer has no such field and no ordering query, and adding one would
    put a UI preference in the authoritative record: the JSONL store is an
    append-only log, `Session.updatedAt` is written once at creation and never
    bumped, and rows carry no owner/principal, so the answer could not even be
    per-user in a hosted install.
  - *URL-only persistence (navigate on switch, no storage)* — a bare `/` has
    nothing to resume, and `/` is the surface the reset was reported on; it would
    also make every switch a page-level navigation, i.e. the remount above.
  - *Adopt the remembered scope optimistically and let the service sort it out* —
    this is the minting path: the probe would create a Project row named after a
    dead id plus a Session row for it, so the failure mode is silent record
    corruption rather than a visible error.
  - *`sessionStorage` (one scope per tab)* — loses the most common case: a new tab
    or a reopened window wanting the Project/Session the user was last in.
  - *A record-backed or cookie-backed "last scope" instead of `localStorage`* —
    the record stays clean (above); a cookie would ride every request for a value
    only the client reads, and hosted mode would still need a principal to key it.
  - *Adding `/projects/[projectId]` so the URL can name a Project with no
    Session* — a `replaceState` to a route that does not exist would 404 on the
    next reload, and the memory already covers that state.
- **Consequences**: `apps/web` gains its first URL writer — `setScope` in
  `studio-store.ts` is now the ONLY way the scope changes, and it moves the store,
  the memory and the URL together, so none of the three can drift. The seeding
  effect gates the shell on the resolution: a deep-link now pays one round trip
  (the Project list, and that Project's Sessions) before the conversation mounts,
  where it used to seed synchronously. Scope changes are per-tab last-write-wins;
  no `storage` event is listened to, because a live cross-tab scope change is
  another remount of the runtime. The "that Project's newest Session" rule has one
  home (`resolveProject`/`resolveSession` in `lib/scope-memory.ts`), used by both
  the cold load and an in-pane Project switch. Tabs, `leftView` and panel
  visibility are deliberately still NOT persisted. Open item: the URL is mirrored,
  never navigated, so Next's client router would disagree about the current URL
  were a `router.push`/`<Link>` navigation ever added — none exists today, and
  nothing reads `usePathname`/`useSearchParams`.
