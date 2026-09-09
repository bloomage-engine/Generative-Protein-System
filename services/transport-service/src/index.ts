import "dotenv/config";

/**
 * Backend assistant-transport service.
 *
 * Speaks assistant-ui's `useAssistantTransportRuntime` wire protocol to the
 * frontend (command-in / state-snapshot-out) and delegates the actual agent
 * execution to a registered `RuntimeAdapter`. The frontend never changes when
 * the runtime swaps (see docs/adr/0001).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CommandDescriptor, RecordStoreLike, RuntimeAdapter, RuntimeInitOptions, SessionState, TransportCommand } from "@science-studio/transport";
import { createInMemoryRecordStore, type Artifact, type ArtifactKind, type RecordStore } from "@science-studio/record";
import type { Session } from "@science-studio/record";
import { OpenClawRuntimeAdapter } from "@science-studio/transport-openclaw";
import { DshRuntimeAdapter } from "@science-studio/transport-dsh";
import { encodeOp, parseClaimedState, WireOpsBuilder, type WireOp } from "./wire.js";

export interface TransportServiceOptions {
  port?: number;
  /** Registered runtime adapters, keyed by id. */
  adapters?: RuntimeAdapter[];
  /** Record store wired to persist Runs/Artifacts. */
  recordStore?: RecordStore;
}

/**
 * Resolve the runtime adapter for a session. The service is runtime-agnostic:
 * the caller registers the adapter(s); when none are given, one is chosen by
 * the `TRANSPORT_RUNTIME` env var (default: openclaw).
 */
function resolveAdapter(adapters: RuntimeAdapter[], _session: Session): RuntimeAdapter {
  return adapters[0] ?? defaultAdapters()[0]!;
}

/**
 * assistant-ui's in-memory thread list mints a per-page LOCAL thread id when
 * the app never declares a real remote session (every one of our current apps
 * is a one-session UI), and sends carry that id while the mount probe sends
 * none. Both must land on the SAME canonical session, so local-mint ids are
 * treated as "no session claimed" (like openclaw treats a non-`agent:` id).
 */
const ASSISTANT_UI_LOCAL_THREAD_PREFIX = "__LOCALID_";

/**
 * Resolve the session key a request targets. A non-empty `threadId` passes
 * through when it names a real session (openclaw: `agent:`-prefixed; dsh:
 * any stable client-chosen id — the SDK lazily creates the session). Ids the
 * client framework mints locally, or an absent id, fall back to the selected
 * runtime's default session env var.
 */
function resolveSessionKey(threadId: unknown, runtime: string): string {
  if (typeof threadId === "string" && threadId.length > 0) {
    if (runtime === "openclaw" && !threadId.startsWith("agent:")) return fallbackSessionKey(runtime);
    if (runtime === "dsh" && threadId.startsWith(ASSISTANT_UI_LOCAL_THREAD_PREFIX)) return fallbackSessionKey(runtime);
    return threadId;
  }
  return fallbackSessionKey(runtime);
}

function fallbackSessionKey(runtime: string): string {
  if (runtime === "dsh") return process.env.DSH_DEFAULT_SESSION ?? "default";
  return process.env.OPENCLAW_DEFAULT_SESSION ?? "agent:main:main";
}

async function handleTransport(
  req: IncomingMessage,
  res: ServerResponse,
  adapters: RuntimeAdapter[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
    commands?: unknown[];
    /** The state the client claims to hold; the fold reconciles against it. */
    state?: unknown;
    threadId?: string | null;
  };
  const commands = normalizeCommands(body.commands ?? []);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...corsHeaders(),
  });

  // Fold each adapter delta into client-safe ops, reconciling against the
  // client's claimed state (sent in `body.state`) so a fresh or reloaded
  // client always converges to the canonical transcript.
  const wire = new WireOpsBuilder(parseClaimedState(body));
  const adapter = resolveAdapter(adapters, {} as Session);
  const sessionKey = resolveSessionKey(body.threadId, adapter.runtime);
  const session: SessionState = {
    sessionId: sessionKey,
    studyId: "study-1",
    agentId: "main",
    status: "idle",
    messages: [],
  };

  for await (const delta of adapter.run(session, commands)) {
    for (const op of wire.fold(delta)) {
      res.write(encodeOp(op));
    }
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Resolve the session key a watch connection should observe. */
function watchSessionKey(req: IncomingMessage, runtime: string): string {
  try {
    const threadId = new URL(req.url ?? "/api/transport/watch", "http://localhost").searchParams.get("threadId");
    return resolveSessionKey(threadId, runtime);
  } catch {
    return fallbackSessionKey(runtime);
  }
}

/**
 * Command catalog endpoint (JSON). Delegates to the runtime adapter's
 * `listCommands()` (docs/adr/0003) so the frontend slash menu is driven by
 * the runtime's own catalog; adapters without a command surface report an
 * empty catalog and the client simply shows no menu.
 */
async function handleCommands(
  res: ServerResponse,
  adapters: RuntimeAdapter[],
): Promise<void> {
  const adapter = resolveAdapter(adapters, {} as Session);
  let commands: CommandDescriptor[] = [];
  if (typeof adapter.listCommands === "function") {
    try {
      commands = await adapter.listCommands();
    } catch (err) {
      console.error("[transport-service] commands.list failed", err);
    }
  }
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-cache",
    ...corsHeaders(),
  });
  res.end(JSON.stringify({ commands }));
}

