/**
 * Fastify server: the assistant-transport wire.
 *
 * Every route that needs a runtime or a workspace asks `ProjectScopes` for the
 * request's Project scope (Principal + Project + that Project's `Environment`,
 * one per Project — docs/adr/0008) instead of resolving it itself, so deployment
 * mode, tenancy and the Project claim's spelling never reach a route body. The
 * transport/watch routes stream by hijacking the Node response; Fastify's
 * buffering must never sit in that path.
 *
 * Project and Session identity are record-owned (docs/adr/0002, 0007): the
 * Project/Session routes write the record, and the transport route resolves its
 * claimed session key through the record — first-use recording a Session for a
 * key it does not know — rather than fabricating identity.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { createInMemoryRecordStore, sessionWorktreeId, type Session } from "@science-studio/record";
import type {
  AttachmentRef,
  FileContent,
  FileStat,
  Principal,
  SessionState,
  TransportCommand,
} from "@science-studio/transport";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  WorkspacePathError,
  attachmentsFromMentions,
  parseWorkspaceMentions,
} from "@science-studio/transport";
import { localWorkspace } from "./composition.js";
import type { Backend, CorsConfig } from "./composition.js";
import { registerCronRoutes } from "./cron/routes.js";
import { createCronScheduler } from "./cron/scheduler.js";
import { createCronStore } from "./cron/store.js";
import { createRecordDirectory, DEFAULT_RECORD_DEFAULTS, WorktreeNotFoundError } from "./directory.js";
import { registerHpcRoutes } from "./hpc/routes.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { removeMcpServersForProject } from "./mcp/store.js";
import { createHpcPoller } from "./hpc/poller.js";
import { createSshRunner } from "./hpc/ssh.js";
import { createGitRunner, GitUnavailableError } from "./worktree/git.js";
import { isSafeProjectId } from "./worktree/paths.js";
import { registerWorktreeRoutes } from "./worktree/routes.js";
import { canonicalSessionKey, createProjectScopes } from "./project-scope.js";
import {
  computeInteractionsForSelection,
  MolqlCompileError,
  UnsupportedStructureFormatError,
} from "./interactions.js";
import {
  loadSettings,
  mergeSettings,
  parseSettingsPatch,
  resolveSettingsPath,
  saveSettings,
  viewOf,
} from "./settings.js";
import { parseSkillInstall, parseSkillRemove, sendSkillError } from "./skills.js";
import { computeMeasurements, MeasurementError } from "./measurements.js";
import { STRUCTURE_MAX_BYTES } from "./structure.js";
import { encodeOp, parseClaimedState, WireOpsBuilder } from "./wire.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export async function createServer(backend: Backend): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: maxJsonBodyBytes(process.env) });

  await app.register(cors, {
    origin: backend.cors.origin,
    credentials: backend.cors.credentials ?? false,
  });

  // Uploads are a raw body (one file per request), NOT multipart: no parser
  // dependency, and the body streams straight into `Workspace.write`. JSON
  // routes keep their own parser.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  app.decorateRequest("principal", null);
  app.addHook("preHandler", async (request, reply) => {
    const principal = await backend.principal.resolve({
      headers: request.headers as Record<string, string | undefined>,
      url: request.url,
    });
    if (!principal) {
      await reply.code(401).send("unauthorized");
      return;
    }
    request.principal = principal;
  });

  // Central mappings every acquiring route inherits:
  //  - an unsafe Project claim is a 400 (never a 500 with a stack), because it
  //    is the caller's mistake, not a server fault — `project-scope` throws it
  //    before any path is joined (docs/adr/0025);
  //  - a worktree the record does not know is a 404;
  //  - a missing/unspawnable system `git` is a 503 — the deployment cannot do
  //    git at all, which the worktree surface promises as "unavailable".
  // Everything else keeps Fastify's own status (e.g. a 413 body-limit rejection).
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspacePathError) {
      return reply.code(400).send({ error: err.message });
    }
    if (err instanceof WorktreeNotFoundError) {
      return reply.code(404).send({ error: err.message });
    }
    if (err instanceof GitUnavailableError) {
      return reply.code(503).send({ error: err.message });
    }
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400) {
      reply.code(statusCode);
    }
    return reply.send(err);
  });

  // One in-flight run per session, and identity is record-owned: the store IS the
  // authority for Project/Session, and a runtime session key IS the Session id.
  const records = backend.records ?? createInMemoryRecordStore();
  const directory = createRecordDirectory({
    store: records,
    ...(backend.recordDefaults ? { defaults: backend.recordDefaults } : {}),
  });
  const defaultProjectId = backend.recordDefaults?.projectId ?? DEFAULT_RECORD_DEFAULTS.projectId;
  const settingsPath = backend.settingsPath ?? resolveSettingsPath(process.env);
  /** Which Project each request is serving — and its adapter + Project Workspace. */
  const scope = createProjectScopes({
    environments: backend.environments,
    directory,
    defaultProjectId,
  });
  const activeRuns = new Set<string>();
  const cronStore = createCronStore();
  /** The bootstrap row every unscoped request falls back to (docs/adr/0014). */
  const isDefaultProject = (id: string): boolean => id === defaultProjectId;
  const DEFAULT_PROJECT_IMMUTABLE =
    "the default project cannot be renamed, archived or deleted";
  /** The Session, only when it actually belongs to `projectId` (guards the routes). */
  const sessionInProject = async (projectId: string, sessionId: string): Promise<Session | null> => {
    const session = await records.getSession(sessionId);
    return session && session.projectId === projectId ? session : null;
  };

  // -- Deployment settings ---------------------------------------------------
  app.get("/api/settings", async () =>
    viewOf(await loadSettings(settingsPath), settingsPath, process.env),
  );

  app.put("/api/settings", async (request, reply) => {
    // Deployment settings are shared: in hosted mode only a manager (or the
    // credential-less local principal) may overwrite them, so a researcher's
    // browser cannot change every tenant's route. GET stays principal-only.
    const principal = request.principal!;
    if (!principal.local && !principal.roles.includes("manager")) {
      return reply
        .code(403)
        .send({ error: "changing settings requires a local or manager principal" });
    }
    const parsed = parseSettingsPatch(request.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const next = mergeSettings(await loadSettings(settingsPath), parsed.patch);
    await saveSettings(settingsPath, next);
    return viewOf(next, settingsPath, process.env);
  });

  // -- Deployment MCP servers (docs/adr/0026) --------------------------------
  // A dedicated per-row surface: the generic settings PUT replaces a whole
  // section, which would let one Project delete another Project's MCP rows.
  registerMcpRoutes(app, {
    settingsPath,
    records,
    available: backend.capabilities?.mcp ?? false,
    ...(backend.mcpProbe ? { probe: backend.mcpProbe } : {}),
    workspaceRoot: (projectId, worktreeId) =>
      localWorkspace(process.env, projectId, worktreeId).toAgentPath(""),
  });

  // -- Project / Session / Run record surface --------------------------------
  app.post("/api/projects", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown };
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return reply.code(400).send({ error: "name is required" });
    }
    return reply.code(201).send({ project: await directory.createProject(body.name.trim()) });
  });

  app.get("/api/projects", async (request) => {
    const includeArchived = (request.query as { includeArchived?: string }).includeArchived === "1";
    return {
      projects: await directory.listProjects({ includeArchived }),
      // The UI hides rename/archive/delete on the immutable bootstrap Project.
      defaultProjectId,
    };
  });

  app.post("/api/projects/:id/rename", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown };
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return reply.code(400).send({ error: "name is required" });
    }
    if (isDefaultProject(id)) {
      return reply.code(403).send({ error: DEFAULT_PROJECT_IMMUTABLE });
    }
    try {
      return { project: await directory.renameProject(id, body.name.trim()) };
    } catch {
      return reply.code(404).send({ error: `project not found: ${id}` });
    }
  });

  app.post("/api/projects/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (isDefaultProject(id)) {
      return reply.code(403).send({ error: DEFAULT_PROJECT_IMMUTABLE });
    }
    try {
      return { project: await directory.archiveProject(id) };
    } catch {
      return reply.code(404).send({ error: `project not found: ${id}` });
    }
  });

  app.post("/api/projects/:id/unarchive", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (isDefaultProject(id)) {
      return reply.code(403).send({ error: DEFAULT_PROJECT_IMMUTABLE });
    }
    try {
      return { project: await directory.unarchiveProject(id) };
    } catch {
      return reply.code(404).send({ error: `project not found: ${id}` });
    }
  });

  // Irreversible in the UI: the record goes, the workspace is recycled (moved to
  // a sibling `.recycle/` bin, recoverable only by hand — docs/adr/0014). Recycle
  // BEFORE dropping the record so a failed move leaves the Project intact.
  app.post("/api/projects/:id/delete", async (request, reply) => {
    const { id } = request.params as { id: string };
    // An unsafe path id is the caller's 400 — checked before the record read so
    // it can never be mislabelled a missing project or a recycle failure.
    if (!isSafeProjectId(id)) {
      return reply.code(400).send({ error: `unsafe project id: ${id}` });
    }
    if (isDefaultProject(id)) {
      return reply.code(403).send({ error: DEFAULT_PROJECT_IMMUTABLE });
    }
    if (!(await records.getProject(id))) {
      return reply.code(404).send({ error: `project not found: ${id}` });
    }
    const principal = request.principal!;
    try {
      const { environment } = await scope.acquireProject(principal, id);
      await environment.workspace.recycle?.();
    } catch (err) {
      // `acquireProject` validates the id too; a validation failure is not a
      // recycle failure, so let the central handler answer 400 instead of 500.
      if (err instanceof WorkspacePathError) throw err;
      console.error(`[transport-service] recycling project "${id}" failed`, err);
      return reply.code(500).send({ error: "failed to recycle the project workspace" });
    }
    await directory.deleteProject(id);
    try {
      await removeMcpServersForProject(settingsPath, id);
    } catch (err) {
      // Best-effort: deleting the Project must not fail on its MCP config.
      console.error(`[transport-service] removing MCP servers for project "${id}" failed`, err);
    }
    try {
      await backend.environments.release?.(principal, id);
    } catch (err) {
      console.error(`[transport-service] releasing project "${id}" failed`, err);
    }
    return { ok: true };
  });

  app.post("/api/projects/:id/sessions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { agentId?: unknown; title?: unknown; worktreeId?: unknown };
    const worktreeId =
      typeof body.worktreeId === "string" && body.worktreeId ? body.worktreeId : undefined;
    // Validate the claimed worktree BEFORE the project-missing catch, so an
    // unknown worktree is a 404 through the error handler rather than a
    // misleading "project not found". Ensure `main` first: `createSession` and
    // `POST /api/projects` never create it, so a fresh Project's `main` row may
    // not exist yet (the "any worktree-touching path ensures main" rule).
    if (worktreeId) {
      await directory.ensureWorktree(id);
      await directory.requireWorktree(id, worktreeId);
    }
    try {
      const session = await directory.createSession(id, {
        ...(typeof body.agentId === "string" && body.agentId ? { agentId: body.agentId } : {}),
        ...(typeof body.title === "string" && body.title ? { title: body.title } : {}),
        ...(worktreeId ? { worktreeId } : {}),
      });
      return reply.code(201).send({ session });
    } catch {
      return reply.code(404).send({ error: `project not found: ${id}` });
    }
  });

  app.get("/api/projects/:id/sessions", async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { includeArchived?: string; worktreeId?: string };
    const includeArchived = query.includeArchived === "1";
    const sessions = await directory.listSessions(id, { includeArchived });
    return {
      sessions: query.worktreeId
        ? sessions.filter((session) => sessionWorktreeId(session) === query.worktreeId)
        : sessions,
    };
  });

  app.post("/api/projects/:id/sessions/:sessionId/rename", async (request, reply) => {
    const { id, sessionId } = request.params as { id: string; sessionId: string };
    const body = (request.body ?? {}) as { title?: unknown };
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return reply.code(400).send({ error: "title is required" });
    }
    if (!(await sessionInProject(id, sessionId))) {
      return reply.code(404).send({ error: `session not found: ${sessionId}` });
    }
    return { session: await directory.renameSession(sessionId, body.title.trim()) };
  });

  app.post("/api/projects/:id/sessions/:sessionId/archive", async (request, reply) => {
    const { id, sessionId } = request.params as { id: string; sessionId: string };
    if (!(await sessionInProject(id, sessionId))) {
      return reply.code(404).send({ error: `session not found: ${sessionId}` });
    }
    return { session: await directory.archiveSession(sessionId) };
  });

  app.post("/api/projects/:id/sessions/:sessionId/unarchive", async (request, reply) => {
    const { id, sessionId } = request.params as { id: string; sessionId: string };
    if (!(await sessionInProject(id, sessionId))) {
      return reply.code(404).send({ error: `session not found: ${sessionId}` });
    }
    return { session: await directory.unarchiveSession(sessionId) };
  });

  app.post("/api/projects/:id/sessions/:sessionId/delete", async (request, reply) => {
    const { id, sessionId } = request.params as { id: string; sessionId: string };
    if (!(await sessionInProject(id, sessionId))) {
      return reply.code(404).send({ error: `session not found: ${sessionId}` });
    }
    await directory.deleteSession(sessionId);
    return { ok: true };
  });

  // The Project-level result rollup: the turns of ALL its Sessions (docs/adr/0007).
  app.get("/api/projects/:id/runs", async (request) => {
    const { id } = request.params as { id: string };
    const { sessionId } = request.query as { sessionId?: string };
    const runs = await directory.listRuns(id);
    return { runs: sessionId ? runs.filter((run) => run.sessionId === sessionId) : runs };
  });

  // -- Conversation path -----------------------------------------------------
  app.post("/api/transport", async (request, reply) => {
    const body = (request.body ?? {}) as { commands?: unknown[]; state?: unknown };
    const commands = normalizeCommands(body.commands ?? []);

    // The request's scope — Principal, Project, and the Project's own adapter +
    // workspace — then the record's Session for the claimed threadId (resolved,
    // or first-use recorded; docs/adr/0007). Resolve identity BEFORE taking the
    // lock, so a failure here cannot leak it.
    const { principal, environment, projectId, session: sessionRecord } =
      await scope.sessionOf(request);

    const runKey = `${principal.tenant}:${sessionRecord.id}`;
    if (activeRuns.has(runKey)) {
      return reply
        .code(409)
        .send({ error: "a run is already in flight for this session" });
    }
    activeRuns.add(runKey);

    reply.hijack();
    reply.raw.writeHead(200, { ...sseHeaders(), ...corsHeaders(backend.cors) });

    const wire = new WireOpsBuilder(parseClaimedState(body));
    const session: SessionState = {
      sessionId: sessionRecord.id,
      projectId,
      agentId: sessionRecord.agentId,
      status: "idle",
      messages: [],
    };
    try {
      for await (const delta of environment.adapter.run(session, commands)) {
        for (const op of wire.fold(delta)) reply.raw.write(encodeOp(op));
      }
    } catch (err) {
      console.error("[transport-service] run failed", err);
    } finally {
      // The client's import only settles on [DONE]; always terminate.
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      activeRuns.delete(runKey);
    }
  });

  // -- Run control -----------------------------------------------------------
  app.post("/api/transport/abort", async (request) => {
    const body = (request.body ?? {}) as { reason?: string };
    const { environment } = await scope.acquire(request);
    environment.adapter.abort(body.reason);
    return { ok: true };
  });

  app.post("/api/transport/approve", async (request, reply) => {
    const body = (request.body ?? {}) as {
      approvalId?: string;
      decision?: "approve" | "reject";
    };
    if (!body.approvalId || (body.decision !== "approve" && body.decision !== "reject")) {
      return reply
        .code(400)
        .send({ error: "approvalId and decision (approve|reject) are required" });
    }
    const { environment } = await scope.acquire(request);
    const adapter = environment.adapter;
    // The adapter's method IS the capability; the conformance suite pins that it
    // agrees with the declared `capabilities.approvals`.
    if (typeof adapter.approve !== "function") {
      return reply
        .code(501)
        .send({ error: `runtime "${adapter.runtime}" has no approval surface` });
    }
    adapter.approve(body.approvalId, body.decision);
    return { ok: true };
  });

  // -- Runtime command catalog (slash menu, docs/adr/0003) -------------------
  app.get("/api/transport/commands", async (request) => {
    // The catalog belongs to the Project's OWN adapter (one per Project,
    // docs/adr/0008), so it follows the request's Project like every other route.
    const { environment } = await scope.acquire(request);
    const adapter = environment.adapter;
    // A runtime without the surface is NOT a failure: it answers an empty
    // catalog so the composer degrades to plain chat. A real failure is logged
    // and propagates — `useRuntimeCommands` owns the degrade (docs/adr/0021).
    if (typeof adapter.listCommands !== "function") return { commands: [] };
    try {
      return { commands: await adapter.listCommands() };
    } catch (err) {
      console.error("[transport-service] commands.list failed", err);
      throw err;
    }
  });

  // -- Live subagent activity (the dsh adapter's optional surface) -----------
  app.get("/api/transport/subagents", async (request) => {
    // Like the catalog, the subagent ledger belongs to the Project's OWN
    // adapter (one per Project, docs/adr/0008). A runtime without the surface
    // answers empty so the panel needs no runtime-specific branch; a real
    // failure propagates so `useSubagents` can keep its last good list
    // (docs/adr/0021).
    const { environment, threadId } = await scope.acquire(request);
    const adapter = environment.adapter;
    if (typeof adapter.subagents !== "function") return { subagents: [] };
    const sessionId = canonicalSessionKey(adapter, threadId);
    try {
      return { subagents: await adapter.subagents(sessionId) };
    } catch (err) {
      console.error("[transport-service] subagents.list failed", err);
      throw err;
    }
  });

  // -- Subagent child-session records (adapter-owned, optional surface) -----
  app.get("/api/transport/subagents/:childId/transcript", async (request, reply) => {
    // The record belongs to the Project's OWN adapter (docs/adr/0008), like
    // the list. A runtime without the surface (or a child it has no record
    // for) answers 404 — the panel degrades to a friendly state.
    const { environment, threadId } = await scope.acquire(request);
    const adapter = environment.adapter;
    const childId = (request.params as { childId?: string }).childId ?? "";
    if (!/^[A-Za-z0-9_-]+$/.test(childId)) {
      return reply.code(400).send({ error: "childId must be a single safe path segment" });
    }
    const sessionId = canonicalSessionKey(adapter, threadId);
    if (typeof adapter.subagentTranscript !== "function") {
      return reply.code(404).send({ error: `runtime "${adapter.runtime}" has no subagent records` });
    }
    // A `null` answer is the friendly "the record is not available" 404; a
    // THROWN read is a real failure and propagates (docs/adr/0021).
    try {
      const transcript = await adapter.subagentTranscript(sessionId, childId);
      if (transcript === null) {
        return reply.code(404).send({ error: "the subagent record is not available" });
      }
      return { transcript };
    } catch (err) {
      console.error("[transport-service] subagent transcript read failed", err);
      throw err;
    }
  });

  // -- Skills (the dsh adapter's optional surface, docs/adr/0020) ------------
  // The catalog belongs to the Project's OWN adapter (one per Project,
  // docs/adr/0008). A runtime without the surface answers "unavailable" so the
  // workbench tab degrades instead of needing a runtime-specific branch.
  app.get("/api/skills", async (request) => {
    const { environment } = await scope.acquire(request);
    const adapter = environment.adapter;
    if (typeof adapter.skills !== "function") {
      return { available: false, runtime: adapter.runtime, skills: [] };
    }
    try {
      return { available: true, runtime: adapter.runtime, skills: await adapter.skills() };
    } catch (err) {
      // A real failure propagates so the tab's own error state can be reached
      // (docs/adr/0021); `available:false` stays reserved for "no surface".
      console.error("[transport-service] skills.list failed", err);
      throw err;
    }
  });

  app.post("/api/skills/install", async (request, reply) => {
    // Skills are shared Project state: hosted mode gates the write like
    // /api/settings, while the read stays principal-only.
    const principal = request.principal!;
    if (!principal.local && !principal.roles.includes("manager")) {
      return reply
        .code(403)
        .send({ error: "changing skills requires a local or manager principal" });
    }
    const parsed = parseSkillInstall(request.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const { environment } = await scope.acquire(request);
    const adapter = environment.adapter;
    if (typeof adapter.installSkill !== "function") {
      return reply.code(501).send({ error: `runtime "${adapter.runtime}" has no skills surface` });
    }
    try {
      return { skill: await adapter.installSkill(parsed.input) };
    } catch (err) {
      return sendSkillError(reply, err);
    }
  });

  app.post("/api/skills/remove", async (request, reply) => {
    const principal = request.principal!;
    if (!principal.local && !principal.roles.includes("manager")) {
      return reply
        .code(403)
        .send({ error: "changing skills requires a local or manager principal" });
    }
    const parsed = parseSkillRemove(request.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const { environment } = await scope.acquire(request);
    const adapter = environment.adapter;
    if (typeof adapter.removeSkill !== "function") {
      return reply.code(501).send({ error: `runtime "${adapter.runtime}" has no skills surface` });
    }
    try {
      await adapter.removeSkill(parsed.name);
      return { removed: parsed.name };
    } catch (err) {
      return sendSkillError(reply, err);
    }
  });

  // -- Scheduled tasks (per-Project, service-owned) --------------------------
  // The scheduler is a controller, not a route: it is NOT auto-started here
  // (only `index.ts` `isMain` calls `start()`), so tests and embedders drive
  // `tick()`/`fire()` directly. Its one-in-flight-run lock is the SAME Set the
  // transport route uses, and `principal` is resolved once — `null` in hosted
  // mode, where the cron surface no-ops safely.
  const cronPrincipal = await backend.principal
    .resolve({ headers: {}, url: "" })
    .catch(() => null);
  const cronScheduler = createCronScheduler({
    store: cronStore,
    records,
    directory,
    environments: backend.environments,
    principal: cronPrincipal,
    activeRuns,
  });
  app.decorate("cronScheduler", cronScheduler);
  app.addHook("onClose", async () => {
    cronScheduler.stop();
  });
  registerCronRoutes(app, { scope, store: cronStore, scheduler: cronScheduler });

  // -- HPC compute (service-owned remote execution, docs/adr/0024) -----------
  // Like the cron scheduler, the poller is a controller: decorated on the app,
  // started ONLY by `index.ts`'s `isMain`; tests and embedders call `tick()`.
  // `backend.hpcSsh` is the test seam (a scripted runner); production builds
  // the real system-OpenSSH spawner. Routes never ask the cluster for state —
  // the ledger is the read model; submit/cancel/probe/staging are the writes.
  const ssh = backend.hpcSsh ?? (await createSshRunner());
  const loadHpcEndpoints = async () => (await loadSettings(settingsPath)).hpc?.endpoints ?? [];
  const hpcPoller = createHpcPoller({
    records,
    projects: async () => (await directory.listProjects()).map((project) => project.id),
    endpoints: loadHpcEndpoints,
    ssh,
  });
  app.decorate("hpcPoller", hpcPoller);
  app.addHook("onClose", async () => {
    hpcPoller.stop();
  });
  registerHpcRoutes(app, {
    scope,
    records,
    settingsPath,
    ssh,
    poller: hpcPoller,
    ...(backend.workspaceLimits ? { workspaceLimits: backend.workspaceLimits } : {}),
  });

  // -- Project git worktrees (docs/adr/0025) ---------------------------------
  // The repository is initialized lazily by the first create; listing a
  // Project's worktrees reads the record and never touches the disk. The
  // `projectRoot`/`git` seams let a test point both at a tmp dir and a fake git.
  const worktreeRoot = backend.projectRoot ?? process.env.PROJECT_ROOT;
  registerWorktreeRoutes(app, {
    scope,
    directory,
    records,
    environments: backend.environments,
    git: backend.git ?? createGitRunner(),
    ...(worktreeRoot ? { projectRoot: worktreeRoot } : {}),
  });

  // -- Standing watch (NDJSON, long-lived, NOT [DONE]-terminated) ------------
  app.get("/api/transport/watch", async (request, reply) => {
    const { environment, threadId } = await scope.acquire(request);
    if (typeof environment.adapter.subscribe !== "function") {
      return reply.code(400).send("adapter does not support watch");
    }
    const adapter = environment.adapter;
    // The watch needs only the canonical key: attaching must not mint a Session
    // row — the mount probe is what records the Session (docs/adr/0007).
    const sessionId = canonicalSessionKey(adapter, threadId);

    reply.hijack();
    reply.raw.writeHead(200, { ...ndjsonHeaders(), ...corsHeaders(backend.cors) });
    reply.raw.flushHeaders?.();

    const unsub = adapter.subscribe!(sessionId, (snapshot) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(JSON.stringify(snapshot) + "\n");
      } catch {
        /* client hung up — the `close` handler detaches the sink */
      }
    });
    request.raw.on("close", () => {
      try {
        unsub();
      } catch {
        /* never throw out of a server callback */
      }
    });
  });

  // -- Workspace file service: one workspace per Project (docs/adr/0006) ------
  app.get("/api/workspace/entries", async (request, reply) => {
    const { path = "" } = request.query as { path?: string };
    return scope.withWorkspace(request, reply, ({ environment }) => environment.workspace.list(path));
  });

  app.get("/api/workspace/stat", async (request, reply) => {
    const { path } = request.query as { path?: string };
    if (!path) return reply.code(400).send({ error: "path is required" });
    return scope.withWorkspace(request, reply, ({ environment }) => environment.workspace.stat(path));
  });

  app.get("/api/workspace/file", async (request, reply) => {
    const { path, download } = request.query as { path?: string; download?: string };
    if (!path) return reply.code(400).send({ error: "path is required" });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      // Inline reads are capped by the workspace (413 when over); an explicit
      // download streams any size instead of failing.
      const content = download
        ? await environment.workspace.open(path, { maxBytes: Number.POSITIVE_INFINITY })
        : await environment.workspace.open(path);
      const name = posix.basename(path);
      reply.header("content-type", content.mime);
      reply.header("content-length", String(content.size));
      reply.header("content-disposition", contentDisposition(download ? "attachment" : "inline", name));
      reply.header("cache-control", "no-store");
      return reply.send(Readable.fromWeb(content.body as Parameters<typeof Readable.fromWeb>[0]));
    });
  });

  // Non-covalent interactions for a MolQL selection over a workspace structure
  // file. Mol* runs headlessly here; the agent's `computeInteraction` tool calls
  // this route because the service is what owns the Project's file access.
  app.get("/api/workspace/interactions", async (request, reply) => {
    const { path, molql } = request.query as {
      path?: string;
      molql?: string;
    };
    if (!path) return reply.code(400).send({ error: "path is required" });
    if (!molql) return reply.code(400).send({ error: "molql is required" });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      const content = await environment.workspace.open(path, {
        maxBytes: STRUCTURE_MAX_BYTES,
      });
      const data = await readAll(content.body);
      try {
        return await computeInteractionsForSelection({ fileName: path, data, molql });
      } catch (err) {
        if (err instanceof UnsupportedStructureFormatError || err instanceof MolqlCompileError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    });
  });

  // Mol* measurements (label/distance/angle/dihedral/orientation/plane) over a
  // set of MolQL selections in a workspace structure file. Same headless molstar
  // path as the interactions route; the agent's `measurements` tool calls it.
  app.post("/api/workspace/measurements", async (request, reply) => {
    const body = (request.body ?? {}) as {
      path?: unknown;
      project?: unknown;
      kind?: unknown;
      selections?: unknown;
    };
    const path = typeof body.path === "string" ? body.path : "";
    if (!path) return reply.code(400).send({ error: "path is required" });
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!kind) return reply.code(400).send({ error: "kind is required" });
    const selections = Array.isArray(body.selections)
      ? body.selections.filter((s): s is string => typeof s === "string")
      : [];
    if (selections.length === 0) {
      return reply.code(400).send({ error: "selections (string[]) is required" });
    }
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      const content = await environment.workspace.open(path, { maxBytes: STRUCTURE_MAX_BYTES });
      const data = await readAll(content.body);
      try {
        return await computeMeasurements({ fileName: path, data, kind, selections });
      } catch (err) {
        if (
          err instanceof UnsupportedStructureFormatError ||
          err instanceof MolqlCompileError ||
          err instanceof MeasurementError
        ) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    });
  });

  app.post("/api/workspace/upload", async (request, reply) => {
    const { path } = request.query as { path?: string };
    if (!path) return reply.code(400).send({ error: "path is required" });
    const maxBytes = backend.workspaceLimits?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    const declared = Number(request.headers["content-length"]);

    return scope.withWorkspace(request, reply, async ({ principal, environment }) => {
      // The caps are checked only once the Project has a workspace, so a
      // deployment with none answers 503 rather than 413.
      if (Number.isFinite(declared)) {
        if (declared > maxBytes) {
          return reply
            .code(413)
            .send({ error: `upload is ${declared} bytes, over the ${maxBytes}-byte cap` });
        }
        // Quota is checked up front when the client declared a size; a streamed
        // upload without Content-Length is bounded by `maxBytes` instead.
        if (backend.quota) {
          try {
            await backend.quota.check(principal, declared);
          } catch (err) {
            return reply
              .code(507)
              .send({ error: err instanceof Error ? err.message : "quota exceeded" });
          }
        }
      }

      const body = request.body as Readable;
      const stat = await environment.workspace.write(
        path,
        Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>,
        { maxBytes },
      );
      return { attachment: attachmentFor(stat) };
    });
  });

  app.post("/api/workspace/delete", async (request, reply) => {
    const { path } = request.query as { path?: string };
    if (!path) return reply.code(400).send({ error: "path is required" });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      // `delete` is optional in the seam (a read-only or NullWorkspace omits it);
      // the seam's own failures (not found, path error) are mapped by withWorkspace.
      if (typeof environment.workspace.delete !== "function") {
        return reply.code(501).send({ error: "this workspace does not support delete" });
      }
      await environment.workspace.delete(path);
      return { ok: true };
    });
  });

  return app;
}

