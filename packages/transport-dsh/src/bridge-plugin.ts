/**
 * The CHILD-side half of the dsh command bridge: a cordis plugin that exposes
 * the harness's own command registry (`@deepseek-ai/dsh-commands`) over a
 * private UNIX socket, so the Science Studio adapter — which speaks to this
 * child over a stdio wire with no command plane (docs/adr/0010) — can list and
 * execute the harness's commands.
 *
 * It has TWO halves, because a command reaches this child two ways:
 *
 * - the SOCKET (`GET /commands`, `POST /execute`) is the adapter's direct path,
 *   used whenever the session already HAS an agent;
 * - the `agent/pre-step` LISTENER is the inbound path for a session that has
 *   none: the registry is agent-scoped and the SDK wire's only agent-creating
 *   verb is a prompt, so the adapter sends the command line as that session's
 *   first prompt and this listener runs it instead of the model, rejecting the
 *   step (docs/adr/0011).
 *
 * This file is loaded INTO the harness child by a per-launch profile patch
 * (`--patch <file>`, see `bridge.ts`), not imported by the adapter. Two
 * consequences:
 *
 * - It must stay dependency-free. The child's cordis/@deepseek-ai copies are
 *   its own, at whatever version it pinned, so this module imports NOTHING from
 *   `@deepseek-ai/*` — not even types. The two services it uses are declared as
 *   local structural views (the way `transport-openclaw/src/commands.ts`
 *   declares `GatewayCommandEntry`), and a harness release that moves them
 *   surfaces as an `unavailable` reply rather than a crash.
 * - It must never write to stdout: the child's stdout is the JSON-RPC wire
 *   ("Stdout is reserved for newline-delimited JSON-RPC frames" —
 *   `@deepseek-ai/dsh-sdk-app/README.md`). Every diagnostic goes to stderr.
 *
 * A throwing plugin fails the whole child boot, so `apply` fails SOFT: a
 * missing config or a failed listen writes one stderr line and leaves the child
 * running without a bridge.
 */
import { chmodSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
// The ONE command-line grammar, shared with the adapter (`commands.ts` imports
// only a type from outside this package, so this stays dependency-free).
import { parseCommandLine } from "./commands.js";

/** Structural view of one harness agent; the child's cordis instance owns the real shape. */
export type BridgeAgent = object;

/** One catalog entry as the harness's registry reports it (a `CommandDescriptor` there). */
export interface BridgeCommandDescriptor {
  name: string;
  description: string;
  input?: { hint: string };
}

/** One inbox message as the pre-step reports it (a `UserMessage` there). */
export interface BridgeMessage {
  content?: readonly { type?: string; text?: string }[];
  source?: { kind?: string };
}

/** The `agent/pre-step` payload the interception reads; the rest passes through. */
export interface BridgePreStepPayload {
  agent: BridgeAgent;
  messages: readonly BridgeMessage[];
  /** The turn's cancellation signal, handed to the command handler. */
  signal?: AbortSignal;
}

/** What the waterfall decides: `reject` runs no model call for this step. */
export interface BridgePreStepDecision {
  kind: "reject" | "enter";
}

/** Structural view of the agent an `agent/assistant-stream` frame belongs to. */
export interface BridgeStreamAgent {
  session?: { id?: unknown };
}

/** One live assistant frame, read structurally (the child owns the real shape). */
export interface BridgeAssistantStreamFrame {
  type: "start" | "chunk" | "end";
  attemptId?: string;
  revision?: number;
  turn?: number;
  step?: number;
  index?: number;
  time?: number;
  chunk?: unknown;
  outcome?: unknown;
}

/** The `agent/assistant-stream` payload the forwarder reads. */
export interface BridgeAssistantStreamPayload {
  agent: BridgeStreamAgent;
  frame: BridgeAssistantStreamFrame;
}

/** Structural view of the harness services this bridge reads. */
export interface BridgeHost {
  commands: {
    list(agent: BridgeAgent): readonly BridgeCommandDescriptor[];
    execute(
      agent: BridgeAgent,
      line: string,
      attachments: readonly unknown[],
      signal: AbortSignal,
    ): Promise<{ result: { kind: "success" | "error"; text?: string } } | undefined>;
  };
  agents: {
    /** Shared agent/session id lookup (`AgentRegistry.get`). */
    get(id: string): BridgeAgent | undefined;
    /** Top-level agents in registration order — `0.1.5-alpha.1` names it `roots`. */
    roots?(): BridgeAgent[];
    /** The same listing under its other documented name. */
    listTopLevel?(): BridgeAgent[];
    /** All live agents in registration order (`AgentRegistry.list`). */
    list(): BridgeAgent[];
  };
  effect(body: () => () => void, label?: string): unknown;
  /**
   * The `agent/pre-step` waterfall (optional: a harness that moved it must
   * degrade to "no interception" rather than failing the child's boot).
   */
  on?(
    event: "agent/pre-step",
    listener: (
      payload: BridgePreStepPayload,
      next: () => Promise<BridgePreStepDecision>,
    ) => Promise<BridgePreStepDecision>,
  ): () => void;
  /**
   * The process-local `agent/assistant-stream` publication (optional, same
   * fail-soft rule). A host-scope listener receives every agent's frames.
   */
  on?(
    event: "agent/assistant-stream",
    listener: (payload: BridgeAssistantStreamPayload) => void,
    options?: { global?: boolean },
  ): () => void;
}

export const name = "science-studio-command-bridge";
export const inject = ["commands", "agents"];

export interface BridgePluginConfig {
  /** Absolute socket path (a named pipe on win32) this bridge listens on. */
  socket: string;
}

/** Body cap for one `/execute` request. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * One stderr line. NEVER stdout: it carries the JSON-RPC frames.
 */
function warn(message: string, error?: unknown): void {
  const detail = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[ss-command-bridge] ${message}${detail}\n`);
}

/**
 * The agent a request targets. A named session resolves exactly; without one
 * this is the newest live top-level agent — what the dispatching UI would be
 * talking to — falling back to the newest live agent of any depth.
 */
function resolveAgent(ctx: BridgeHost, sessionId?: unknown): BridgeAgent | undefined {
  if (typeof sessionId === "string" && sessionId !== "") return ctx.agents.get(sessionId);
  const top = ctx.agents.roots?.() ?? ctx.agents.listTopLevel?.() ?? [];
  return top.at(-1) ?? ctx.agents.list().at(-1);
}

/**
 * Read a request body, keeping at most {@link MAX_BODY_BYTES} of it and
 * ANSWERING an over-cap body rather than aborting the socket mid-read (an
 * early exit would destroy the request before the 400 could be written).
 */
async function readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      over = true;
      return;
    }
    chunks.push(chunk);
  });
  try {
    await once(req, "end");
  } catch (err) {
    return { ok: false, message: String(err) };
  }
  if (over) return { ok: false, message: `request body exceeds ${MAX_BODY_BYTES} bytes` };
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/** One JSON response; every path of this bridge answers with one. */
function send(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** `GET /commands` — the catalog for the resolved agent, `[]` when none is live. */
function listCommands(ctx: BridgeHost): BridgeCommandDescriptor[] {
  const agent = resolveAgent(ctx);
  if (!agent) return [];
  return ctx.commands.list(agent).map((entry) => ({
    name: entry.name,
    description: entry.description,
    ...(entry.input === undefined ? {} : { input: { hint: entry.input.hint } }),
  }));
}

/** `POST /execute` — run one exact command line against one exact session's agent. */
async function executeCommand(
  ctx: BridgeHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  if (!body.ok) {
    send(res, 400, { status: "failed", message: body.message });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    send(res, 400, { status: "failed", message: "unparsable JSON body" });
    return;
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const sessionId = record["sessionId"];
  const line = record["line"];
  if (typeof sessionId !== "string" || typeof line !== "string") {
    send(res, 400, { status: "failed", message: "expected { sessionId: string, line: string }" });
    return;
  }
  // No fallback agent here: an execution targets one exact session's agent, and
  // "that agent does not exist yet" is a different answer from "no catalog".
  const agent = resolveAgent(ctx, sessionId);
  if (!agent) {
    send(res, 200, { status: "no-agent" });
    return;
  }
  // The dispatching request IS our socket request, which is exactly what the
  // registry documents its signal as ("cancellation signal owned by the
  // dispatching UI request").
  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => controller.abort());
  try {
    const execution = await ctx.commands.execute(agent, line, [], controller.signal);
    if (!execution) {
      // Syntax miss or unknown name: the registry logged nothing.
      send(res, 200, { status: "unknown" });
      return;
    }
    const { kind, text } = execution.result;
    send(res, 200, { status: "ok", kind, ...(text === undefined ? {} : { text }) });
  } catch (err) {
    warn("command execution failed", err);
    send(res, 200, { status: "failed", message: err instanceof Error ? err.message : String(err) });
  }
}

/** The command line one claimed prompt carries, or `null` when it is not one. */
function commandLineOf(message: BridgeMessage): string | null {
  const blocks = message.content ?? [];
  // A command is the prompt and nothing else: one text block, no attachment.
  if (blocks.length !== 1 || blocks[0]?.type !== "text") return null;
  const text = (blocks[0].text ?? "").trim();
  return parseCommandLine(text) === null ? null : text;
}

/**
 * The lines a proposed step carries when EVERY user prompt in it is a command
 * line, or `null` when the step is an ordinary model turn. Only user-sourced
 * messages count: model-facing context another plugin injected into the inbox
 * is not what the user typed.
 */
function commandLines(claimed: readonly BridgeMessage[]): string[] | null {
  const prompts = claimed.filter((message) => message.source?.kind === "user");
  if (prompts.length === 0) return null;
  const lines: string[] = [];
  for (const prompt of prompts) {
    const line = commandLineOf(prompt);
    if (line === null) return null;
    lines.push(line);
  }
  return lines;
}

/**
 * The one INBOUND path a command has into this child: a `/`-line PROMPT.
 *
 * The SDK wire is create-only and the harness's registry is agent-scoped, so a
 * session that has not prompted yet has no agent to run a command against. The
 * adapter resolves that by driving the command line as the session's FIRST
 * prompt — which is what creates the agent — and this listener is what keeps
 * that line away from the model: the harness's own registry runs it and the
 * step is REJECTED, so the turn ends `blocked` with no model call (docs/adr/0011).
 *
 * A step is intercepted only when every user prompt in it is a command line: a
 * mixed batch stays an ordinary turn rather than dropping a real message.
 */
function interceptCommandPrompts(ctx: BridgeHost): (() => void) | null {
  if (typeof ctx.on !== "function") {
    warn("no event surface; a command line sent as a prompt would reach the model");
    return null;
  }
  return ctx.on("agent/pre-step", async (payload, next) => {
    const lines = commandLines(payload.messages ?? []);
    if (lines === null) return next();
    const signal = payload.signal ?? new AbortController().signal;
    for (const line of lines) {
      try {
        await ctx.commands.execute(payload.agent, line, [], signal);
      } catch (err) {
        // The registry settles a thrown handler as its own `command/done`; this
        // net is for one that failed before it could. The step is rejected
        // either way — a command line never becomes a model prompt.
        warn(`the command "${line}" failed`, err);
      }
    }
    return { kind: "reject" };
  });
}

/**
 * `GET /assistant-stream` — hold the connection open and write one NDJSON line
 * per live assistant frame, `{ sessionId, frame }`. The listener is registered
 * when the client connects and disposed on disconnect; a subsystem without the
 * event surface answers 503 so the adapter falls back to step granularity.
 */
function streamAssistant(ctx: BridgeHost, res: ServerResponse): void {
  if (typeof ctx.on !== "function") {
    send(res, 503, { status: "unavailable", message: "no event surface" });
    return;
  }
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let off: (() => void) | null = null;
  const cleanup = (): void => {
    const fn = off;
    off = null;
    try {
      fn?.();
    } catch {
      // already disposed
    }
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
  try {
    off = ctx.on(
      "agent/assistant-stream",
      ({ agent, frame }) => {
        const sessionId = agent?.session?.id;
        if (typeof sessionId !== "string" || sessionId === "") return;
        try {
          res.write(`${JSON.stringify({ sessionId, frame })}\n`);
        } catch (err) {
          warn("assistant-stream write failed", err);
          cleanup();
        }
      },
      { global: true },
    );
  } catch (err) {
    warn("assistant-stream subscription unavailable", err);
    cleanup();
    if (!res.writableEnded) res.end();
  }
}

/**
 * `POST /interrupt` — cancel the active turn of one exact session's agent.
 *
 * Mirrors the harness's own web UI: `agent.cancel({ kind: "user" }, {
 * keepInbox: true })` aborts the in-flight turn (and any steering) while
 * preserving queued work, so a prompt sent right after runs once the aborted
 * activity converges to idle. The SDK wire has NO cancel method, so this bridge
 * is the only way to stop a turn that is already running (docs/adr/0004).
 */
async function interruptTurn(ctx: BridgeHost, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (!body.ok) {
    send(res, 400, { status: "failed", message: body.message });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    send(res, 400, { status: "failed", message: "unparsable JSON body" });
    return;
  }
  const sessionId = (parsed as Record<string, unknown> | null)?.["sessionId"];
  if (typeof sessionId !== "string" || sessionId === "") {
    send(res, 400, { status: "failed", message: "expected { sessionId: string }" });
    return;
  }
  const agent = resolveAgent(ctx, sessionId);
  const cancel = (agent as { cancel?: (cause: unknown, options?: unknown) => void } | undefined)?.cancel;
  if (!agent || typeof cancel !== "function") {
    send(res, 200, { status: "no-agent" });
    return;
  }
  try {
    cancel.call(agent, { kind: "user" }, { keepInbox: true });
    send(res, 200, { status: "ok" });
  } catch (err) {
    warn("interrupt failed", err);
    send(res, 200, { status: "failed", message: err instanceof Error ? err.message : String(err) });
  }
}

async function dispatch(ctx: BridgeHost, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (req.method === "GET" && path === "/commands") {
    send(res, 200, { commands: listCommands(ctx) });
    return;
  }
  if (req.method === "POST" && path === "/execute") {
    await executeCommand(ctx, req, res);
    return;
  }
  if (req.method === "POST" && path === "/interrupt") {
    await interruptTurn(ctx, req, res);
    return;
  }
  if (req.method === "GET" && path === "/assistant-stream") {
    streamAssistant(ctx, res);
    return;
  }
  send(res, 404, { status: "not-found" });
}

/**
 * Mount the bridge. Fails soft: the child boots without it rather than dying,
 * because a throwing plugin takes the whole profile down.
 */
export function apply(ctx: BridgeHost, config: BridgePluginConfig | undefined): void {
  const socket = config?.socket;
  if (typeof socket !== "string" || socket === "") {
    warn("no socket configured; bridge disabled");
    return;
  }
  ctx.effect(() => {
    // Both halves of the bridge fail soft and independently: the socket serves
    // a WARM session's commands, the listener keeps a COLD session's command
    // prompt away from the model. Neither may take the child down.
    let offCommands: (() => void) | null = null;
    try {
      offCommands = interceptCommandPrompts(ctx);
    } catch (err) {
      warn("command-prompt interception unavailable", err);
    }
    // A socket file left by a crashed child would make listen fail EADDRINUSE.
    rmSync(socket, { force: true });
    const server = createServer((req, res) => {
      void dispatch(ctx, req, res).catch((err: unknown) => {
        warn("request failed", err);
        send(res, 500, { status: "failed", message: "bridge request failed" });
      });
    });
    server.on("error", (err: unknown) => warn(`listening on ${socket} failed`, err));
    server.on("listening", () => {
      if (process.platform === "win32") return;
      try {
        chmodSync(socket, 0o600);
      } catch (err) {
        warn(`could not restrict ${socket} to the owner`, err);
      }
    });
    server.listen(socket);
    return () => {
      try {
        server.close();
      } catch {
        // already closed
      }
      try {
        rmSync(socket, { force: true });
      } catch {
        // already gone
      }
      try {
        offCommands?.();
      } catch {
        // already gone
      }
    };
  }, "science-studio-command-bridge");
}
