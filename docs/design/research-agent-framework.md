# Research Agent Framework — Design

> Chinese translation: [`research-agent-framework.zh.md`](./research-agent-framework.zh.md).

Status: proposed (rev 4). Audience: maintainers of `packages/*`,
`services/transport-service`, `apps/web`. Vocabulary: `codebase-design` (module /
interface / seam / adapter / depth). Domain terms: `/CONTEXT.md`.

This document designs the two capabilities Science Studio is missing on top of
the existing transport seam:

1. **Deployment modes** — one local single-user install (no login, runtime on
   the user's machine) and one hosted multi-user service (runtime per user, on
   the server, in an isolated sandbox), behind **one frontend and one wire
   protocol**.
2. **A workspace file service** — browse the session working directory, pass
   files to the agent with `@`, and open files the agent returns.

It keeps the existing seams (assistant-ui transport protocol, `RuntimeAdapter`,
`Transcript`/`RunFlow`, record ownership) unchanged in *shape*, and adds new
modules around them.

The backend service is **Fastify**. The multi-user capability is a **private
enterprise module that is not in the open-source repo**; the OSS core stays a
complete, unaffected single-user product (§9.2). The runtime layer is
deliberately **plural**: openclaw and dsh are two adapters behind one seam, and
adding a third must not touch the core (§4.3).

---

## 1. Forces

- **One UI, one protocol, many backends.** `apps/web` renders the assistant-ui
  Thread over `useTransport`; `POST /api/transport` is command-in /
  state-snapshot-out. Neither may learn about deployment mode, tenancy, or
  sandboxing.
- **Mode is a backend composition concern.** Single vs multi user differs only
  in *who the caller is* and *where their runtime+files live*. It must not leak
  as a branch through the service, adapters, or UI.
- **The agent already has a filesystem.** For every runtime we ship, the agent
  runs with a working directory and file tools (`Workspace`/cwd in `CONTEXT.md`).
  So a file handed to the agent is a **reference** to something it can already
  open, not an upload.
- **Multi-tenancy is a hostile boundary.** openclaw `fleet` explicitly warns
  that one shared Gateway is not a multi-tenant boundary; each trust boundary
  gets its own **cell**. Science Studio must map that honest boundary, not
  pretend to be stronger than it is.
- **Open core.** The OSS repo must remain a complete single-user product. The
  enterprise module plugs into OSS-declared seams from out of tree; OSS never
  depends on it, and its absence changes nothing for a single-user install.

## 2. What must not change

| Existing seam | Why it stays |
| --- | --- |
| assistant-ui transport protocol (`useAssistantTransportRuntime`) | The UI is a stateless view; `converter` is runtime-agnostic. |
| `RuntimeAdapter` (`packages/transport/src/types.ts`) | Runtime swap stays an adapter swap. |
| `Transcript` + `RunFlow` kit | Adapters keep sharing one fold-and-fan-out; no re-implementation. |
| Reconcile-first + standing watch | History convergence semantics; untouched. |
| Record ownership (`docs/adr/0002`) | Science Studio owns `Run`/`Artifact`, not the runtime. |
| The assistant-transport wire (SSE frames, `[DONE]`) | Migrating to Fastify is an implementation change, not a protocol change. |

The design **adds** seams; it does not move these.

## 3. Resolved decisions

Confirmed after the first review; these drive the rest of the document.

| Question | Decision |
| --- | --- |
| openclaw gateway file API | **None.** File access is host-side over the cell's bind-mount; a gateway-proxied workspace is rejected, not deferred (§13). |
| Record persistence + tenant isolation | **Per-tenant Postgres schema.** |
| Hosted login | **Bearer token.** |
| Upload limit / storage quota | **Configurable.** Defaults: upload **100 MB**, quota **2 GB**. |
| Binary file preview | **Out of scope for v1** — text renders inline, everything else is download-only. |
| `@`-mention of a directory | **Stays a reference** (no expansion). |
| Backend framework | **Fastify.** |
| Open-core boundary | **Multi-user is a private enterprise module**; OSS repo stays single-user-complete and is never affected by its absence. |
| Runtime plurality | **Opaque `RuntimeBinding` + a factory registry**; openclaw and dsh are two adapters, and a third touches no core package (§4.3–4.4). |

## 4. The new seams

Before the seams, the service hardwired "one process = one runtime = one user":
`resolveAdapter()` always returned `adapters[0]`
(`services/transport-service/src/index.ts`), and an adapter's `init()` bound a
single gateway from `process.env`. That left no place for per-tenant routing or
for identity. The fix is a handful of small interfaces, implemented in Phase 0
(see [`implementation-plan.md`](./implementation-plan.md) for live status).

### 4.1 `Principal` — identity as a seam, not a mode

```ts
// packages/transport/src/principal.ts  (new)
export type Role = "researcher" | "manager";

export interface Principal {
  /** Stable user id; a constant in single-user mode. */
  id: Id;
  /** Trust boundary that owns this principal's sandbox. Equals `id` locally. */
  tenant: string;
  displayName: string;
  roles: readonly Role[];
  /** True when the deployment grants this identity without a credential. */
  local: boolean;
}

/** The minimal request facts a resolver may read — keeps it framework-free. */
export interface RequestContext {
  headers: Readonly<Record<string, string | undefined>>;
  url: string;
}

export interface PrincipalResolver {
  /** Resolve the caller, or null to reject (the HTTP layer answers 401). */
  resolve(req: RequestContext): Promise<Principal | null>;
}
```

Two adapters, one interface:

- `LocalPrincipalResolver` (OSS) — returns a constant
  `{ id: "local", tenant: "local", local: true, roles: ["researcher","manager"] }`.
  No cookie, no header, no login. **This is the entire "single-user is
  login-free" requirement.**
- `BearerPrincipalResolver` (enterprise, out of tree) — verifies a bearer token
  and maps its claims to a principal with a real `tenant`. Login terminates at
  the web app, which obtains the token; the service only validates it.

