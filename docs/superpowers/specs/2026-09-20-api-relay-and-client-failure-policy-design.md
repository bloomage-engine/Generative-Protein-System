# The `/api` hop relays; the client surface owns failure policy — design

## Problem

A transient failure is silently turned into a success at two hops, so the client
surface that is supposed to own the failure decision can never run it:

1. **Subagents.** The web proxy (`apps/web/app/api/transport/subagents/route.ts`)
   rewrites any non-2xx into `200 {subagents: []}`, and the transport-service
   route behind it (`server.ts`) rewrites an adapter throw into
   `200 {subagents: []}` too. `useSubagents`' documented "a failed poll keeps the
   last good list" is therefore unreachable: a transient service failure blanks a
   DURABLE subagent ledger that docs/adr/0016 says survives restarts.
2. **Command Catalog.** The proxy carries the same reshape, documented in
   AGENTS.md as "the ONE hop with a policy of its own" — but `useRuntimeCommands`
   already degrades to `[]`, so the proxy copy is redundant.
3. **Skills.** The service masks an adapter throw as `available: true,
   skills: []`, and `fetchSkills` degrades ANY failure to `available: false`, so
   a dead service renders the Runtime copy "Skills are available on the dsh
   runtime".

The workspace UI already depends on the opposite invariant:
`isWorkspaceUnavailable` is exactly `WorkspaceRequestError.status === 503`, so a
proxy that reshaped a failure would break the unavailable classification.

## Decisions

### D1 — Verbatim at BOTH layers; transient failures are 500

- The service route does not catch an adapter failure into an empty payload;
  the web proxy does not rewrite a non-2xx into a 200. Server-side diagnosis
  survives: the route **logs and rethrows** (`console.error(...)` then `throw`),
  matching the existing diagnostic style.
- The status is **500** — the adapter is in-process, not a gateway, so no `502`
  fiction.
- The routes affected in the service: `/api/transport/subagents` (list),
  `/api/transport/subagents/:childId/transcript` (its catch currently answers
  404 for a thrown read; a throw becomes 500, while the no-surface 404 and the
  `null` → 404 stay), `/api/transport/commands`, and `GET /api/skills`.
- The web proxies affected: `transport/subagents` and `transport/commands`
  (both reshape today); every other hop already relays verbatim.

### D2 — "No surface" is a successful answer, not a failure

The service's capability checks stay exactly as they are: a runtime without
`subagents` / `listCommands` answers a successful empty payload, a runtime
without `skills` answers `available: false`, and a runtime without
`subagentTranscript` answers 404. Only a real adapter throw becomes a 5xx. This
keeps the panel's neutral empty state for openclaw and prevents a runtime
branch at the client.

### D3 — The client surface owns the decision

No hook changes for the keep-last surfaces; the change makes their existing
policy reachable:

| Surface | Owner | Policy |
| --- | --- | --- |
| Subagents list | `useSubagents` | keep the last good list (already implemented) |
| Subagents window | `useSubagentsWindow` | keep 24 h (already implemented) |
| Command Catalog | `useRuntimeCommands` | degrade to `[]` (already implemented) |
| Cron tasks | `useCronTasks` | keep last, surface error (already) |
| Session metrics | `useSessionMetrics` | keep last (already) |
| Skills catalog | `SkillsTab` via `fetchSkills` | **new**: transport failure → error state + Retry; `available:false` → the Runtime copy |

`fetchSkills` stops swallowing: it throws `SkillsRequestError` on a non-2xx
(the same class `installSkill` / `removeSkill` already throw), and
`SkillsTab.load()` catches into an error state with a **Retry** button (the tab
has no polling, so otherwise a failure can only be retried by remounting it).
`available: false` now means exactly one thing: the service answered that the
runtime has no skills surface.

### D4 — The Command Catalog exception is removed

The commands proxy's reshape is deleted; `useRuntimeCommands`' catch is the
single owner. AGENTS.md's "the ONE failure policy" sentence is replaced by the
universal rule.

## Components

| Area | Change |
| --- | --- |
| service | `services/transport-service/src/server.ts` — subagents list, subagent transcript, commands, skills GET: keep the capability check, replace the catch→empty with log+rethrow |
| web proxy | `apps/web/app/api/transport/subagents/route.ts`, `apps/web/app/api/transport/commands/route.ts` — drop the non-2xx reshape; relay `proxyToService`'s response directly; update the header comments |
| client | `packages/transport-client/src/skills.ts` — `fetchSkills` throws `SkillsRequestError` on failure (keep the return type) |
| web UI | `apps/web/components/studio/skills-tab.tsx` — `load()` catches into `error`; render a failed load as an error block with a Retry button, distinct from the `available:false` copy |
| docs | `docs/adr/0021-...md` (new); AGENTS.md — replace the commands-exception line with the universal rule |

## Error handling

- **Adapter throw** → the service logs and lets Fastify answer 500 → the proxy
  relays 500 → the client surface keeps its last good value (or shows its error
  state). No hop invents a success.
- **No surface** → 200 with an empty/`available:false` payload (subagents,
  commands, skills) or the documented 404 (transcript). Unchanged.
- **`null` transcript** → 404 "the subagent record is not available". Unchanged.
- **Skills install/remove** → unchanged (typed `SkillInvalidError` /
  `SkillExistsError` / `SkillNotFoundError` / `WorkspaceUnavailableError` →
  400/409/404/503).

## Tests

- **service** (`transport-service/test/subagents.test.ts`): the
  "degrades to empty when the adapter throws" test becomes "propagates the
  failure" — a throwing adapter answers 500, not 200; the no-surface case keeps
  answering `200 {subagents: []}`. Add the equivalent to
  `skills-routes.test.ts` (a throwing `skills()` answers 500; a missing member
  still answers `available:false`) and cover a throwing `listCommands` (500) and
  a throwing `subagentTranscript` (500, while a missing member stays 404).
- **client** (`transport-client/test/skills.test.ts`): "degrades to unavailable
  on a failed hop" becomes "throws `SkillsRequestError` on a failed hop"; add a
  `fetchSubagents` 500 case beside its 404 test.
- **web e2e**: a new `apps/web/test/subagents-keep-last.test.mjs` — the
  Subagents route answers one running row, then 500s; after a second poll the
  row is still shown (the keep-last regression). The skills tab test gains a
  failed-load branch: a 500 shows the error + Retry, and Retry recovers.

## Out of scope

- The shared `jsonRequest` / `RequestError` unification (a separate deepening):
  each surface keeps its current error shape; only who throws vs degrades
  changes.
- A `runtimeSurfaces` capability resolver (a separate deepening) — the service
  keeps its `typeof` checks.
- A route-handler unit-test harness for `apps/web` (the e2e covers the hook, the
  service tests cover the route, and the shared `service-proxy` policy covers
  the relay).
- No contract-type change, no record change.