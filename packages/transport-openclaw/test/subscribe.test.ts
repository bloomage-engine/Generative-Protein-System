import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenClawRuntimeAdapter } from "../src/index.js";
import type { BackendGateway, BackendGatewayOptions } from "../src/connection.js";
import type { EventFrame } from "@openclaw/gateway-client/browser";
import type { SessionState, StateDelta, TransportCommand, WatchSnapshot } from "@gps/transport";
import { sessionState } from "@gps/contract-tests";

const SESSION = "agent:main:main";

type ScriptedGateway = BackendGateway & { emit(frame: EventFrame): void };

/**
 * Scripted gateway: `chat.history` returns `[]` (the test drives the remote
 * reply through `emit`, not through history), `chat.send` resolves `run-1`.
 * The `emit` hook lets the test inject gateway frames exactly as the real
 * backend adapter's `init()` does.
 */
function scriptedGateway(
  history?: () => unknown[],
): (opts: BackendGatewayOptions) => BackendGateway {
  return (_opts) => {
    const readyListeners = new Set<() => void>();
    let eventCb: ((frame: EventFrame) => void) | null = null;
    const gw: ScriptedGateway = {
      connected: true,
      start: () => {
        for (const l of readyListeners) l();
      },
      stop: () => {},
      // The real `request` is generic over the payload the caller expects; a
      // scripted double cannot know that per method, so it casts its own reply.
      request: async <T,>(method: string): Promise<T> => {
        if (method === "chat.history")
          return { sessionKey: SESSION, messages: history ? history() : [] } as T;
        if (method === "chat.send") return { runId: "run-1", status: "started" } as T;
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

function collect(adapter: OpenClawRuntimeAdapter, commands: TransportCommand[]): Promise<StateDelta[]> {
  return (async () => {
    const out: StateDelta[] = [];
    for await (const d of adapter.run(freshSession(), commands)) out.push(d);
    return out;
  })();
}

const noopRecordStore = { addRun: async () => {} };

async function makeAdapter(
  history?: () => unknown[],
): Promise<{ adapter: OpenClawRuntimeAdapter; gw: ScriptedGateway }> {
  let captured: ScriptedGateway | undefined;
  const adapter = new OpenClawRuntimeAdapter({
    createGateway: (opts) => {
      captured = scriptedGateway(history)(opts) as ScriptedGateway;
      return captured;
    },
  });
  await adapter.init({ binding: { runtime: "openclaw", config: { url: "ws://fake", token: "token" } }, recordStore: noopRecordStore });
  return { adapter, gw: captured! };
}

/** A remote assistant reply that settles with NO local run in flight. */
function emitRemoteReply(gw: ScriptedGateway, runId: string, text: string): void {
  gw.emit({ event: "chat", payload: { sessionKey: SESSION, state: "delta", runId, deltaText: text } } as unknown as EventFrame);
  gw.emit({ event: "chat", payload: { sessionKey: SESSION, state: "final", runId } } as unknown as EventFrame);
}

test("subscribe pushes a remote assistant reply that settled without a local run", async () => {
  const { adapter, gw } = await makeAdapter();
  // Seed the transcript (an openclaw TUI/UI is talking here; our side is idle).
  await collect(adapter, []);

  const snapshots: WatchSnapshot[] = [];
  const unsub = adapter.subscribe(SESSION, (s) => snapshots.push(s));

  emitRemoteReply(gw, "run-remote", "Remote reply from the TUI");
  await new Promise((r) => setTimeout(r, 350));
  unsub();

  assert.equal(snapshots.length, 2, "baseline + one coalesced settle push");
  assert.deepEqual(snapshots[0], { status: "idle", messages: {} }, "baseline is the (empty) transcript at attach");
  const settle = snapshots[1]!;
  assert.equal(settle.status, "idle");
  assert.deepEqual(
    settle.messages["run-remote"],
    { id: "run-remote", role: "assistant", parts: [{ type: "text", text: "Remote reply from the TUI" }] },
    "the settled remote assistant reply must be in the pushed snapshot",
  );
});

test("remote user turns are pulled into the pushed snapshot via chat.history", async () => {
  // The remote side (TUI/UI) added a turn; it's in chat.history but NOT in any
  // chat/agent event payload. Our side is idle — no local run in flight — so the
  // watch push path is what should fetch the history and converge the transcript.
  const history: unknown[] = [
    { id: "hU", role: "user", content: "remote user question" },
    { id: "hA", role: "assistant", content: [{ type: "text", text: "remote assistant reply" }] },
  ];
  const { adapter, gw } = await makeAdapter(() => history);
  await collect(adapter, []); // openclaw-side baseline: seeds transcript from history

  const snapshots: WatchSnapshot[] = [];
  const unsub = adapter.subscribe(SESSION, (s) => snapshots.push(s));
  // Baseline (transcript already seeded by the probe above) — skip it.
  if (snapshots.length === 1) snapshots.length = 0;

  // A new remote turn: the history grew, and its assistant reply "settles" via
  // a `final` event matching that assistant row's id (so syncFromHistory keeps
  // the gateway ids — the canonical case for remote conversation).
  history.push(
    { id: "hU2", role: "user", content: "next question" },
    { id: "hA2", role: "assistant", content: [{ type: "text", text: "next reply" }] },
  );
  gw.emit({
    event: "chat",
    payload: { sessionKey: SESSION, state: "final", runId: "hA2" },
  } as unknown as EventFrame);
  await new Promise((r) => setTimeout(r, 350));
  unsub();

  const last = snapshots[snapshots.length - 1]!;
  assert.equal(snapshots.length, 1, "exactly one coalesced settle");
  assert.equal(Object.keys(last.messages).length, 4, "transcript must hold 2 remote turns");
  const ids = Object.keys(last.messages).sort();
  assert.deepEqual(ids, ["hA", "hA2", "hU", "hU2"], "gateway ids preserved after history sync");
  assert.equal(
    last.messages["hU"]!.parts.find((p) => p.type === "text")!.text,
    "remote user question",
    "the REMOTE user row must be present without a local run",
  );
});

test("unsubscribe detaches the sink — no further pushes", async () => {
  const { adapter, gw } = await makeAdapter();
  await collect(adapter, []);

  const snapshots: WatchSnapshot[] = [];
  const unsub = adapter.subscribe(SESSION, (s) => snapshots.push(s));
  unsub(); // detach immediately after the baseline push

  emitRemoteReply(gw, "run-remote2", "late reply");
  await new Promise((r) => setTimeout(r, 350));

  assert.equal(snapshots.length, 1, "only the baseline arrives after unsubscribe");
});

test("two sinks both receive the same settle (and each unsub independently)", async () => {
  const { adapter, gw } = await makeAdapter();
  await collect(adapter, []);

  const a: WatchSnapshot[] = [];
  const b: WatchSnapshot[] = [];
  const unsubA = adapter.subscribe(SESSION, (s) => a.push(s));
  const unbB = adapter.subscribe(SESSION, (s) => b.push(s));

  emitRemoteReply(gw, "run-remote3", "shared reply");
  await new Promise((r) => setTimeout(r, 350));

  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.deepEqual(a[1]!.messages["run-remote3"]!.parts, [{ type: "text", text: "shared reply" }]);
  assert.deepEqual(b[1]!.messages["run-remote3"]!.parts, [{ type: "text", text: "shared reply" }]);

  unsubA();
  emitRemoteReply(gw, "run-remote4", "after A unsubbed");
  await new Promise((r) => setTimeout(r, 350));

  assert.equal(b.length, 3, "B still receives after A unsubbed");
  assert.equal(a.length, 2, "A no longer receives after unsub");
  unbB();
});