Inquiries a caller can answer after this: *who is this* and *which tenant are
they*, in one call. Nothing else.

### 4.2 `Environment` — what a principal's session gets

This is the central deep module. It is the single place that answers: *which
runtime binding and which file root does this request use?*

```ts
// packages/transport/src/environment.ts  (new)
export interface Environment {
  readonly adapter: RuntimeAdapter;
  readonly workspace: Workspace;
  /** The canonical session key the adapter resolved for the requested threadId. */
  readonly sessionKey: string;
}

export interface EnvironmentProvider {
  /**
   * Get or lazily build the environment for a principal's session. `threadId`
   * is the raw client claim (null for the mount probe); the provider maps it
   * through the selected adapter's `resolveSessionKey`.
   */
  acquire(principal: Principal, threadId: string | null): Promise<Environment>;
  /** Tear down (logout, tenant deletion, deployment shutdown). */
  dispose(principal: Principal): Promise<void>;
}
```

Behind those two methods sit: tenant→sandbox lookup, sandbox provisioning, adapter
construction via the runtime factory (§4.3), per-principal connection caching and
idle eviction, tenant-scoped record store wiring, and workspace-root resolution.
Callers — the HTTP route handlers — see none of it.

`CachingEnvironmentProvider` (OSS, generic) supplies the lifecycle; the concrete
sandbox provider is injected. Adapters:

| Adapter | Mode | Repo | Behind it |
| --- | --- | --- | --- |
| `LocalEnvironmentProvider` | single-user / examples | OSS | one adapter built from `process.env`; one workspace root |
| `FleetEnvironmentProvider` | hosted, openclaw | **private** | one `OpenClawRuntimeAdapter` per tenant cell, cached |
| `DshEnvironmentProvider` | hosted/local, dsh | OSS provider, private wiring | one harness child per principal, cwd = their workspace |

**Alternative rejected:** make `RuntimeAdapter` tenant-aware (pass `Principal`
into `init`/`run`). That pushes provisioning, pooling, and identity into every
adapter, contradicting "per-adapter code is only event→delta mapping". Compose
adapters; don't widen them.

### 4.3 `RuntimeFactory` — how a runtime plugs in

The seam above is runtime-agnostic, but two things were still gateway-shaped: the
service constructed the adapter (so it had to know `{url, token}`), and
`transport-service` statically imported both runtime packages. Both are replaced
by a registry.

```ts
// packages/transport/src/runtime.ts  (new)
export interface RuntimeBinding {
  readonly runtime: string;                              // "openclaw" | "dsh" | …
  /** Connection material. The shape is PRIVATE to the runtime's adapter. */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface RuntimeCapabilities {
  commandCatalog: boolean;
  remoteSettleWatch: boolean;
  tokenStreaming: boolean;
  approvals: boolean;
  hostedSandbox: boolean;
  perSessionCwd: boolean;
}

export interface RuntimeFactory {
  readonly runtime: string;
  readonly capabilities: RuntimeCapabilities;
  /** Construct (but do not `init()`) an adapter for this binding. Sync. */
  create(binding: RuntimeBinding): RuntimeAdapter;
}

/** The ONE export a runtime package publishes for the composition root. */
export interface RuntimePlugin {
  readonly runtime: string;
  readonly factory: RuntimeFactory;
  /** Build this runtime's single-user binding from the deployment env slice. */
  localBinding(env: Readonly<Record<string, string | undefined>>): RuntimeBinding;
}
```

- Each runtime package owns its factory and its binding type
  (`transport-openclaw` → `GatewayBinding { url, token }`; `transport-dsh` →
  `DshBinding { home, profile, workspace, apiKeyRef }`). The shared seam never
  names `url`, `token`, or any launch surface.
- The service registers factories from configuration, not static imports — the
  same loading rule as the enterprise module (§9.2). Selecting a runtime becomes
  an explicit dimension instead of `adapters[0]` (§15.7).
- `init()` loses `gateway`: the adapter receives `RuntimeInitOptions` carrying the
  opaque `binding` and the workspace (§7). This closes the documented dsh leak,
  where process runtimes read `DSH_*` out of `config` because the seam assumed a
  url/token pair.
- **Deletion test:** adding a third runtime means adding a package and registering
  a factory — no edit to `transport`, `transport-service`, `workspace`, or
  `apps/web`. Enforced by a CI gate (§9.2).

### 4.4 `RuntimeCapabilities` — what consumers may assume

Runtimes differ in ways consumers must branch on, and those differences were
implicit in optional methods or hardcoded prose. Declare them.

```ts
export interface RuntimeCapabilities {
  commandCatalog: boolean;      // listCommands()
  remoteSettleWatch: boolean;   // subscribe()
  tokenStreaming: boolean;      // openclaw true; dsh is step-granular
  approvals: boolean;           // openclaw true; dsh false
  hostedSandbox: boolean;       // can be provisioned server-side
  perSessionCwd: boolean;       // dsh true; openclaw false (§14.3)
}
```

- Server-side branching keeps using the adapter's optional methods
  (`listCommands?`, `subscribe?`) — that mechanism stays. `capabilities()` exists
  for the traits a **consumer must know up front**: the service (expose
  `/approve`? provision a hosted sandbox?), the UI (render a token-streaming caret
  for a step-granular runtime?), and the workspace policy (per-session cwd).
- `RuntimeAdapter.approve` becomes **optional** (`approve?`) rather than a required
  method every non-approving runtime must no-op, with
  `capabilities.approvals === (typeof adapter.approve === "function")`.
- Keep the set small. A capability field earns its place only when a consumer
  would otherwise hardcode the runtime's name.

## 5. Workspace — one safe file module

`Workspace` is the only way anything reads a session's files. It is deep: a
handful of methods hiding path containment, symlink policy, size caps, and the
browser-path ↔ agent-path mapping.

