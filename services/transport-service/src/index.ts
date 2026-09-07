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
import type { RecordStoreLike, RuntimeAdapter, RuntimeInitOptions, SessionState, StateDelta, TransportCommand, Message, MessagePart } from "@science-studio/transport";
import { createInMemoryRecordStore, type Artifact, type ArtifactKind, type RecordStore } from "@science-studio/record";
import type { Session } from "@science-studio/record";
import { OpenClawRuntimeAdapter } from "@science-studio/transport-openclaw";

export interface TransportServiceOptions {
  port?: number;
  /** Registered runtime adapters, keyed by id. */
  adapters?: RuntimeAdapter[];
  /** Record store wired to persist Runs/Artifacts. */
  recordStore?: RecordStore;
}

/**
 * Resolve the runtime adapter for a session. Skeleton default: openclaw.
 */
function resolveAdapter(adapters: RuntimeAdapter[], _session: Session): RuntimeAdapter {
  return adapters[0] ?? new OpenClawRuntimeAdapter();
}

/** Serialize a single state op into the assistant-transport SSE frame. */
function encodeOp(op: WireOp): string {
  return `data: ${JSON.stringify({ type: "update-state", path: [], operations: [op] })}\n\n`;
}

/** A client-safe operation: `set`, or `append-text` at a string path. */
interface WireOp {
  type: "set" | "append-text";
  path: string[];
  value: unknown;
}

const set = (path: string[], value: unknown): WireOp => ({ type: "set", path, value });
const appendText = (path: string[], value: string): WireOp => ({ type: "append-text", path, value });

/** The client state that travels in the request body (`state`). */
interface ClaimedState {
  status: SessionState["status"];
  messages: Record<string, Message>;
}

function parseClaimedState(body: { state?: unknown }): ClaimedState {
  const raw = (body.state ?? {}) as Record<string, unknown>;
  const status: SessionState["status"] =
    raw.status === "running" || raw.status === "error" ? raw.status : "idle";
  const messages: Record<string, Message> = {};
  const src = raw.messages;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const [id, value] of Object.entries(src as Record<string, unknown>)) {
      const msg = normalizeClaimedMessage(value);
      if (msg) messages[id] = msg;
    }
  }
  return { status, messages };
}

function normalizeClaimedMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.role !== "string") return null;
  const parts: MessagePart[] = Array.isArray(m.parts)
    ? (m.parts.filter((p) => p && typeof p === "object" && typeof (p as { type?: unknown }).type === "string") as MessagePart[])
    : [];
  return { id: m.id, role: m.role === "assistant" ? "assistant" : "user", parts };
}

function messagesToMap(messages: Message[]): Record<string, Message> {
  const map: Record<string, Message> = {};
  for (const m of messages) map[m.id] = m;
  return map;
}

