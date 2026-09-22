/**
 * The ADAPTER-side half of the dsh command bridge: how this process reaches the
 * child-side plugin (`bridge-plugin.ts`) that exposes the harness's own command
 * registry over a private UNIX socket.
 *
 * The socket is not a second public transport: it is one process-private file
 * (owner-only mode, unique per adapter init) that exists exactly as long as
 * this child generation does, and it carries a fixed two-verb JSON contract —
 * `GET /commands` and `POST /execute` — whose shapes live in the plugin. This
 * module owns the client and the two launch artifacts (`--patch` file, socket
 * path) that must agree with it byte-for-byte.
 */
import { request, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessBridgeOutcome } from "./commands.js";
import type { DshAssistantStreamMessage } from "./assistant-stream.js";

/** Connect + list bound. Listing is a read-only registry read. */
const LIST_TIMEOUT_MS = 10_000;
/**
 * Execute bound: a harness command can do real work (a `/compact` runs a model
 * turn of its own), and the run stream stays open until it settles, so the bound
 * is generous rather than tight.
 */
const EXECUTE_TIMEOUT_MS = 300_000;

/** Abort bound: cancelling a turn should answer immediately. */
const INTERRUPT_TIMEOUT_MS = 10_000;

/** One harness command as the bridge reports it (the registry's own descriptor). */
export interface HarnessCommandEntry {
  name: string;
  description: string;
  input?: { hint: string };
}

/** How the bridge answered one `/interrupt` call. */
export type HarnessInterruptOutcome = "ok" | "no-agent" | "unavailable";

/** The command bridge this adapter's child exposes. */
export interface DshCommandBridge {
  /** The harness's own command catalog (empty when no agent is live). */
  list(): Promise<HarnessCommandEntry[]>;
  /** Execute one trimmed command line on the child's agent for `sessionId`. */
  execute(sessionId: string, line: string): Promise<HarnessBridgeOutcome>;
  /**
   * Cancel the child's active turn for `sessionId` — the harness's own
   * mid-turn cancel, which the SDK wire does not expose. `no-agent` means the
   * session has no live agent, so there is nothing to cancel (docs/adr/0004).
   */
  interrupt(sessionId: string): Promise<HarnessInterruptOutcome>;
  /**
   * Open the child's live assistant-frame stream (`GET /assistant-stream`) and
   * invoke `listener` for each forwarded frame. Returns a close handle. The
   * connection is re-established if the child restarts mid-watch; a missing or
   * failing bridge simply never calls the listener (best-effort — docs/adr/0022).
   */
  subscribeAssistantStream?(listener: (message: DshAssistantStreamMessage) => void): () => void;
}

function isEntry(value: unknown): value is HarnessCommandEntry {
  const entry = value as { name?: unknown; description?: unknown; input?: { hint?: unknown } } | null;
  if (entry === null || typeof entry !== "object") return false;
  if (typeof entry.name !== "string" || entry.name === "") return false;
  if (typeof entry.description !== "string") return false;
  return entry.input === undefined || typeof entry.input?.hint === "string";
}

/** One request/response over the socket. Rejects on a timeout, a transport error or a non-200. */
async function callJson(
  endpoint: string,
  method: "GET" | "POST",
  path: string,
  payload: string | null,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  deadline.unref?.();
  const req = request({
    socketPath: endpoint,
    path,
    method,
    signal: controller.signal,
    ...(payload === null
      ? {}
      : { headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }),
  });
  try {
    const response = once(req, "response") as Promise<[IncomingMessage]>;
    if (payload !== null) req.write(payload);
    req.end();
    const [res] = await response;
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    await once(res, "end");
    if (res.statusCode !== 200) {
      throw new Error(`${method} ${path} answered ${res.statusCode}`);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") throw new Error(`${method} ${path} answered a non-object`);
    return parsed as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`dsh command bridge ${method} ${path} failed over ${endpoint}: ${detail}`);
  } finally {
    clearTimeout(deadline);
  }
}

/** Reconnect delay when the streaming watch loses the child. */
const STREAM_RETRY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * One connection to `GET /assistant-stream`, resolving when the child closes
 * or the response errors. Lines are NDJSON; a malformed line is skipped.
 */