```ts
// packages/transport/src/workspace.ts  (seam types; implementations in @science-studio/workspace)
export interface Entry {
  /** Workspace-relative, POSIX-style (never absolute, never `..`). */
  path: string;
  name: string;
  kind: "file" | "dir";
  size?: number;
  mime?: string;
}

export interface DirListing {
  path: string;
  entries: Entry[];
}

export interface FileStat extends Entry {
  modifiedAt?: string;
}

export interface FileContent {
  /** Streamed; callers never hold a whole large file in memory. */
  body: ReadableStream<Uint8Array>;
  size: number;
  mime: string;
}

export interface Workspace {
  list(relPath: string, opts?: { depth?: number }): Promise<DirListing>;
  stat(relPath: string): Promise<FileStat>;
  open(relPath: string, opts?: { maxBytes?: number }): Promise<FileContent>;

  /** Browser/workspace path → the path the AGENT sees (adapter-specific root). */
  toAgentPath(relPath: string): string;
  /** Agent-emitted path → workspace-relative path, or null if outside. */
  toWorkspacePath(agentPath: string): string | null;
}
```

### Interface invariants (part of the interface, not the implementation)

- `relPath` is always workspace-relative and POSIX. Absolute paths, `..`
  segments, NUL bytes, and platform separators are rejected before touching the
  filesystem.
- Resolution `realpath`s **both** the root and the target; the target must stay
  under the root. Symlinks that escape are rejected (v1 rejects symlinks
  entirely — simpler to reason about, revisit deliberately).
- `open` enforces a byte cap; larger files are a streaming download, not an
  inline read.
- v1 is **read-only**. Upload/write is a later method (`write`), added together
  with the upload path (§8) and the configurable limits below.

### Limits (configurable)

```ts
export interface WorkspaceLimits {
  /** Max bytes a single upload may carry. Default 100 * 1024 * 1024 (100 MB). */
  maxUploadBytes?: number;
  /** Total bytes a principal/tenant may store. Default 2 * 1024**3 (2 GB). */
  quotaBytes?: number;
}
```

`maxUploadBytes` is enforced in the OSS upload path. `quotaBytes` needs per-tenant
accounting, so it is enforced through an optional seam the enterprise module
supplies:

```ts
export interface QuotaPolicy {
  /** Throws when `additionalBytes` would exceed the principal's quota. */
  check(principal: Principal, additionalBytes: number): Promise<void>;
}
```

OSS default: no-op locally, or a simple usage scan against `quotaBytes`.
Enforcement is two-tier — a hard host filesystem project quota plus this soft
ledger — see §14.2.

### The path-mapping pair is why this module is deep

The browser sees `analysis/plots/volcano.png`; the openclaw cell's agent sees
`/home/node/.openclaw/workspace/analysis/plots/volcano.png`. Rather than make
every caller carry that, `toAgentPath`/`toWorkspacePath` own it. Session
partitioning (shared workspace vs `sessions/<key>/` subdir) is likewise a
provider policy, invisible above the seam.

### Implementations

- `FsWorkspace(root, { agentRoot })` (OSS) — local filesystem. Used in
  single-user mode, by the examples, and for a fleet cell's host bind-mount.
- `GatewayWorkspace` — unavailable for openclaw (its gateway exposes no file API,
  §3), so a cell's files are read from the host bind-mount. The interface still
  admits it: a future runtime that *does* expose a file API implements `Workspace`
  without touching callers — the seam paying off (§13).

## 6. Sandbox — tenant → runtime

`EnvironmentProvider` needs one thing above it: *given a tenant, where is their
runtime and their files?* The interface is runtime-agnostic; connection material
is not on it.

```ts
// seam type in @science-studio/transport; Local/Dsh providers in @science-studio/sandbox
export interface Sandbox {
  tenant: string;
  /** Which runtime product this sandbox runs — a runtime-factory id (§4.3). */
  runtime: string;
  state: "ready" | "provisioning" | "stopped" | "error";
  /** Host-side root. Runtime-agnostic: a fleet bind-mount, a dsh cwd, a local dir. */
  workspaceRoot: string;
  /** Path as the RUNTIME's agent sees the workspace root. */
  agentRoot: string;
}

export interface SandboxProvider {
  ensure(tenant: string): Promise<Sandbox>;
  status(tenant: string): Promise<Sandbox | null>;
  remove(tenant: string): Promise<void>;
  /**
   * Opaque connection material for this sandbox, produced for the runtime
   * factory. The shape is PRIVATE to the provider and its adapter — `endpoint`,
   * `tokenRef`, a child handle, or an API-key reference never enter the shared
   * type.
   */
  binding(sandbox: Sandbox, env: NodeJS.ProcessEnv): Promise<RuntimeBinding>;
}
```

**Isolation primitives, not "the fleet model".** A hosted sandbox is one of: a
containerized gateway (fleet, plain Docker, a k8s pod), a constrained child
process (dsh under a per-user uid or nsjail), or — weakest — a shared process with
a namespaced directory. `SandboxProvider` expresses all three; fleet is one
implementation. State the trust difference honestly (§10).

- `LocalSandboxProvider` (OSS) — one sandbox synthesized from env; no
  provisioning.
- `FleetSandboxProvider` (**private**) — one cell per tenant.
  - `ensure` runs `openclaw fleet create <tenant> --json` on first use,
    capturing the **once-printed Gateway token** into the secret store;
    subsequent calls read the registry. `binding` returns
    `{ runtime: "openclaw", config: { url, tokenRef } }`.
  - `remove` runs `openclaw fleet rm <tenant> --purge-data --force` after
    cascading Science Studio-side deletion.
  - `status` maps `fleet status` onto `Sandbox["state"]`.
  - Pin the image by digest (`--image …@sha256:…`) and rely on fleet's
    health-gated create/upgrade + automatic rollback.
