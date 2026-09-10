/**
 * End-to-end test of this example's wiring: the dsh adapter driven by a
 * SCRIPTED turn client (via the adapter's `createClient` test seam) behind
 * @science-studio/transport-service, speaking the assistant-transport SSE
 * wire protocol to a plain fetch client. No live dsh process needed.
 *
 * Prereq: `npm run build` at the repo root (the workspace deps are imported
 * from their dist builds, as in services/transport-service).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { DshRuntimeAdapter, TranscriptMirror } from "@science-studio/transport-dsh";
import type { DshTurnClient } from "@science-studio/transport-dsh";
import { createTransportService } from "@science-studio/transport-service";

const SESSION = "sess-1";

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: Date.now(), data } as unknown as SessionEvent;
}

/** Scripted client: a two-step turn with a tool call, then a completed end. */
class ScriptedDshClient implements DshTurnClient {
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async runTurn(
    _sessionId: string,
    _text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    onEvent(ev("turn/start", { turn: 1 }, 1));
    onEvent(
      ev(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            id: "am1",
            role: "assistant",
            content: [
              { type: "text", text: "Let me look it up." },
              { type: "tool-call", id: "tc1", name: "fs.read", arguments: '{"path":"x"}' },
            ],
            source: { kind: "model" },
          },
        },
        2,
      ),
    );
    onEvent(
      ev(
        "tool/result",
        {
          turn: 1,
          step: 1,
          message: {
            id: "tr1",
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc1",
                content: [{ type: "text", text: "42" }],
              },
            ],
            source: { kind: "tool", callId: "tc1" },
          },
        },
        3,
      ),
    );
    onEvent(
      ev(
        "assistant/message",
        {
          turn: 1,
          step: 2,
          message: {
            id: "am2",
            role: "assistant",
            content: [{ type: "text", text: "The answer is 42." }],
            source: { kind: "model" },
          },
        },
        4,
      ),
    );
    onEvent(ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 5));
  }
}

interface WireOp {
  type: "set" | "append-text";
  path: string[];
  value: unknown;
}

function parseSse(body: string): { ops: WireOp[]; done: boolean } {
  const ops: WireOp[] = [];
  let done = false;
  for (const frame of body.split("\n\n")) {
    if (!frame.startsWith("data: ")) continue;
    const data = frame.slice("data: ".length).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    const parsed = JSON.parse(data) as { type: string; operations: WireOp[] };
    if (parsed.type === "update-state") ops.push(...parsed.operations);
  }
  return { ops, done };
}

async function bootExample(dir: string): Promise<{ base: string; close: () => Promise<void> }> {
  const adapter = new DshRuntimeAdapter({
    createClient: () => new ScriptedDshClient(),
    transcriptDir: dir,
  });
  const app = await createTransportService({ adapters: [adapter] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object", "server must be listening on a TCP port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      app.server.closeAllConnections?.();
      await app.close();
    },
  };
}

async function post(base: string, body: unknown): Promise<{ ops: WireOp[]; done: boolean }> {
  const res = await fetch(`${base}/api/transport`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return parseSse(await res.text());
}

/** settleRun persists the mirror after the run stream ends — wait for it before cleanup. */
async function waitForMirror(dir: string): Promise<void> {
  const mirror = new TranscriptMirror(dir);
  const start = Date.now();
  for (;;) {
    if ((await mirror.load(SESSION)) !== null) return;
    if (Date.now() - start > 2_000) throw new Error("mirror never settled");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("run (add-message) streams the scripted dsh turn as set ops and terminates with [DONE]", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-example-"));
  const { base, close } = await bootExample(dir);
  try {
    const { ops, done } = await post(base, {
      commands: [
        {
          type: "add-message",
          message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
        },
      ],
      state: { status: "idle", messages: {} },
      threadId: SESSION,
    });
    assert.equal(done, true, "the run stream must terminate with [DONE]");

    const userSet = ops.find(
      (op) => op.type === "set" && op.path.length === 2 && op.path[0] === "messages" && op.path[1] === "u1",
    );
    assert.ok(userSet, "the driving user message must arrive as a set at messages/u1");

    const running = ops.find(
      (op) => op.type === "set" && op.path.length === 1 && op.path[0] === "status" && op.value === "running",
    );
    const idle = ops.find(
      (op) => op.type === "set" && op.path.length === 1 && op.path[0] === "status" && op.value === "idle",
    );
    assert.ok(running && idle, "the session must flip running then settle idle");
    assert.ok(
      running && idle && ops.indexOf(running) < ops.indexOf(idle),
      "running must precede the final idle",
    );

    const am1 = ops.find(
      (op) => op.type === "set" && op.path.length === 2 && op.path[0] === "messages" && op.path[1] === "am1",
    );
    assert.ok(am1, "the first assistant step must arrive as a whole-message set at messages/am1");
    assert.ok(
      ops.find(
        (op) =>
          op.type === "set" &&
          op.path.length === 3 &&
          op.path[0] === "messages" &&
          op.path[1] === "am1" &&
          op.path[2] === "parts",
      ),
      "the tool result must coalesce into the assistant's parts via a parts set",
    );
    const parts = ops.filter(
      (op) => op.type === "set" && op.path[0] === "messages" && op.path[1] === "am1" && op.path[2] === "parts",
    );
    const finalParts = parts[parts.length - 1]!.value as { type: string; id: string; result?: string }[];
    const toolPart = finalParts.find((p) => p.type === "tool-call" && p.id === "tc1");
    assert.ok(toolPart, "the tool-call part must exist inside the assistant message");
    assert.equal(toolPart!.result, "42", "start + result coalesce into one tool-call part");

    const am2 = ops.find(
      (op) => op.type === "set" && op.path.length === 2 && op.path[0] === "messages" && op.path[1] === "am2",
    );
    assert.ok(am2, "the second assistant step must arrive as its own message set");
    assert.ok(
      ops.every((op) => op.type === "set" || op.type === "append-text"),
      "only client-safe op types may appear on the wire",
    );
    await waitForMirror(dir);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a drifted probe re-converges to the full canonical transcript and terminates with [DONE]", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-example-probe-"));
  const { base, close } = await bootExample(dir);
  try {
    await post(base, {
      commands: [
        {
          type: "add-message",
          message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
        },
      ],
      state: { status: "idle", messages: {} },
      threadId: SESSION,
    });
    await waitForMirror(dir);

    // A fresh client (empty claimed state) probes: the service must reconcile
    // it to the adapter's canonical transcript.
    const { ops, done } = await post(base, {
      commands: [],
      state: { status: "idle", messages: {} },
      threadId: SESSION,
    });
    assert.equal(done, true, "the probe stream must terminate with [DONE]");

    const snapshot = ops.find(
      (op) => op.type === "set" && op.path.length === 1 && op.path[0] === "messages",
    );
    assert.ok(snapshot, "a drifted client must receive a whole-message-map set");
    const messages = snapshot!.value as Record<string, { role: string }>;
    assert.ok(messages["u1"], "the echoed user row must be in the snapshot");
    assert.ok(messages["am1"] && messages["am2"], "both assistant steps must be in the snapshot");
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});
