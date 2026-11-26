import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenClawRuntimeAdapter } from "../src/index.js";
import type { BackendGateway, BackendGatewayOptions } from "../src/connection.js";
import type { EventFrame } from "@openclaw/gateway-client/browser";
import type { Run } from "@gps/record";
import type { RecordStoreLike, SessionState, StateDelta, TransportCommand, WatchSnapshot } from "@gps/transport";
import { sessionState } from "@gps/contract-tests";
import type { GatewayCommandEntry } from "../src/commands.js";

const SESSION = "agent:main:main";

type ScriptedGateway = BackendGateway & {
  emit(frame: EventFrame): void;
  sentMessages: string[];
  commandListCalls: number;
};

/**
 * Scripted gateway for slash-command behavior: `chat.history` returns the
 * placed rows, `chat.send` records the exact message text and resolves
 * `run-1`, `commands.list` returns whatever entries the test placed. Events
 * are injected through `emit` like the real backend `init()` does.
 */
function scriptedGateway(opts: {
  history?: () => unknown[];
  commandEntries?: () => GatewayCommandEntry[];
}): (gatewayOpts: BackendGatewayOptions) => BackendGateway {
  return (_gatewayOpts) => {
    const readyListeners = new Set<() => void>();
    let eventCb: ((frame: EventFrame) => void) | null = null;
    const gw: ScriptedGateway = {
      connected: true,
      sentMessages: [],
      commandListCalls: 0,
      start: () => {
        for (const l of readyListeners) l();
      },
      stop: () => {},
      request: async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === "chat.history")
          return { sessionKey: SESSION, messages: opts.history ? opts.history() : [] } as T;
        if (method === "chat.send") {
          const p = (params ?? {}) as { message?: unknown };
          gw.sentMessages.push(typeof p.message === "string" ? p.message : "");
          return { runId: "run-1", status: "started" } as T;
        }
        if (method === "commands.list") {
          gw.commandListCalls += 1;
          return { commands: opts.commandEntries ? opts.commandEntries() : [] } as T;
        }
        throw new Error(`unexpected request: ${method}`);
      },
      onEvent: (cb) => {
        eventCb = cb;
        return () => {
          eventCb = null;
        };
      },
      onReady: (l) => {
        readyListeners.add(l);
        return () => readyListeners.delete(l);
      },
      emit: (frame) => eventCb?.(frame),
    };
    return gw;
  };
}

function freshSession(): SessionState {
  return sessionState({ sessionId: SESSION });
}

/** Poll until `cond` holds (remote persistence runs after the history sync). */
async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function collect(adapter: OpenClawRuntimeAdapter, commands: TransportCommand[]): Promise<StateDelta[]> {
  return (async () => {
    const out: StateDelta[] = [];
    for await (const d of adapter.run(freshSession(), commands)) out.push(d);
    return out;
  })();
}

function recordingStore(): { store: RecordStoreLike; runs: Run[] } {
  const runs: Run[] = [];
  return {
    runs,
    store: {
      addRun: async (run: Run) => {
        runs.push(run);
      },
    },
  };
}

async function makeAdapter(opts: {
  history?: () => unknown[];
  commandEntries?: () => GatewayCommandEntry[];
}): Promise<{ adapter: OpenClawRuntimeAdapter; gw: ScriptedGateway; runs: Run[] }> {
  const record = recordingStore();
  let captured: ScriptedGateway | undefined;
  const adapter = new OpenClawRuntimeAdapter({
    createGateway: (gatewayOpts) => {
      captured = scriptedGateway(opts)(gatewayOpts) as ScriptedGateway;
      return captured;
    },
  });
  await adapter.init({
    binding: { runtime: "openclaw", config: { url: "ws://fake", token: "token" } },
    recordStore: record.store,
  });
  return { adapter, gw: captured!, runs: record.runs };
}