async function pumpAssistantStream(
  endpoint: string,
  listener: (message: DshAssistantStreamMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: endpoint, path: "/assistant-stream", method: "GET", signal });
    req.on("error", reject);
    req.on("response", (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET /assistant-stream answered ${res.statusCode}`));
        return;
      }
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line === "") continue;
          try {
            const parsed = JSON.parse(line) as DshAssistantStreamMessage;
            if (typeof parsed?.sessionId === "string" && parsed.frame !== undefined) {
              try {
                listener(parsed);
              } catch (err) {
                // Best-effort: a listener throw must not become an uncaught
                // exception on the event loop (symmetric with the plugin's
                // guarded `res.write`).
                console.warn("[dsh] assistant-stream listener failed", err);
              }
            }
          } catch {
            // a malformed line is not fatal to the watch
          }
        }
      });
      res.on("end", () => resolve());
      res.on("error", reject);
    });
    req.end();
  });
}

/** The command bridge at one socket endpoint. */
export function createCommandBridge(endpoint: string): DshCommandBridge {
  return {
    async list(): Promise<HarnessCommandEntry[]> {
      const body = await callJson(endpoint, "GET", "/commands", null, LIST_TIMEOUT_MS);
      const commands = body["commands"];
      if (!Array.isArray(commands)) return [];
      return commands.filter(isEntry).map((entry) => ({
        name: entry.name,
        description: entry.description,
        ...(entry.input === undefined ? {} : { input: { hint: entry.input.hint } }),
      }));
    },

    async execute(sessionId: string, line: string): Promise<HarnessBridgeOutcome> {
      let body: Record<string, unknown>;
      try {
        body = await callJson(endpoint, "POST", "/execute", JSON.stringify({ sessionId, line }), EXECUTE_TIMEOUT_MS);
      } catch (err) {
        return { status: "unavailable", message: err instanceof Error ? err.message : String(err) };
      }
      switch (body["status"]) {
        case "ok": {
          const kind = body["kind"] === "error" ? "error" : "success";
          const text = typeof body["text"] === "string" ? body["text"] : undefined;
          return text === undefined ? { status: "ok", kind } : { status: "ok", kind, text };
        }
        case "unknown":
          return { status: "unknown" };
        case "no-agent":
          return { status: "no-agent" };
        default: {
          const message = typeof body["message"] === "string" ? body["message"] : "unrecognized bridge answer";
          return { status: "unavailable", message };
        }
      }
    },

    async interrupt(sessionId: string): Promise<HarnessInterruptOutcome> {
      let body: Record<string, unknown>;
      try {
        body = await callJson(endpoint, "POST", "/interrupt", JSON.stringify({ sessionId }), INTERRUPT_TIMEOUT_MS);
      } catch {
        return "unavailable";
      }
      switch (body["status"]) {
        case "ok":
          return "ok";
        case "no-agent":
          return "no-agent";
        default:
          return "unavailable";
      }
    },

    subscribeAssistantStream(listener: (message: DshAssistantStreamMessage) => void): () => void {
      const controller = new AbortController();
      let closed = false;
      const watch = async (): Promise<void> => {
        while (!closed) {
          try {
            await pumpAssistantStream(endpoint, listener, controller.signal);
          } catch {
            // the child is gone or restarting: retry while this watch is wanted
          }
          if (closed) return;
          await sleep(STREAM_RETRY_MS);
        }
      };
      void watch();
      return () => {
        closed = true;
        controller.abort();
      };
    },
  };
}

/**
 * The socket path this adapter's child will listen on. Unique per adapter init:
 * two Projects (or two service processes) must never share one bridge socket,
 * and a stale file from a crashed child must never be mistaken for a live one.
 *
 * The unique part is deliberately SHORT. A POSIX socket path is bounded by
 * `sun_path` (104 bytes on macOS/BSD, 108 on Linux) including the NUL, and the
 * default directory sits under `tmpdir()`, which on macOS is already ~47 bytes
 * (`/var/folders/…/T/`): the full `pid-randomUUID.sock` form overflows it and
 * `listen()` then fails with ENAMETOOLONG — a silently bridge-less runtime.
 */
export function bridgeSocketPath(dir: string): string {
  const unique = `${process.pid}-${randomUUID().slice(0, 8)}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\ss-dsh-bridge-${unique}`
    : join(dir, `${unique}.sock`);
}

/**
 * Write the launch patch that inserts the bridge plugin into the child's
 * profile, and return its path (for `--patch`). Both value nodes go through
 * `JSON.stringify`: a JSON string is a valid YAML scalar, so this needs no YAML
 * dependency, and the entry name is a `file:` URL — a form `dsh-app-boot`
 * documents as supported, so nothing resolves against the profile directory.
 */
export async function writeBridgePatch(opts: { dir: string; pluginPath: string; socket: string }): Promise<string> {
  const { dir, pluginPath, socket } = opts;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${basename(socket)}.cordis.patch.yml`);
  const document = [
    "- insert:",
    "    - id: science-studio-command-bridge",
    `      name: ${JSON.stringify(pathToFileURL(pluginPath).href)}`,
    "      config:",
    `        socket: ${JSON.stringify(socket)}`,
    "",
  ].join("\n");
  await writeFile(file, document, "utf8");
  return file;
}