function sameMessages(a: Record<string, Message>, b: Record<string, Message>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.hasOwn(b, k) && JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/**
 * Folds adapter state deltas into client-safe `set` operations.
 *
 * The assistant-ui accumulator on the client rejects every op type except `set`
 * and `append-text`, so purely incremental deltas (`add-part`, `append-text`)
 * must be materialized into full `parts` arrays here. The builder keeps a
 * mirror of the state it has emitted — seeded from the canonical transcript
 * snapshot — so materialization is always based on what the client has seen.
 *
 * `reconcile` deltas (yielded by the adapter at the start of every run) carry
 * the canonical transcript; when it differs from the client's claimed state we
 * stream a whole-message-map snapshot so stale/empty clients converge (this is
 * what makes history appear on initial load and after reloads).
 */
class WireOpsBuilder {
  private readonly claimed: ClaimedState;
  private messages: Record<string, Message>;
  private status: SessionState["status"];

  constructor(claimed: ClaimedState) {
    this.claimed = claimed;
    this.messages = { ...claimed.messages };
    this.status = claimed.status;
  }

  fold(delta: StateDelta): WireOp[] {
    switch (delta.type) {
      case "reconcile":
        return this.reconcile(delta.messages, delta.status);
      case "session-status": {
        this.status = delta.status;
        return [set(["status"], delta.status)];
      }
      case "add-message": {
        this.messages[delta.message.id] = delta.message;
        return [set(["messages", delta.message.id], delta.message)];
      }
      case "update-message":
        return this.updateMessage(delta.messageId, delta.patch);
      case "add-part":
        return this.appendPart(delta.messageId, delta.part);
      case "append-text":
        return this.appendPart(delta.messageId, { type: "text", text: delta.text });
      case "stream-text":
        return this.streamText(delta.messageId, delta.text, delta.replace === true);
      case "approval-required":
        return [set(["approval"], { id: delta.approvalId, kind: delta.kind, summary: delta.summary })];
      default: {
        const _exhaustive: never = delta;
        return [];
      }
    }
  }

  private reconcile(messages: Message[], status: SessionState["status"]): WireOp[] {
    const canonical = messagesToMap(messages);
    const ops: WireOp[] = [];
    if (sameMessages(this.claimed.messages, canonical)) {
      // Client is already in sync — keep its copy as the fold base.
      this.messages = { ...this.claimed.messages };
    } else {
      this.messages = canonical;
      ops.push(set(["messages"], canonical));
    }
    this.status = status;
    if (this.claimed.status !== status) ops.push(set(["status"], status));
    return ops;
  }

  private updateMessage(messageId: string, patch: Partial<Message>): WireOp[] {
    const base = this.messages[messageId];
    if (base === undefined) {
      // No known base (should not happen after a reconcile): materialize a full
      // message so the client's accumulator can apply a plain `set`.
      const msg: Message = {
        id: messageId,
        role: patch.role ?? "assistant",
        parts: patch.parts ?? [],
      };
      this.messages[messageId] = msg;
      return [set(["messages", messageId], msg)];
    }
    const ops: WireOp[] = [];
    if (patch.parts !== undefined) {
      base.parts = patch.parts;
      ops.push(set(["messages", messageId, "parts"], patch.parts));
    }
    if (patch.role !== undefined) {
      base.role = patch.role;
      ops.push(set(["messages", messageId, "role"], patch.role));
    }
    if (ops.length === 0) {
      const merged: Message = { ...base, ...patch };
      this.messages[messageId] = merged;
      return [set(["messages", messageId], merged)];
    }
    return ops;
  }

  private appendPart(messageId: string, part: MessagePart): WireOp[] {
    const base = this.messages[messageId];
    if (base === undefined) return []; // unknown message; drop rather than corrupt
    const parts = [...base.parts, part];
    base.parts = parts;
    return [set(["messages", messageId, "parts"], parts)];
  }

  /**
   * A streaming text fragment. Grows the message's trailing text part with a
   * tiny `append-text` op at the exact string path (the accumulator supports
   * it natively), or starts a new text part when the tail isn't text (e.g.
   * right after a tool call). `replace` overwrites the trailing text instead.
   */
  private streamText(messageId: string, text: string, replace: boolean): WireOp[] {
    const base = this.messages[messageId];
    if (base === undefined) return []; // assistant message must exist already
    const idx = base.parts.length - 1;
    const last = idx >= 0 ? base.parts[idx] : undefined;
    if (last && last.type === "text") {
      base.parts[idx] = { ...last, text: replace ? text : (last.text ?? "") + text };
      return replace
        ? [set(["messages", messageId, "parts", String(idx), "text"], text)]
        : [appendText(["messages", messageId, "parts", String(idx), "text"], text)];
    }
    const parts = [...base.parts, { type: "text" as const, text }];
    base.parts = parts;
    return [set(["messages", messageId, "parts"], parts)];
  }
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

  // Placeholder session; the real service hydrates it from the record store.
  // `status` starts idle — a running status would lock the composer forever
  // once it is mirrored into the canonical transcript.
  const sessionKey =
    typeof body.threadId === "string" && body.threadId.startsWith("agent:")
      ? body.threadId
      : (process.env.OPENCLAW_DEFAULT_SESSION ?? "agent:main:main");
  const session: SessionState = {
    sessionId: sessionKey,
    studyId: "study-1",
    agentId: "main",
    status: "idle",
    messages: [],
  };

  // Fold each adapter delta into client-safe ops, reconciling against the
  // client's claimed state (sent in `body.state`) so a fresh or reloaded
  // client always converges to the canonical transcript.
  const wire = new WireOpsBuilder(parseClaimedState(body));
  const adapter = resolveAdapter(adapters, {} as Session);
  for await (const delta of adapter.run(session, commands)) {
    for (const op of wire.fold(delta)) {
      res.write(encodeOp(op));
    }
  }
  res.write("data: [DONE]\n\n");
  res.end();
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

export function createTransportService(opts: TransportServiceOptions = {}): ReturnType<typeof createServer> {
  const adapters = opts.adapters ?? [new OpenClawRuntimeAdapter()];
  const adapt = async (a: RuntimeAdapter) => {
    try {
      await a.init({
        gateway: {
          url: process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789",
          token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
        },
        recordStore: toRecordStoreLike(opts.recordStore ?? createInMemoryRecordStore()),
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