- `DshSandboxProvider` (OSS) — a per-principal harness child with its own home
  and cwd (see `docs/adr/0004` for the create-only session constraint); `binding`
  returns `{ runtime: "dsh", config: { home, profile, apiKeyRef } }`.

**The token problem is real and must be designed, not hand-waved.** Fleet's
registry deliberately does *not* store the token, so Science Studio needs its
own `SandboxRegistry` (tenant → port, `tokenRef`, workspaceRoot, state,
**private**). Either generate the token and pass `--gateway-token`, or capture
the create output once. Either way: **a token is written exactly once and never
re-read from fleet output**, and it stays inside the provider's registry.

## 7. Attachments — references, not copies

`@`-mentioning a file must reach the agent. Because the agent's cwd *is* the
workspace, this is a path reference; no bytes move. A directory mention is the
same thing: a reference (`@analysis/`), never an expansion (§3).

Extend the wire (additive, so existing clients/adapters keep working):

```ts
// packages/transport/src/types.ts
export interface AttachmentRef {
  kind: "workspace" | "upload";
  /** Workspace-relative path for `kind: "workspace"`. */
  path?: string;
  name: string;
  mime?: string;
  size?: number;
  /** Base64 payload for `kind: "upload"` (phase 2). */
  data?: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: Id; name: string; args: string; result?: string; isError?: boolean }
  | { type: "artifact"; artifactId: Id; name: string; kind: string }
  // new:
  | { type: "file"; path: string; name: string; mime?: string; size?: number; source: "workspace" | "upload" };

export type TransportCommand =
  | {
      type: "add-message";
      message: { id: Id; role: "user" | "assistant"; content: string; attachments?: AttachmentRef[] };
    }
  | { type: "add-tool-result"; toolCallId: Id; result: string };
```

`normalizeCommands()` today reads text out of `message.content ?? msg.parts` and
silently drops everything else. It must instead lift non-text parts into
`attachments`.

**Where the reference becomes a runtime message.** The adapter owns it, because
only the adapter knows its runtime's syntax. The runtime factory (§4.3) passes
the binding and the workspace to the adapter at construction:

```ts
export interface RuntimeInitOptions {
  recordStore: RecordStoreLike;
  /** Opaque, provider-supplied connection material (§4.3, §6). */
  binding: RuntimeBinding;
  /** The session's workspace, for attachment refs and file-part mapping. */
  workspace?: Workspace;
  /** Deployment env slice — generic; never a runtime's launch surface. */
  env?: Record<string, string | undefined>;
}
```

The adapter validates `binding.config` against its own type (`GatewayBinding`,
`DshBinding`); a mismatch is an init error, not a shared-type concern. The old
`RuntimeConfig`/`{ url, token }` shape disappears from the seam entirely.

Then `run()` needs no signature change: the adapter resolves each
`AttachmentRef.path` through `workspace.toAgentPath()` and renders it into the
runtime's message (openclaw: annotate the sent text / attach a path block; dsh:
include in the prompt). **An `upload` is first written into the workspace by the
file service, then becomes an ordinary `workspace` reference** — one code path
for both, which is the depth this seam buys.

The `@` picker in the composer reuses the *proven* slash-menu mechanism
(`ComposerPrimitive.Unstable_TriggerPopover` + a hook that builds the adapter;
see `useRuntimeSlashMenu`). A new `useWorkspaceMentions()` supplies the same
shape for `@`: fetch entries from the workspace API, return items whose
`execute` materializes a mention (a text token for the user + an
`AttachmentRef` for the wire). The app only skins the popover.

## 8. File references in replies

The agent returns file paths in two shapes: markdown links inside text, and
structured tool/event payloads. Both resolve through **one grammar**.

```ts
// packages/transport-client/src/file-reference.ts (new)
export interface FileRef {
  workspacePath: string;
  name: string;
}

/** Recognize a workspace file reference in agent output; null otherwise. */
export function resolveFileReference(
  href: string,
  ctx: { toWorkspacePath: (agentPath: string) => string | null },
): FileRef | null;
```

Recognized: workspace-relative paths, `file://` URIs under the agent root, and a
`science://workspace/<path>` scheme the adapter can inject. Rejected:
`http(s)`, `data:`, `mailto:`, fragment-only. Resolution happens **server-side
too** before an adapter advertises a structured `file` part, so a forged path
can never address another tenant's files.

Frontend wiring:

- The markdown component map (`MarkdownComponents`, used by
  `transport-client/src/markdown.tsx`) overrides `a`: a matching reference
  renders as an in-app file chip that opens the viewer; everything else stays a
  normal external link with `rel="noopener noreferrer"`.
- `partToContent()` (`transport-client/src/converter.ts`) currently renders
  `artifact` as the literal string `[artifact: name]`; it must map `artifact`
  and the new `file` part to assistant-ui's `file` part, so the existing
  `File` component (`apps/web/.../elements/file.tsx`) renders name/icon/size and
  a download/open action for free.

**v1 preview scope.** Binary preview is out of scope (§3): the viewer renders
text inline and offers download for everything else. Images/PDF/notebook/table
preview is a later, deliberate addition.

## 9. Backend surface, Fastify, and auth

Every route (transport, watch, commands, **workspace**) runs the same preamble:

```
RequestContext → PrincipalResolver.resolve → (401 | Principal)
             → EnvironmentProvider.acquire(principal, sessionKey)
```

