/**
 * Fastify server: the assistant-transport wire, unchanged.
 *
 * Every route runs the same preamble — resolve the `Principal`, then acquire the
 * session's `Environment` (runtime + workspace) — so deployment mode and
 * tenancy never reach a route body. The transport/watch routes stream by
 * hijacking the Node response; Fastify's buffering must never sit in that path.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { createInMemoryRecordStore } from "@science-studio/record";
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
  FileTooLargeError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  WorkspaceUnavailableError,
  attachmentsFromMentions,
  parseWorkspaceMentions,
} from "@science-studio/transport";
import type { Backend, CorsConfig } from "./composition.js";
import { createSessionResolver } from "./sessions.js";
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

  // One in-flight run per session. `Transcript.attachFlow` overwrites the
  // current flow, so two concurrent runs on the same session would interleave
  // and corrupt both streams — refuse the second instead.
  const activeRuns = new Set<string>();

  // Session identity is record-owned (docs/adr/0002): a runtime session key is
  // the Science Studio Session id, minted on first use.
  const sessions = createSessionResolver({
    store: backend.records ?? createInMemoryRecordStore(),
    ...(backend.sessionDefaults ? { defaults: backend.sessionDefaults } : {}),
  });

  // -- Conversation path -----------------------------------------------------
  app.post("/api/transport", async (request, reply) => {
    const principal = request.principal!;
    const body = (request.body ?? {}) as {
      commands?: unknown[];
      state?: unknown;
      threadId?: string | null;
    };
    const commands = normalizeCommands(body.commands ?? []);
    const environment = await backend.environments.acquire(principal, body.threadId ?? null);

    const runKey = `${principal.tenant}:${environment.sessionKey}`;
    // Resolve identity BEFORE taking the lock, so a failure here cannot leak it.
    const sessionRecord = await sessions.resolve(environment.sessionKey);
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
      studyId: sessionRecord.studyId,
      agentId: sessionRecord.agentBlueprintId,
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
  app.post("/api/transport/abort", async (request, reply) => {
    const body = (request.body ?? {}) as { threadId?: string | null; reason?: string };
    const environment = await backend.environments.acquire(request.principal!, body.threadId ?? null);
    environment.adapter.abort(body.reason);
    return { ok: true };
  });

  app.post("/api/transport/approve", async (request, reply) => {
    const body = (request.body ?? {}) as {
      threadId?: string | null;
      approvalId?: string;
      decision?: "approve" | "reject";
    };
    if (!body.approvalId || (body.decision !== "approve" && body.decision !== "reject")) {
      return reply
        .code(400)
        .send({ error: "approvalId and decision (approve|reject) are required" });
    }
    const environment = await backend.environments.acquire(request.principal!, body.threadId ?? null);
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
    const environment = await backend.environments.acquire(request.principal!, null);
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
    const threadId = (request.query as { threadId?: string }).threadId ?? null;
    const environment = await backend.environments.acquire(request.principal!, threadId);
    if (typeof environment.adapter.subscribe !== "function") {
      return reply.code(400).send("adapter does not support watch");
    }

    reply.hijack();
    reply.raw.writeHead(200, { ...ndjsonHeaders(), ...corsHeaders(backend.cors) });
    reply.raw.flushHeaders?.();

    const adapter = environment.adapter;
    const unsub = adapter.subscribe!(environment.sessionKey, (snapshot) => {
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

  // -- Workspace file service (read-only in v1; uploads arrive in Phase 2) ---
  app.get("/api/workspace/entries", async (request, reply) => {
    const { path = "", session = null } = request.query as {
      path?: string;
      session?: string | null;
    };
    try {
      const environment = await backend.environments.acquire(request.principal!, session);
      return await environment.workspace.list(path);
    } catch (err) {
      return sendWorkspaceError(reply, err);
    }
  });

  app.get("/api/workspace/stat", async (request, reply) => {
    const { path, session = null } = request.query as {
      path?: string;
      session?: string | null;
    };
    if (!path) return reply.code(400).send({ error: "path is required" });
    try {
      const environment = await backend.environments.acquire(request.principal!, session);
      return await environment.workspace.stat(path);
    } catch (err) {
      return sendWorkspaceError(reply, err);
    }
  });

  app.get("/api/workspace/file", async (request, reply) => {
    const {
      path,
      session = null,
      download,
    } = request.query as { path?: string; session?: string | null; download?: string };
    if (!path) return reply.code(400).send({ error: "path is required" });
    try {
      const environment = await backend.environments.acquire(request.principal!, session);
      // Inline reads are capped by the workspace (413 when over); an explicit
      // download streams any size instead of failing.
      const content = download
        ? await environment.workspace.open(path, { maxBytes: Number.POSITIVE_INFINITY })
        : await environment.workspace.open(path);
      const name = posix.basename(path).replace(/"/g, "");
      reply.header("content-type", content.mime);
      reply.header("content-length", String(content.size));
      reply.header(
        "content-disposition",
        `${download ? "attachment" : "inline"}; filename="${name}"`,
      );
      reply.header("cache-control", "no-store");
      return reply.send(Readable.fromWeb(content.body as Parameters<typeof Readable.fromWeb>[0]));
    } catch (err) {
      return sendWorkspaceError(reply, err);
    }
  });

  app.post("/api/workspace/upload", async (request, reply) => {
    const { path, session = null } = request.query as {
      path?: string;
      session?: string | null;
    };
    if (!path) return reply.code(400).send({ error: "path is required" });

    let environment;
    try {
      environment = await backend.environments.acquire(request.principal!, session);
    } catch (err) {
      return sendWorkspaceError(reply, err);
    }

    const maxBytes = backend.workspaceLimits?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    const declared = Number(request.headers["content-length"]);
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
          await backend.quota.check(request.principal!, declared);
        } catch (err) {
          return reply
            .code(507)
            .send({ error: err instanceof Error ? err.message : "quota exceeded" });
        }
      }
    }

    try {
      const body = request.body as Readable;
      const stat = await environment.workspace.write(
        path,
        Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>,
        { maxBytes },
      );
      return { attachment: attachmentFor(stat) };
    } catch (err) {
      return sendWorkspaceError(reply, err);
    }
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

/** Map a workspace error onto an HTTP status; rethrow anything unrecognized. */
function sendWorkspaceError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof FileTooLargeError) return reply.code(413).send({ error: err.message });
  if (err instanceof WorkspacePathError) return reply.code(400).send({ error: err.message });
  if (err instanceof WorkspaceUnavailableError) return reply.code(503).send({ error: err.message });
  throw err;
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
