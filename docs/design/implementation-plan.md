# Research Agent Framework — Implementation Plan

Status: active — **Phase 0 implemented** (`npm run build` green; 113 tests
across 7 suites green). Companion to [`research-agent-framework.md`](./research-agent-framework.md)
(design rev 4) and [`research-agent-framework.zh.md`](./research-agent-framework.zh.md).

Strategy: **single-user first, end to end.** Multi-user is never built now; it
only ever *implements seam interfaces* reserved in the OSS core. Every phase
below must leave the OSS product complete, building, and green with no
enterprise module present.

---

## 1. Seam-types rule (correction to design §11)

The design placed seam interfaces across three packages, which would make
`transport` reference `Workspace` from `workspace` while `workspace` references
`transport` — a cycle. Fix: **all seam *interfaces* live in
`@science-studio/transport`; implementations live in their own packages.**

| Package | Holds | Depends on |
| --- | --- | --- |
| `packages/transport` | `RuntimeAdapter`, `Workspace`, `Principal`/`PrincipalResolver`, `Environment`/`EnvironmentProvider`, `Sandbox`/`SandboxProvider`, `RuntimeBinding`/`RuntimeFactory`/`RuntimeCapabilities`, `QuotaPolicy`, `SecretStore`, the `Transcript`/`RunFlow` kit, and pure adapters (`LocalPrincipalResolver`, `CachingEnvironmentProvider`, `NullWorkspace`) | `record` only |
| `packages/workspace` | `FsWorkspace`, file-reference grammar, limits enforcement | `transport` |
| `packages/sandbox` | `LocalSandboxProvider`, `DshSandboxProvider` | `transport` |
| `packages/transport-openclaw` / `-dsh` | binding types + factories + adapters | `transport` |
| `services/transport-service` | Fastify plugins, composition root, routes | `transport`, `workspace`, `sandbox` |

No cycles; a runtime package and the private enterprise module both sit at the
same level, implementing `transport` interfaces.

## 2. What "single-user done" means

A local install with no login:

- browser → **one Fastify process** (`transport-service`) → openclaw or dsh
  adapter, chosen by configuration;
- a **workspace file service** on the same process: browse a session directory,
  `@`-mention files/directories as references, open agent-returned file links;
- records in an in-memory/local store; artifacts reserved;
- **zero enterprise code loaded**, and the test suite is green with
  `SS_ENTERPRISE_MODULE` unset.

## 3. Reserved extension points

Every seam has a working single-user default today and a known multi-user
implementation later. This is the whole multi-user readiness story: we reserve
the *shape*, not the implementation.

| Seam (in `transport`) | Single-user default (OSS) | Future multi-user (private module) |
| --- | --- | --- |
| `PrincipalResolver` | `LocalPrincipalResolver` (constant, no credential) | `BearerPrincipalResolver` (OIDC/JWKS + directory) |
| `EnvironmentProvider` | `LocalEnvironmentProvider` (one adapter) | `CachingEnvironmentProvider` + `FleetSandboxProvider` |
| `RuntimeFactory` | registered from config; openclaw + dsh factories | same mechanism, unchanged |
| `Workspace` | `FsWorkspace` rooted at a local dir | `FsWorkspace` over a cell bind-mount |
| `QuotaPolicy` | no-op (or local `quotaBytes`) | per-tenant usage ledger + reconciler |
| `SecretStore` | mode-`0600` file | secret manager / keychain |
| `SandboxProvider` | `LocalSandboxProvider` | `FleetSandboxProvider` + `SandboxRegistry` |
| `RecordStore` | `createInMemoryRecordStore()` | per-tenant Postgres schema |

## 4. Phases

### Phase 0 — seams + Fastify (no behavior change) — ✅ done

Goal: the service is Fastify, everything goes through the principal/environment
preamble, and runtimes plug in through factories. Wire contract unchanged.

1. ✅ `packages/transport`: `workspace.ts` (`Workspace` types, `WorkspaceLimits`,
   `NullWorkspace`, `QuotaPolicy`), `principal.ts` (`Principal`,
   `PrincipalResolver`, `LocalPrincipalResolver`), `environment.ts`
   (`Environment` incl. `sessionKey`, `EnvironmentProvider`,
   `LocalEnvironmentProvider`), `runtime.ts` (`RuntimeBinding`,
   `RuntimeFactory`, `RuntimeCapabilities`, `RuntimePlugin`); exported.
   (`CachingEnvironmentProvider` deferred to Phase 3 — single-user needs no cache.)
2. ✅ `transport/src/types.ts`: `RuntimeInitOptions` drops `gateway` for `binding`
   (+ optional `workspace`, `env`); `RuntimeAdapter.approve` is optional.
3. ✅ `transport-openclaw`: `binding.ts` (`GatewayBinding`,
   `parseGatewayBinding`, `openClawLocalBinding`, `OPENCLAW_CAPABILITIES`) +
   `createOpenClawRuntimeFactory()` + `runtimePlugins`; `init()` reads the
   binding. Test `init()` sites migrated.
4. ✅ `transport-dsh`: `binding.ts` (`DshBinding`, `dshLocalBinding`,
   `DSH_CAPABILITIES`) + `createDshRuntimeFactory()` + `runtimePlugins`; the
   no-op `approve()` is gone (capabilities say `approvals: false`).