/** The config the child-side project plugin (`project-plugin.ts`) reads. */
export interface ProjectPluginLaunchConfig {
  project: { id: string; name: string; createdAt: string };
  /** The Project Workspace root (the child's cwd) the scaffold and Brief live in. */
  root: string;
  /** Override the layout; the default lives in the plugin. */
  directories?: readonly string[];
}

/**
 * Write the launch patch that inserts the PROJECT plugin into the child's
 * profile, and return its path (for `--patch`). The config is emitted as one
 * JSON object — JSON is valid YAML flow syntax — so the nested Project identity
 * needs no YAML dependency, and a random suffix keeps two adapters (or two
 * Projects) from overwriting each other's patch in the shared bridge directory.
 */
export async function writeProjectPatch(opts: {
  dir: string;
  pluginPath: string;
  config: ProjectPluginLaunchConfig;
}): Promise<string> {
  const { dir, pluginPath, config } = opts;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `project-${randomUUID().slice(0, 8)}.cordis.patch.yml`);
  const document = [
    "- insert:",
    "    - id: science-studio-project",
    `      name: ${JSON.stringify(pathToFileURL(pluginPath).href)}`,
    `      config: ${JSON.stringify(config)}`,
    "",
  ].join("\n");
  await writeFile(file, document, "utf8");
  return file;
}

/** The config the child-side cron plugin (`cron-plugin.ts`) reads. */
export interface CronPluginLaunchConfig {
  project: { id: string; name: string; createdAt: string };
  /** The Project Workspace root (the child's cwd) the task files live in. */
  root: string;
}

/**
 * Write the launch patch that inserts the CRON plugin into the child's profile,
 * and return its path (for `--patch`). Same shape as the bridge/project patches:
 * a `file:` URL name and one JSON config node, so no YAML dependency is needed.
 */
export async function writeCronPatch(opts: {
  dir: string;
  pluginPath: string;
  config: CronPluginLaunchConfig;
}): Promise<string> {
  const { dir, pluginPath, config } = opts;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `cron-${randomUUID().slice(0, 8)}.cordis.patch.yml`);
  const document = [
    "- insert:",
    "    - id: science-studio-cron",
    `      name: ${JSON.stringify(pathToFileURL(pluginPath).href)}`,
    `      config: ${JSON.stringify(config)}`,
    "",
  ].join("\n");
  await writeFile(file, document, "utf8");
  return file;
}

/**
 * Write the launch patch that inserts the SUBAGENT-REPORTING plugin into the
 * child's profile, and return its path (for `--patch`). No business config —
 * the plugin registers a static section (see `subagent-plugin.ts`), but a
 * `config: {}` node is kept so the patch shape matches the bridge/project/cron
 * siblings the harness already loads. Same shape as them: a `file:` URL name
 * and a distinct filename (`subagent-reporting-<8hex>`).
 */
export async function writeSubagentPatch(opts: { dir: string; pluginPath: string }): Promise<string> {
  const { dir, pluginPath } = opts;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `subagent-reporting-${randomUUID().slice(0, 8)}.cordis.patch.yml`);
  const document = [
    "- insert:",
    "    - id: science-studio-subagent-reporting",
    `      name: ${JSON.stringify(pathToFileURL(pluginPath).href)}`,
    "      config: {}",
    "",
  ].join("\n");
  await writeFile(file, document, "utf8");
  return file;
}