/** Stream a gateway delta+final exchange for the given run, then settle. */
function emitExchange(gw: ScriptedGateway, text: string): void {
  gw.emit({
    event: "chat",
    payload: { sessionKey: SESSION, state: "delta", runId: "run-1", deltaText: text },
  } as unknown as EventFrame);
  gw.emit({
    event: "chat",
    payload: { sessionKey: SESSION, state: "final", runId: "run-1" },
  } as unknown as EventFrame);
}

async function runToCompletion(
  adapter: OpenClawRuntimeAdapter,
  gw: ScriptedGateway,
  content: string,
): Promise<StateDelta[]> {
  const deltas = collect(adapter, [{ type: "add-message", message: { id: "u1", role: "user", content } }]);
  // Let run() attach the flow and resolve `chat.send` before feeding events.
  await new Promise((r) => setTimeout(r, 10));
  emitExchange(gw, "ok");
  return deltas;
}

test("a command message is sent verbatim, echoed as a user row, and never persisted as a Run", async () => {
  const { adapter, gw, runs } = await makeAdapter({});
  const deltas = await runToCompletion(adapter, gw, "/status");

  assert.deepEqual(gw.sentMessages, ["/status"], "the raw command text reaches chat.send");
  const userEcho = deltas.find(
    (d) => d.type === "add-message" && (d as Extract<StateDelta, { type: "add-message" }>).message.role === "user",
  );
  const echoText = userEcho
    ? (userEcho as Extract<StateDelta, { type: "add-message" }>).message.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("")
    : "";
  assert.equal(echoText, "/status", "the command row is echoed into the transcript like any user message");
  assert.equal(runs.length, 0, "no Run is persisted for a command message");
});

test("a research message still persists a Run with the message as input", async () => {
  const { adapter, gw, runs } = await makeAdapter({});
  await runToCompletion(adapter, gw, "hi");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.input, "hi");
});

test("a locally-run command's reply (written to history only after the settle) reaches watchers", async () => {
  // Real gateway behavior behind the "slash command reply only shows after a
  // refresh" bug: a native command settles with a terminal frame that carries
  // NO streamed content, and its user + reply rows are written to
  // chat.history only ~tens of ms AFTER that frame. The run's own stream can
  // never show the reply — only the post-settle history convergence can.
  let gatewayRows: unknown[] = [];
  const { adapter, gw } = await makeAdapter({ history: () => gatewayRows });

  const snapshots: WatchSnapshot[] = [];
  const unsub = adapter.subscribe(SESSION, (s) => snapshots.push(s));

  const deltas = collect(adapter, [
    { type: "add-message", message: { id: "u1", role: "user", content: "/status" } },
  ]);
  // Let run() attach the flow and resolve `chat.send` before the settle.
  await new Promise((r) => setTimeout(r, 10));
  // Terminal settle exactly like the real gateway: a `final` frame, no deltas,
  // no message payload.
  gw.emit({ event: "chat", payload: { sessionKey: SESSION, state: "final", runId: "run-1" } } as unknown as EventFrame);
  const streamed = await deltas;

  assert.equal(
    streamed.filter((d) => d.type === "add-message").length,
    1,
    "the run's own stream only echoes the user row (the reply never streams)",
  );
  assert.equal(
    streamed.some((d) => d.type === "add-message" && (d as { message?: { role?: string } }).message?.role === "assistant"),
    false,
    "no assistant message is streamed during the run",
  );

  // The gateway persists the turn to history ~60ms after the terminal frame.
  setTimeout(() => {
    gatewayRows = [
      { id: "hU", role: "user", content: "/status" },
      { id: "hA", role: "assistant", content: [{ type: "text", text: "model set to gpt-5" }] },
    ];
  }, 60);

  // The post-settle convergence must pick the reply up and push it to watchers
  // (the browser adopts it via importExternalState — no refresh needed).
  await until(
    () => snapshots.some((s) => Object.values(s.messages).some((m) => m.role === "assistant" && m.parts.some((p) => p.type === "text" && (p as { text: string }).text === "model set to gpt-5"))),
    2000,
  );
  unsub();
});