/**
 * Standing watch endpoint (NDJSON, long-lived, NOT `[DONE]`-terminated). Pushes
 * the session's canonical `WatchSnapshot` on attach (baseline) and on each
 * coalesced settle, so an open browser can adopt remote assistant replies via
 * `importExternalState` without a request/response round-trip. The request-
 * response run channel (`POST /api/transport`) is untouched.
 */
async function handleWatch(
  req: IncomingMessage,
  res: ServerResponse,
  adapters: RuntimeAdapter[],
): Promise<void> {
  const adapter = resolveAdapter(adapters, {} as Session);
  const sessionKey = watchSessionKey(req, adapter.runtime);
  if (typeof adapter.subscribe !== "function") {
    res.writeHead(400, { ...corsHeaders() }).end("adapter does not support watch");
    return;
  }

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...corsHeaders(),
  });
  // Flush the baseline frame immediately (subscribe pushes it synchronously) so
  // a fresh client converges before the first remote settle.
  res.flushHeaders?.();

  const unsub = adapter.subscribe(sessionKey, (snapshot) => {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(JSON.stringify(snapshot) + "\n");
    } catch {
      /* client hung up — the `close` handler below detaches the sink */
    }
  });
  req.on("close", () => {
    try {
      unsub();
    } catch {
      /* never throw out of a server callback */
    }
  });
}

/** Narrow the authoritative record store to the runtime-agnostic adapter seam. */
function toRecordStoreLike(store: RecordStore): RecordStoreLike {
  return {
    addRun: async (run) => {
      await store.addRun(run);
    },
    addArtifact: async (input) => {
      const kind: ArtifactKind = (
        ["dataset", "figure", "report", "code", "model", "other"] as const
      ).includes(input.kind as ArtifactKind)
        ? (input.kind as ArtifactKind)
        : "other";
      const artifact: Artifact = {
        id: `art-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        runId: input.runId,
        name: input.name,
        kind,
        location: input.location,
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
      };
      await store.addArtifact(artifact);
    },
  };
}

/** Build the default adapter list when the caller registers none. */
function defaultAdapters(): RuntimeAdapter[] {
  return (process.env.TRANSPORT_RUNTIME ?? "openclaw") === "dsh"
    ? [new DshRuntimeAdapter()]
    : [new OpenClawRuntimeAdapter()];
}

export function createTransportService(opts: TransportServiceOptions = {}): ReturnType<typeof createServer> {
  const adapters = opts.adapters && opts.adapters.length > 0 ? opts.adapters : defaultAdapters();
  const adapt = async (a: RuntimeAdapter) => {
    try {
      await a.init({
        gateway: {
          url: process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789",
          token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
        },
        recordStore: toRecordStoreLike(opts.recordStore ?? createInMemoryRecordStore()),
        config: { ...process.env },
      });
    } catch (e) {
      console.error("[transport-service] adapter init failed", e);
    }
  };
  void Promise.all(adapters.map(adapt));

  return createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...corsHeaders() }).end();
      return;
    }
    if (req.method === "GET" && req.url === "/api/transport/commands") {
      void handleCommands(res, adapters).catch((e) => {
        console.error("[transport-service] commands error", e);
        if (!res.headersSent) {
          res.writeHead(500, { ...corsHeaders() });
          res.end("commands error");
        }
      });
      return;
    }
    if (req.method === "GET" && (req.url === "/api/transport/watch" || req.url?.startsWith("/api/transport/watch?"))) {
      void handleWatch(req, res, adapters).catch((e) => {
        console.error("[transport-service] watch error", e);
        if (!res.headersSent) {
          res.writeHead(500, { ...corsHeaders() });
          res.end("watch error");
        }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/transport") {
      void handleTransport(req, res, adapters).catch((e) => {
        console.error("[transport-service] request error", e);
        try {
          res.writeHead(500, { ...corsHeaders() });
          res.end("transport error");
        } catch {
          /* already closed */
        }
      });
      return;
    }
    res.writeHead(404, { ...corsHeaders() }).end();
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

/** Normalize assistant-ui transport commands into Science Studio commands. */
function normalizeCommands(cmds: unknown[]): TransportCommand[] {
  return cmds.map((c) => {
    const cmd = (c ?? {}) as Record<string, unknown>;
    if (cmd.type === "add-message") {
      const msg = (cmd.message ?? {}) as Record<string, unknown>;
      return {
        type: "add-message",
        message: {
          id: typeof msg.id === "string" ? msg.id : `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: msg.role === "assistant" ? "assistant" : "user",
          content: extractText(msg.content ?? msg.parts),
        },
      } satisfies TransportCommand;
    }
    return c as TransportCommand;
  });
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  return String(content ?? "");
}

// Start when run directly (npm run dev / start).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = createTransportService({ port: Number(process.env.PORT ?? 3001) });
  server.listen(Number(process.env.PORT ?? 3001), () => {
    console.log(`[transport-service] listening on http://localhost:${process.env.PORT ?? 3001}/api/transport`);
  });
}
