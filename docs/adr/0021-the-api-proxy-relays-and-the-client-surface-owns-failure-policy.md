# The `/api` hop relays, and the client surface owns failure policy

Every `/api` hop relays the upstream's status and body **verbatim** — the web
proxy under `apps/web/app/api/*` and the transport-service route behind it
alike. No hop rewrites a failure into a success. The client surface's fetch or
hook owns the failure decision (keep the last good value, reset, or surface an
error). A runtime lacking an optional surface is **not** a failure: the service
answers a successful empty payload (`subagents`, `commands`) or an explicit
`available: false` (`skills`).

- **Status**: accepted
- **Context**: the relay policy already lived in one module
  (`apps/web/lib/service-proxy.ts`: base URL, forwarded auth, verbatim
  status/body), and the workspace UI depends on it — `isWorkspaceUnavailable` is
  exactly `WorkspaceRequestError.status === 503`, so a proxy that reshaped a
  failure would break the unavailable classification. But two hops had grown
  private policies that violated it: the Subagents web proxy turned any non-2xx
  into `200 {subagents: []}` and the transport-service route behind it turned an
  adapter throw into `200 {subagents: []}` too, so `useSubagents`' documented
  "a failed poll keeps the last good list" was unreachable — a transient
  service failure silently blanked a DURABLE subagent ledger that docs/adr/0016
  says survives restarts. The Command Catalog proxy carried the same reshape and
  was documented in AGENTS.md as "the ONE hop with a policy of its own", but its
  hook already degrades to `[]` — the proxy copy was redundant. The Skills read
  was a third case: the service masked an adapter throw as
  `available: true, skills: []`, and `fetchSkills` degraded any failure to
  `available: false`, so a dead service rendered the Runtime copy "Skills are
  available on the dsh runtime".
- **Decisions**:
  - **Verbatim at BOTH layers.** A service route does not catch an adapter
    failure into an empty payload, and a web proxy does not rewrite a non-2xx
    into a 200. An adapter throw is a **500** (the adapter is in-process, not a
    gateway, so no `502` fiction). Server-side diagnosis is preserved: the route
    logs the failure and rethrows rather than swallowing it.
  - **"No surface" is a successful answer, not a failure.** The service's
    capability checks stay: a runtime without `subagents`/`listCommands`
    answers a successful empty payload so the panel needs no runtime-specific
    branch, and a runtime without `skills` answers `available: false`. Only a
    real throw becomes a 5xx.
  - **The client surface owns the decision.** `useSubagents` keeps the last good
    list (the behaviour its comment always promised); `useSubagentsWindow` keeps
    the 24 h default; `useRuntimeCommands` degrades to an empty catalog;
    `useCronTasks` / `useSessionMetrics` keep last; the Skills tab SEPARATES a
    transport failure (an error state with a Retry) from `available: false`
    (the runtime has no skills surface). The shared `jsonRequest`/`RequestError`
    unification is a separate deepening, deliberately NOT part of this one.
  - **The Command Catalog exception is removed.** Its proxy reshape is deleted;
    `useRuntimeCommands`' existing catch is the single owner. AGENTS.md's "the
    ONE failure policy" line is replaced by the universal rule.
- **Consequences**: no contract type changes and no record change — this is
  behaviour at the hop boundaries. A transient failure now reaches the browser
  as a 5xx and the affected surface keeps its last good value instead of
  blanking; the workspace's 503 classification keeps working by the same
  invariant. Tests change where they pinned the old mask: the service's
  "degrades to empty when the adapter throws" becomes "propagates the failure",
  the client's `fetchSkills` "degrades to unavailable" becomes "throws", and a
  web end-to-end regression pins that a failed Subagents poll does not clear the
  panel.