test("a remote command settle preceded by a synced '/'-user row is not persisted", async () => {
  // A command turn that arrived remotely lives in chat.history (user + reply).
  const history: unknown[] = [
    { id: "hU", role: "user", content: "/model gpt-5 -s" },
    { id: "hA", role: "assistant", content: [{ type: "text", text: "model set" }] },
  ];
  const { adapter, gw, runs } = await makeAdapter({ history: () => history });
  await collect(adapter, []); // seed the transcript from history

  // The gateway settles that remote assistant run (final event for hA).
  gw.emit({ event: "chat", payload: { sessionKey: SESSION, state: "final", runId: "hA" } } as unknown as EventFrame);
  // Persistence happens after the history sync — give the chain time to run,
  // then assert the command turn never became a Run.
  await sleep(150);

  assert.equal(runs.length, 0, "a remote command run must not become a research Run");
});

test("a remote research settle preceded by its user row is persisted", async () => {
  const history: unknown[] = [
    { id: "hU", role: "user", content: "remote research question" },
    { id: "hA", role: "assistant", content: [{ type: "text", text: "remote reply" }] },
  ];
  const { adapter, gw, runs } = await makeAdapter({ history: () => history });
  await collect(adapter, []);

  gw.emit({ event: "chat", payload: { sessionKey: SESSION, state: "final", runId: "hA" } } as unknown as EventFrame);
  await until(() => runs.length === 1);

  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.input, "remote research question");
});

function commandEntriesFixture(): GatewayCommandEntry[] {
  const e = (name: string, over: Partial<GatewayCommandEntry> = {}): GatewayCommandEntry => ({
    name,
    description: `description for /${name}`,
    source: "native",
    scope: "both",
    acceptsArgs: false,
    ...over,
  });
  return [
    e("status", { category: "status" }),
    e("help", { category: "status" }),
    e("model", { category: "options", acceptsArgs: true, args: [{ name: "name", description: "model", type: "string" }] }),
    e("think", {
      category: "options",
      acceptsArgs: true,
      args: [{ name: "level", description: "level", type: "string", required: true }],
    }),
    e("new", { category: "session" }),
    e("debug", { category: "management" }),
    e("weather", { source: "skill", category: "tools" }),
  ];
}

test("listCommands curates the gateway catalog and caches it", async () => {
  const { adapter, gw } = await makeAdapter({ commandEntries: commandEntriesFixture });

  const first = await adapter.listCommands();
  const second = await adapter.listCommands();

  assert.deepEqual(
    first.map((d) => d.id).sort(),
    ["help", "model", "status"],
    "only allowlisted native no-arg text commands survive curation",
  );
  assert.equal(first.find((d) => d.id === "status")!.invocationText, "/status");
  assert.equal(second, first, "a second call within the TTL is served from the cache");
  assert.equal(gw.commandListCalls, 1, "the catalog is fetched from the gateway exactly once");
});

test("listCommands degrades to an empty catalog when the gateway request fails", async () => {
  const record = recordingStore();
  const adapter = new OpenClawRuntimeAdapter({
    createGateway: () => {
      const readyListeners = new Set<() => void>();
      const gw: BackendGateway = {
        connected: true,
        start: () => {
          for (const l of readyListeners) l();
        },
        stop: () => {},
        request: async (method: string) => {
          if (method === "commands.list") throw new Error("gateway unreachable");
          throw new Error(`unexpected request: ${method}`);
        },
        onEvent: () => () => {},
        onReady: (l) => {
          readyListeners.add(l);
          return () => readyListeners.delete(l);
        },
      };
      return gw;
    },
  });
  await adapter.init({ binding: { runtime: "openclaw", config: { url: "ws://fake", token: "token" } }, recordStore: record.store });
  assert.deepEqual(await adapter.listCommands(), []);
});