5. ✅ `transport-service`: Fastify (`createServer`) with a `preHandler` principal
   hook and CORS; `composition.ts` (`createBackend()` = local default,
   `SS_ENTERPRISE_MODULE` dynamic import, `resolveRuntimePlugins`). Routes hijack
   the Node response for SSE/NDJSON. `createTransportService()` keeps a
   `{ adapters }` compat path for the examples/tests.
6. ✅ `packages/contract-tests`: the shared seam conformance suites
   (`testPrincipalResolver`, `testWorkspace`, `testRuntimeFactory`,
   `testQuotaPolicy`), self-tested against the OSS reference implementations (14
   tests) and ADOPTED by transport-openclaw / transport-dsh for the factory
   contract.

**Done when:** `npm run build` passes; `npm run test` is green with
`SS_ENTERPRISE_MODULE` unset; the service starts without waiting on the runtime
(verified: ~100 ms with an unreachable gateway) and `/api/transport` still
streams frames terminating with `data: [DONE]`.

### Phase 1 — workspace file service (single-user) — ✅ done

7. ✅ `packages/workspace`: `FsWorkspace` implements the seam with the
   containment/symlink/size invariants under test (11 tests). The service's
   `localWorkspace()` wires it from `WORKSPACE_ROOT` (+ `WORKSPACE_AGENT_ROOT`,
   `WORKSPACE_MAX_INLINE_BYTES`); unset means `NullWorkspace` and no file
   surface. `maxUploadBytes` enforcement lands with the upload route.
8. ✅ `services/transport-service`: **read-only** workspace routes
   (`GET /api/workspace/{entries,stat,file}`), resolved through the environment.
   Errors map onto HTTP: path/escape → 400, missing → 404, over the inline cap →
   413 (and `?download=1` streams any size), no workspace → 503.
9. ✅ `apps/web` + `transport-client`: `useWorkspaceBrowser` / `useWorkspaceFile`,
   `resolveFileReference` + `WorkspaceOpenProvider` (agent file links open in the
   in-app viewer), the markdown `a` override, `artifact` → a `file` chip in the
   converter, the `WorkspacePanel` (browser + text preview + download), and the
   `app/api/workspace/[...path]` streaming proxy. Text inline, download for
   everything else — no binary preview in v1.

**Upload is deliberately NOT here**: it needs a `Workspace.write` method and
quota accounting, and it only earns its keep once `@`-attachments exist (a
workspace file is a *reference*; an upload is for a file not yet in the
workspace). It moves to Phase 2.

### Phase 2 — attachments, upload, and run control — 🟡 in progress

10. ✅ `packages/transport`: `AttachmentRef`, the `file` `MessagePart` variant, and
    `TransportCommand.add-message.attachments`; `normalizeCommands` now lifts
    file-bearing parts into attachments, accepting BOTH the domain part shape
    (`path`/`name`) and assistant-ui's `FileMessagePart`
    (`filename`/`data`/`mimeType`). The converter also renders a `file` part as a
    chip carrying its workspace path.
11. 🟡 Adapters render references: shared `renderAttachments` /
    `promptWithAttachments` / `userMessageParts` (transport) now make a workspace
    attachment a `file` part on the echoed user message AND a path block in
    `chat.send` / the dsh prompt, mapped through `workspace.toAgentPath()`. The
    composer `@` picker (files and directories as references) is next.
12. ⬜ `Workspace.write` + `POST /api/workspace/upload` (multipart), enforcing
    `maxUploadBytes` (413) and consulting `QuotaPolicy`; an upload lands in the
    workspace and then travels as an ordinary reference.
13. ✅ Per-session run lock (a second concurrent run is refused with 409, so
    `Transcript.attachFlow` can never overwrite a live flow) and
    `POST /api/transport/{abort,approve}` — `/approve` answers 501 when the
    adapter has no approval surface.

### Phase 3 — enterprise module (private repo, later)

14. `@acme/ss-enterprise`: `BearerPrincipalResolver` + `PrincipalDirectory`,
    `SecretStore`, `FleetSandboxProvider` + `SandboxRegistry`,
    `SchemaRecordStore`, `QuotaPolicy`, enterprise Fastify plugin; wired via
    `SS_ENTERPRISE_MODULE`.
15. Control schema + migration runner; two-tier quotas.
16. Origin-locked CORS; login gate + quota meters in the web UI slot.

## 5. Guardrails (CI)

1. No OSS package depends on any enterprise artifact or names
   `SS_ENTERPRISE_MODULE` outside `composition.ts`.
2. No OSS core package statically imports a runtime package; runtimes are
   registered from configuration.
3. Adding a runtime package touches no core package (enforced by a dependency
   check).
4. The suite is green with `SS_ENTERPRISE_MODULE` unset.
5. The private repo runs the OSS `contract-tests` suites
   (`@science-studio/contract-tests`) — implemented, and already adopted by the
   two OSS runtime packages.

## 6. Sequencing notes and risks

- **Fastify must not buffer the SSE path.** The transport route hijacks the Node
  response (`reply.hijack()` + `reply.raw`); the watch route is NDJSON and never
  ends. `app.inject()` cannot test an endless response, so the watch test keeps
  a real `listen(0)`.
- **`RuntimeInitOptions` is a breaking change** to ~13 existing test call sites
  (openclaw and dsh); migrate them in the same change as the adapters.
- **Single-user first means no auth branching.** The local resolver returns a
  constant; nothing in the service or UI may assume a credential exists.
- **Reserve, don't build.** No `SandboxProvider` fleet work, no bearer resolver,
  no Postgres in this repo until Phase 3 lands in the private repo.