The runtime adapter is cached **per principal** (one gateway/harness connection
serves all of that principal's sessions); the workspace is derived **per
session** from the resolved `sessionKey`. Routes with no session of their own
(the `GET /commands` catalog) pass the adapter's default session key, exactly as
the mount probe does today.

New workspace routes (JSON / streamed bytes), served from the **same service**
as transport:

| Route | Returns |
| --- | --- |
| `GET /api/workspace/entries?path=&session=` | `DirListing` |
| `GET /api/workspace/stat?path=&session=` | `FileStat` |
| `GET /api/workspace/file?path=&session=&download=1` | bytes + `Content-Type`, `Content-Disposition` |
| `POST /api/workspace/upload` (phase 2) | `AttachmentRef` |

Serving files from the transport service rather than a separate process is
deliberate: the file service needs the *same* principal and the *same* sandbox
resolution as transport. A separate process would force a second copy of the
registry and a service-to-service trust hop. The module is separate
(`@science-studio/workspace`); the deployment stays one process.

### 9.1 Fastify

The service moves from a hand-rolled `node:http` handler to **Fastify**. This is
an implementation change; the assistant-transport wire is untouched.

```ts
// services/transport-service/src/server.ts  (new)
export async function createServer(backend: Backend) {
  const app = Fastify({ logger: true });
  await app.register(cors, backend.cors);
  app.decorateRequest("principal", null);
  app.addHook("preHandler", principalHook(backend.principal)); // 401 on null
  await app.register(transportRoutes, { environments: backend.environments });
  await app.register(workspaceRoutes, { environments: backend.environments });
  return app;
}
```

- **SSE.** The transport route takes over the Node response
  (`reply.hijack()` + `reply.raw.writeHead` / `write` / `end`) so frames stream
  exactly as today and still terminate with `data: [DONE]`. Fastify's buffering
  must not sit in the path.
- **Auth.** A `preHandler` hook resolves the `Principal` and decorates the
  request; the resolver is injected, so OSS registers the local one and the
  enterprise module registers the bearer one. The same hook protects workspace
  routes.
- **CORS.** `@fastify/cors` with the injected config: loopback-permissive in
  single-user mode, origin-locked to the web app with credentials in hosted
  mode (the pre-seam `access-control-allow-origin: *` must not survive to hosted).
- **Testability.** `app.inject()` drives every route in-process without binding
  a port — the existing service tests get simpler, not harder.

The web app's Next route handler (`apps/web/app/api/transport/route.ts`) still
pipes through to the service (never a `next.config` rewrite — it buffers), and
gains a sibling `app/api/workspace/[...path]/route.ts` that forwards the
`Authorization` header in hosted deployments.

### 9.2 Open-core split: OSS core + private enterprise module

Requirement (§1): multi-user is an enterprise feature in a **separate private
repo**, and its absence must not affect single-user. The seam-first design makes
that literal — the enterprise module is an *out-of-tree adapter set* for
interfaces the OSS core declares.

| OSS (public repo) | Private (enterprise repo) |
| --- | --- |
| `packages/transport` — `Principal`/`PrincipalResolver`, `Environment`/`EnvironmentProvider`, `RuntimeAdapter`, `RuntimeFactory`/`RuntimeBinding`/`RuntimeCapabilities` | `BearerPrincipalResolver` |
| `packages/workspace` — `Workspace`, `FsWorkspace`, limits, `QuotaPolicy` | quota accounting implementation |
| `packages/sandbox` — `Sandbox`, `SandboxProvider`, `LocalSandboxProvider`, `DshSandboxProvider` | `FleetSandboxProvider` + `SandboxRegistry` + `openclaw fleet` client |
| `packages/record` — domain types + `RecordStore` | `SchemaRecordStore` (per-tenant Postgres schema) + migrations |
| `services/transport-service` — Fastify plugins, `CachingEnvironmentProvider`, local composition | enterprise Fastify plugin wiring bearer + fleet + schema store |
| `apps/web` — Thread, workspace browser/viewer, `@` picker | login gate + quota meters, mounted through an optional UI slot |

**Loading rule.** OSS never statically imports enterprise code. The composition
root resolves an optional module specifier from the environment and dynamically
imports it:

```ts
// services/transport-service/src/composition.ts  (new)
export interface Backend {
  principal: PrincipalResolver;
  environments: EnvironmentProvider;
  cors: CorsConfig;
  quota?: QuotaPolicy;
}

/** The out-of-tree contract a private enterprise module implements. */
export interface EnterpriseModule {
  createBackend(env: NodeJS.ProcessEnv): Promise<Backend>;
}

/** Single-user: the complete product, zero enterprise code loaded. */
function localBackend(env: NodeJS.ProcessEnv): Backend { /* Local* + FsWorkspace */ }

export async function createBackend(env = process.env): Promise<Backend> {
  const specifier = env.SS_ENTERPRISE_MODULE;
  if (!specifier) return localBackend(env);
  const mod = (await import(specifier)) as EnterpriseModule;
  return mod.createBackend(env);
}
```

The same pattern, one level up: the OSS web app resolves an optional
`NEXT_PUBLIC_ENTERPRISE_UI` module for the login gate and quota meters; absent,
`apps/web` renders exactly today's app.

**Invariants that keep single-user unaffected** (worth a CI gate):

1. No OSS package depends on any enterprise artifact.
2. The OSS test suite passes with `SS_ENTERPRISE_MODULE` unset.
3. Every enterprise implementation satisfies an OSS-declared interface, so the
   core compiles and runs without it.
4. The published OSS seam types are treated as a public contract — deliberately
   small and versioned, because a private repo compiles against them.
5. Adding a runtime package registers a factory and touches no core package
   (§4.3). The same gate covers it.

This is the payoff of the seam discipline: the private module adds a
`PrincipalResolver`, a `SandboxProvider`, a `RecordStore`, a `QuotaPolicy`, and
at most a `RuntimeFactory` — it never edits the core.

| | Local (single-user, OSS) | Hosted (multi-user, private module) |
| --- | --- | --- |
| Login | none (`LocalPrincipalResolver`) | bearer token (`BearerPrincipalResolver`) |
| Runtime | user's machine (`process.env`) | server, per-tenant sandbox (cell / child) |
| Sandbox | `LocalSandboxProvider` | `FleetSandboxProvider` |
| Files | user's local dir | cell's host bind-mount |
| Records | one in-memory / local store | per-tenant Postgres schema |
| Quota | local limit only | per-tenant accounting |

The examples (`examples/transport-*-example`) are always single-user; they keep
their existing dev wiring.

## 10. Trust model and security invariants

- **Tenant boundary = the isolation primitive, stated honestly.** For the fleet
  backend that is a cell: it separates tenants from *each other*, but not from the
  fleet operator, the container-runtime admin, or a compromised host. A per-user
  child process (dsh) is weaker than a per-user container. Do not market either as
  stronger than it is.
- **Cell state backups and tokens are credentials.** Fleet backups include OAuth
  material; tokens are printed once. Store both in the secret store, mode `0600`
  or better, never in the repo or logs.
- **Workspace containment** (§5 invariants) is the file-service security core:
  no absolute paths, no `..`, realpath-under-root, cap sizes.
- **Attachments are validated server-side** against the caller's own workspace
  before reaching an adapter; a client cannot name another session's file.
- **Agent-emitted links are untrusted input.** Only workspace-resolved refs open
  in-app; the viewer fetches through the authenticated API, so a forged path
  fails containment rather than leaking a file.
- **Bearer tokens are validated server-side**; the OSS core never sees a
  credential, and the local resolver never issues one.
- **Loopback binding** in local mode; origin-locked CORS + credentials in hosted
  mode.

## 11. Module map

```
OSS (public)
packages/transport                    + principal.ts, environment.ts, runtime.ts (seams only)
                                      + RuntimeBinding, RuntimeFactory, RuntimeCapabilities
                                      + AttachmentRef, file part, RuntimeInitOptions.{binding,workspace}
packages/transport-openclaw           runtime-owned: GatewayBinding + factory
packages/transport-dsh                runtime-owned: DshBinding + factory
packages/workspace            (new)     Workspace interface, FsWorkspace, limits, QuotaPolicy, file-reference grammar (server side)
packages/sandbox              (new)     Sandbox/SandboxProvider (tenant+state+roots+binding), Local + Dsh providers
packages/transport-client             + useWorkspaceMentions, workspace client, file-reference resolver,
                                        useWorkspace (fetch entries), file part conversion
services/transport-service            + Fastify server + plugins, composition.ts, workspace routes, principal hook,
                                        runtime-factory registry (config-driven, no static runtime imports)
apps/web                              + workspace browser/viewer, @-mention popover skin, file-link component
                                        + optional enterprise UI slot (absent by default)

Private (enterprise repo)
@acme/ss-enterprise                     BearerPrincipalResolver, FleetSandboxProvider + SandboxRegistry,
                                        SchemaRecordStore (+ migrations), QuotaPolicy, enterprise Fastify plugin,
                                        login gate + quota meters
```

Dependency direction: `transport-service` → {`transport`, `workspace`, `sandbox`}.
**All seam *interfaces* live in `transport`; implementation packages depend on
it, never the reverse** (no cycles). Runtimes are **not** core dependencies: each
exports a `runtimePlugins` array and is loaded by configuration, so
`transport-service` carries no static import of a runtime package. `transport-client`
stays React-boundary-only and runtime-agnostic. Nothing in OSS points at the
enterprise module.

## 12. Phased migration

Phase 0 is **implemented**; [`implementation-plan.md`](./implementation-plan.md)
is the live status/checklist. The phases below remain the reference shape.

**Phase 0 — Fastify + seams, no behavior change.**
1. Port `transport-service` to Fastify, preserving the wire contract and tests
   (use `app.inject()`), with the local composition as the only `Backend`.
2. Add `principal.ts` / `environment.ts` / `runtime.ts` to `transport`; implement
   `LocalPrincipalResolver` and a `LocalEnvironmentProvider` wrapping the pre-seam
   single adapter + `NullWorkspace`; route all handlers through the preamble.
3. Introduce `RuntimeBinding`/`RuntimeFactory`/`RuntimeCapabilities`; move each
   runtime's launch surface into its own package (`GatewayBinding`, `DshBinding`)
   and register factories from configuration — remove `RuntimeInitOptions.gateway`
   and the static runtime imports (§4.3–4.4).
4. Publish `@science-studio/contract-tests` skeletons for `PrincipalResolver`,
   `Workspace`, `SandboxProvider`, and runtime factories (§15.1).

**Phase 1 — workspace (single-user).**
5. Create `@science-studio/workspace` with `FsWorkspace`, `WorkspaceLimits` and
   tests for the containment/symlink/size invariants.
6. Add `/api/workspace/*` + the Next route; enforce `maxUploadBytes`; build the
   browser panel and viewer (text inline, download for everything else).
7. Wire `resolveFileReference` into the markdown map and the converter.

**Phase 2 — attachments and run control.**
8. Extend `TransportCommand`/`MessagePart`; fix `normalizeCommands`.
9. Pass `binding`/`workspace` to the adapter; teach each adapter to render refs.
10. Build the `@` picker (files and directories as references).
11. Add the per-session run lock and the `abort`/`approve` routes (§15.3–15.4),
    gating `approve` on `capabilities.approvals`.

**Phase 3 — enterprise module (private repo).**
12. Create `@acme/ss-enterprise`: `BearerPrincipalResolver` (OIDC/JWKS) +
    `PrincipalDirectory`, `SecretStore`, `SandboxRegistry` + `FleetSandboxProvider`,
    `SchemaRecordStore`, enterprise Fastify plugin; wire it via
    `SS_ENTERPRISE_MODULE`.
13. Control schema + migration runner (§14.5); two-tier quota enforcement
    (§14.2).
14. Origin-locked CORS, login gate + quota meters in the web app's enterprise UI
    slot (§14.4).
15. Add the CI gate for the OSS invariants in §9.2 (no enterprise dependency, no
    core edit for a new runtime, green suite with the module unset) and run the
    OSS conformance suites in the private repo.

## 13. Alternatives considered

- **A separate `file-service` process.** Rejected: duplicates principal + sandbox
  resolution and adds a trust hop. Kept as a package, deployed in-process.
- **`GatewayWorkspace` (proxy files through the runtime).** **Rejected**: the
  openclaw gateway exposes no file API (§3), so the host bind-mount is the only
  route. The coupling to fleet's layout stays confined to the private
  `FleetSandboxProvider`.
- **Tenant-aware `RuntimeAdapter`.** Rejected in §4.2.
- **Enterprise code in-tree, gated by a license flag.** Rejected: it would put
  enterprise code in the open-source repo and couple OSS releases to it. The
  out-of-tree module keeps the boundary physical.
- **Per-session workspace subdirectories under one cell.** Deferred policy: one
  cell exposes one `OPENCLAW_WORKSPACE_DIR`; whether sessions share it or get
  `sessions/<key>/` subdirs is a `WorkspaceProvider` decision, invisible above
  the seam. Default v1: shared root per sandbox; revisit with real usage.
- **Upload files as message parts.** Rejected as the primary model: it copies
  bytes the agent can already open, and breaks the runtime-agnostic message
  shape. Uploads become workspace writes, then ordinary references.
- **A runtime-typed `Sandbox` / `RuntimeInitOptions.gateway`.** Rejected: a closed
  `kind` union and a `{url, token}` field bake one runtime's transport into the
  shared seam — which is exactly how dsh ended up reading `DSH_*` out of `config`.
  Opaque `RuntimeBinding` + a factory keep the seam runtime-neutral (§4.3, §6).

## 14. Open-question resolutions

### 14.1 IdP and token signing

**Analysis.** Hosted enterprise customers expect SSO; running our own identity
store (passwords, reset, MFA) is a large, security-critical surface we should not
own. The service must also validate statelessly under load, without sharing a
signing secret with the web app.

**Decision.**

- **OIDC authorization-code + PKCE** at the web app (Next BFF). The IdP is the
  only signer.
- The service validates the **bearer access token** statelessly against the
  IdP's **JWKS** (issuer + audience pinned), caching keys by `kid` and refreshing
  on an unknown `kid` (rotation-safe). Nothing is stored server-side; the web app
  keeps only the refresh token in an httpOnly cookie.
- Claims map to `Principal` through a **`PrincipalDirectory`** in the control
  schema (`sub` → tenant, roles, status) rather than by trusting a tenant claim
  from the token. This makes onboarding, tenant moves, and de-provisioning local
  and auditable, and supports IdPs with thin claim sets.
- Deployments without an IdP use a **local ES256 signer** in the enterprise
  module along the same resolver path. Never HS256: signer and verifier are
  separate processes and keys must rotate independently.

**Consequences.** Stateless scale-out and SSO through any OIDC broker; a small
`PrincipalDirectory` joins the enterprise DB. Short access-token TTL (~15 min)
bounds revocation latency; hard revocation = disable in the directory plus a
briefly cached per-request directory check.

### 14.2 Quota accounting

**Analysis.** Two facts break a naive "count uploads" model: the agent writes
files straight into the workspace with no interception point, and 2 GB must be a
real ceiling, not an advisory.

**Decision — two tiers.**

- **Hard tier: host filesystem project quota** on the tenant's workspace subtree
  (XFS `pquota`). Fleet's own guidance is explicit — "use host filesystem project
  quotas when those directories also need a hard limit" — and this caps
  agent-written bytes too. At the wall, writes fail inside the cell as an
  ordinary disk-full error.
  - Fleet's `--disk` caps only the container writable layer; the state mount is
    host storage, so the project quota must be applied there.
  - The state dir also holds SQLite state/auth, so set the project on the
    workspace subtree where the filesystem supports subdirectory projects, else
    budget headroom.
- **Soft tier: `QuotaPolicy` + ledger** (`workspace_usage(tenant, bytes,
  accounted_at)` in the control schema). Uploads apply their known delta and are
  rejected early with a clear 4xx and a UI message; a **reconciler** scans the
  workspace (batched, TTL'd, on demand when the ledger is stale) to absorb
  agent-written drift and deletions. Checks read the ledger (O(1)); the scan
  never sits on the request path.
- **Local mode**: soft tier only, with `quotaBytes` defaulting to the same 2 GB
  or unset.

**Consequences.** The ledger can lag reality between reconciliations — acceptable
because the hard tier is the actual ceiling. Expose usage for the UI meter.
Deleting a tenant = drop schema + remove the project + purge the state dir.

### 14.3 Session → workspace partitioning

**Analysis.** A cell exposes exactly one `OPENCLAW_WORKSPACE_DIR` and the
runtime's cwd is fixed per cell, so sessions under one user's cell cannot get
their own cwd from openclaw. A fully shared root lets two studies collide on
common filenames and leaks intermediates across sessions.

**Decision.**

- The **Session is the partition unit**. Its workspace is
  `<sandboxRoot>/sessions/<sessionKey>/`, and `toAgentPath` maps browser `a.csv`
  → agent `sessions/<sessionKey>/a.csv`. References are always unambiguous and
  the file browser roots at a stable session directory.
- The partition key is the **canonical `sessionKey`** (what `resolveSessionKey`
  returns), not the browser's ephemeral `__LOCALID_*`, so reloads and the
  standing watch converge on the same directory.
- The **record layer owns Session identity**, so the partition name and the
  `Session` row share one id and provenance stays intact.
- The agent *can* still write outside its subdir (it sees the whole root), so
  isolation is a reference convention, not a hard jail. **dsh differs**: the
  adapter spawns the child and sets cwd, so it can enforce a true per-session
  root natively (declared as `capabilities.perSessionCwd`, §4.4). The policy lives
  in the provider, invisible above the seam.
- **Rejected: a cell per session.** Provisioning cost and fleet churn are far too
  high.

**Consequences.** One cell serves many sessions; the browser shows the session
subtree. Migration: root-level files are exposed read-only as a "sandbox home"
until re-homed.

### 14.4 Enterprise web UI: package vs fork

**Analysis.** A fork of `apps/web` turns every OSS UI change into a merge — the UI
twin of the in-tree enterprise code already rejected. A fully separate enterprise
app requires extracting the Thread/skin into a package, which is more separation
than we need today.

**Decision.** Ship the enterprise UI as a **private npm package consumed by an
OSS-declared slot**, loaded dynamically from `NEXT_PUBLIC_ENTERPRISE_UI`:

```ts
export interface EnterpriseUIExtension {
  /** Wraps the app: auth context + login gate; renders children when authenticated. */
  Shell?: ComponentType<{ children: ReactNode; api: string }>;
  /** Thread-header chrome (quota meter, tenant switcher). */
  ThreadHeaderExtras?: ComponentType;
  /** Extra composer affordances. */
  ComposerExtras?: ComponentType;
}
```

The slot may only **wrap or extend**, never alter OSS behaviour; absent, the app
is byte-identical to the single-user product. Reject the fork for merge burden.
Escape hatch: if the slot outgrows a handful of components, extract the OSS shell
into `@science-studio/web-app` and let the enterprise app compose it.

### 14.5 Postgres schema migration at scale

**Analysis.** Per-tenant schemas delete cleanly (`DROP SCHEMA CASCADE`) and
isolate well, but migration becomes a fan-out over N schemas — slow and
lock-heavy if done naively, and partial failure leaves version skew.

**Decision.**

- A **control schema** (`ss_control`) owns `tenants(id, schema_name,
  schema_version, status)`, `principal_directory`, and `workspace_usage`.
- A **migration runner** applies ordered SQL to the control schema, then to tenant
  schemas in **batches**, recording `schema_version` per tenant; idempotent and
  resumable, so a crash mid-fan-out continues rather than restarts.
- Migrations must be **expand/contract** and tolerate **≤1 version skew**, so a
  partially migrated fleet keeps serving during a rollout.
- Connections bind the schema per transaction (`SET LOCAL search_path`),
  pgBouncer-transaction-pooling-safe; a per-schema pool cache avoids re-issuing
  it.
- **Scale ceiling**: catalog size and fan-out time grow with tenant count; watch
  them, and past a documented threshold move to **database-per-tenant** (same
  `RecordStore` interface) or a shared schema with RLS. RLS was rejected as the
  default only because schema-per-tenant was chosen; it remains the escape hatch.

**Consequences.** Tenant creation = create schema at the current version +
register a row. Deletion = `DROP SCHEMA CASCADE` + project removal + state purge.
Migration is a resumable operational job, not an app-startup step.

## 15. Further optimizations

1. **Conformance suite for the seams** (`@science-studio/contract-tests`, OSS). The
   open-core boundary is only as good as the private module's conformance.
   Publish reusable suites for `PrincipalResolver`, `SandboxProvider`,
   `Workspace`, `QuotaPolicy`, and `RuntimeFactory`; the enterprise and third-party
   runtime repos run them in CI. Highest-leverage single addition for the split.
2. **Real `SessionState` from the record layer.** `handleTransport` currently
   fabricates `{ sessionId, studyId: "study-1", agentId: "main" }`. Resolve the
   `Session` record from `sessionKey` and build `SessionState` from it, so
   `persistRun` attributes `Run.sessionId`/`agentId`/`taskId` correctly. Without
   this the record layer is decorative.
3. **Per-session run concurrency.** `Transcript.attachFlow` overwrites the current
   flow, so two concurrent runs in one session would interleave and corrupt the
   stream. Add a per-session run lock: reject or queue a second run while
   `hasActiveFlow()`.
4. **Run control surface.** The adapter already exposes `abort(reason?)` and
   `approve(id, decision)`; add `POST /api/transport/abort` and
   `POST /api/transport/approve` resolved through the same environment, and gate
   `/approve` on `capabilities.approvals` (§4.4). Today they are unreachable over
   HTTP.
5. **`SecretStore` interface** (OSS interface, impls out of tree). A provider's
   binding carries a `tokenRef`, not a token; define `get(ref): Promise<string>`
   so providers do not hardcode a secret format. Local impl: a mode-`0600` file or
   keychain.
6. **Eviction that respects live runs.** `CachingEnvironmentProvider` may dispose
   an environment only when no transcript `hasActiveFlow()`; otherwise an idle
   sweep would kill a streaming turn. Evict on TTL, not on request gap.
7. **Runtime selection as its own dimension.** *Resolved by §4.3*: the runtime
   product is chosen by which `RuntimeFactory` is registered/selected, independent
   of which tenant's environment is acquired — no longer implicit in
   `adapters[0]`.
8. **Rate limiting and per-tenant observability.** `@fastify/rate-limit` keyed by
   tenant, and tenant id + request id in every log line; a noisy tenant must be
   visible and bounded before it becomes a quota problem.
9. **Service health.** `GET /healthz` plus a per-tenant sandbox health view backed
   by `SandboxProvider.status` (and `fleet doctor` for the fleet backend), so the
   UI can show "your sandbox is down" instead of a hung thread.

## 16. Residual open questions

- Per-customer OIDC quirks: claim shapes, multiple IdPs, and directory sync.
- Filesystem project-quota availability per host (XFS/btrfs/zfs) and the fallback
  policy when it is absent.
- The tenant-count threshold for leaving schema-per-tenant (§14.5).
- Whether the enterprise UI should graduate from the slot to the extracted shell.
- Distribution and registration of out-of-tree runtime packages: the same
  module-spec mechanism as the enterprise module, or a dedicated runtime registry.

Proposed promotions once accepted: ADR for the principal/environment seam; ADR
for the open-core split (OSS seam contract + out-of-tree enterprise module); ADR
for per-tenant fleet cells + workspace file service; ADR for session-partitioned
workspaces and two-tier quotas; glossary additions (`Principal`, `Tenant`,
`Sandbox`, `Cell`, `Attachment`, `FileReference`) in `CONTEXT.md`.