/**
 * The cap on a buffered JSON body (Fastify's default is 1 MiB).
 *
 * The transport route's body carries the client's WHOLE claimed transcript in
 * `state` (assistant-ui round-trips it on every send and probe), so it grows
 * with the conversation — the default rejected a grown session with
 * `FST_ERR_CTP_BODY_TOO_LARGE` (413) BEFORE the handler ran, wedging the
 * thread: every send and the mount probe failed identically. Streaming bodies
 * (the octet-stream upload parser) never pass through this limit; they keep
 * their own per-route caps. Override with `TRANSPORT_MAX_BODY_BYTES`.
 */
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

function maxJsonBodyBytes(env: Record<string, string | undefined>): number {
  const raw = env.TRANSPORT_MAX_BODY_BYTES;
  if (raw && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return DEFAULT_MAX_BODY_BYTES;
}

/** The `AttachmentRef` an upload yields (a workspace reference). */
function attachmentFor(stat: FileStat): AttachmentRef {
  const name = stat.path.slice(stat.path.lastIndexOf("/") + 1);
  return {
    kind: "workspace",
    path: stat.path,
    name,
    ...(stat.mime ? { mime: stat.mime } : {}),
    size: stat.size,
    entryKind: stat.kind === "dir" ? "dir" : "file",
  };
}

/**
 * Build a `Content-Disposition` value Node will accept.
 *
 * Node rejects any header value with a character outside Latin-1
 * (`ERR_INVALID_CHAR`), and a file name is agent/user-authored — a Chinese
 * report title turned every `open` into a 500. The ASCII fallback keeps legacy
 * clients working; the RFC 5987 `filename*` carries the real name. `attr-char`
 * (RFC 5987) excludes `'`, `(`, `)`, `*`, so percent-encode those too.
 */
function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Drain a workspace file stream into one buffer (structure parsing needs it all). */
async function readAll(body: FileContent["body"]): Promise<Buffer> {
  const stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
}

function ndjsonHeaders(): Record<string, string> {
  return {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
}

/** CORS for the hijacked (streamed) responses, which @fastify/cors cannot set. */
function corsHeaders(cors: CorsConfig): Record<string, string> {
  const origin =
    cors.origin === true ? "*" : Array.isArray(cors.origin) ? cors.origin.join(", ") : cors.origin;
  return {
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    ...(cors.credentials ? { "access-control-allow-credentials": "true" } : {}),
  };
}

/** Normalize assistant-ui transport commands into Science Studio commands. */
function normalizeCommands(cmds: unknown[]): TransportCommand[] {
  return cmds.map((c) => {
    const cmd = (c ?? {}) as Record<string, unknown>;
    if (cmd.type === "add-message") {
      const msg = (cmd.message ?? {}) as Record<string, unknown>;
      const parts = Array.isArray(msg.parts) ? (msg.parts as unknown[]) : undefined;
      // `@` mentions reach us as directive text; file parts arrive as parts.
      const mention = parseWorkspaceMentions(extractText(msg.content ?? parts));
      const attachments = [
        ...(parts ? attachmentsFromParts(parts) : []),
        ...attachmentsFromMentions(mention.mentions),
      ];
      return {
        type: "add-message",
        message: {
          id: typeof msg.id === "string" ? msg.id : `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: msg.role === "assistant" ? "assistant" : "user",
          content: mention.text,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      } satisfies TransportCommand;
    }
    return c as TransportCommand;
  });
}

/**
 * Lift file-bearing parts into `AttachmentRef`s. Both shapes are accepted:
 * - the domain part: `{type:"file", path, name, mime?, size?, source?}`;
 * - assistant-ui's `FileMessagePart`: `{type:"file", filename, data,
 *   mimeType?, sourceType?}`, which is what a composer attachment actually is.
 *
 * A part with a workspace path is a REFERENCE; one with only a payload is an
 * upload the file service must write first.
 */
function attachmentsFromParts(parts: unknown[]): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  for (const raw of parts) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    if (part.type !== "file") continue;
    const name = nonEmpty(part.name) ?? nonEmpty(part.filename);
    if (!name) continue;
    const path = nonEmpty(part.path);
    const mime = nonEmpty(part.mime) ?? nonEmpty(part.mimeType);
    const size = typeof part.size === "number" ? part.size : undefined;
    const data = nonEmpty(part.data);
    refs.push({
      kind: path ? "workspace" : "upload",
      ...(path ? { path } : {}),
      name,
      ...(mime ? { mime } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(!path && data ? { data } : {}),
    });
  }
  return refs;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : "",
      )
      .join("");
  }
  return String(content ?? "");
}
