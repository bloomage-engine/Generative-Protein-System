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
import { createInMemoryRecordStore, type Session } from "@science-studio/record";
import type {
  AttachmentRef,
  CommandDescriptor,
  FileStat,
  Principal,
  SessionState,
  TransportCommand,
} from "@science-studio/transport";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  attachmentsFromMentions,
  parseWorkspaceMentions,
} from "@science-studio/transport";
import type { Backend, CorsConfig } from "./composition.js";
import { createRecordDirectory, DEFAULT_RECORD_DEFAULTS } from "./directory.js";
import { canonicalSessionKey, createProjectScopes } from "./project-scope.js";
import {
  loadSettings,
  mergeSettings,
  parseSettingsPatch,
  resolveSettingsPath,
  saveSettings,
  viewOf,
} from "./settings.js";
import { encodeOp, parseClaimedState, WireOpsBuilder } from "./wire.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export async function createServer(backend: Backend): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

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
      console.error(`[transport-service] recycling project "${id}" failed`, err);
      return reply.code(500).send({ error: "failed to recycle the project workspace" });
    }
    await directory.deleteProject(id);
    try {
      await backend.environments.release?.(principal, id);
    } catch (err) {
      console.error(`[transport-service] releasing project "${id}" failed`, err);
    }
    return { ok: true };
  });

  app.post("/api/projects/:id/sessions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { agentId?: unknown; title?: unknown };
    try {
      const session = await directory.createSession(id, {
        ...(typeof body.agentId === "string" && body.agentId ? { agentId: body.agentId } : {}),
        ...(typeof body.title === "string" && body.title ? { title: body.title } : {}),
      });
      return reply.code(201).send({ session });
    } catch {
      return reply.code(404).send({ error: `project not found: ${id}` });
    }
  });

  app.get("/api/projects/:id/sessions", async (request) => {
    const { id } = request.params as { id: string };
    const includeArchived = (request.query as { includeArchived?: string }).includeArchived === "1";
    return { sessions: await directory.listSessions(id, { includeArchived }) };
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
    let commands: CommandDescriptor[] = [];
    if (typeof environment.adapter.listCommands === "function") {
      try {
        commands = await environment.adapter.listCommands();
      } catch (err) {
        console.error("[transport-service] commands.list failed", err);
      }
    }
    return { commands };
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
