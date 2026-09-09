import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ArtifactInput, RecordStoreLike, SessionState, StateDelta } from "@science-studio/transport";
import type { Run } from "@science-studio/record";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";
import { TranscriptMirror } from "../src/mirror.js";

function ev(type: string, data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: Date.now(), data } as unknown as SessionEvent;
}

/** A scripted turn client: emits scripted events per prompt, then resolves. */
class FakeDshClient implements DshTurnClient {
  started = false;
  readonly prompts: string[] = [];
  constructor(private readonly script: (sessionId: string, text: string) => SessionEvent[]) {}
  async start(): Promise<void> {
    this.started = true;
  }
  async close(): Promise<void> {}
  async runTurn(
    sessionId: string,
    text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    this.prompts.push(text);
    for (const event of this.script(sessionId, text)) onEvent(event);
  }
}

class FakeRecordStore implements RecordStoreLike {
  readonly runs: Run[] = [];
  readonly artifacts: ArtifactInput[] = [];
  async addRun(run: Run): Promise<void> {
    this.runs.push(run);
  }
  async addArtifact(artifact: ArtifactInput): Promise<void> {
    this.artifacts.push(artifact);
  }
}

function completedReply(assistantId: string, text: string): SessionEvent[] {
  return [
    ev("turn/start", { turn: 1 }, 1),
    ev(
      "assistant/message",
      { turn: 1, step: 1, message: { id: assistantId, role: "assistant", content: [{ type: "text", text }], source: { kind: "model" } } },
      2,
    ),
    ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 3),
  ];
}

function session(): SessionState {
  return { sessionId: "sess-1", studyId: "study-1", agentId: "main", status: "idle", messages: [] };
}

async function collect(iter: AsyncIterable<StateDelta>): Promise<StateDelta[]> {
  const out: StateDelta[] = [];
  for await (const delta of iter) out.push(delta);
  return out;
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("run() streams user + assistant deltas, persists a Run, and writes the mirror", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-adapter-"));
  const store = new FakeRecordStore();
  const client = new FakeDshClient((_sid, _text) => completedReply("am1", "Hello from dsh."));
  const adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
  try {
    await adapter.init({ gateway: { url: "", token: "" }, recordStore: store, config: {} });
    const deltas = await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));

    assert.ok(client.started, "the runtime must start on first use");
    assert.deepEqual(client.prompts, ["hi"]);
    const types = deltas.map((d) => d.type);
    assert.ok(types.includes("reconcile"), "every run starts with a reconcile snapshot");
    const user = deltas.find((d) => d.type === "add-message" && d.message.id === "u1") as
      | { message: { id: string; role: string } }
      | undefined;
    assert.ok(user && user.message.role === "user", "the driving user row uses the CLIENT's id");
    const running = deltas.find((d) => d.type === "session-status" && d.status === "running");
    const idle = deltas.find((d) => d.type === "session-status" && d.status === "idle");
    assert.ok(running && idle, "the run must flip running then settle idle");

    // Settle is fully done once the mirror file lands (addRun precedes it in
    // settleRun), so waiting on the mirror also covers Run persistence.
    const mirror = new TranscriptMirror(dir);
    await waitFor(async () => (await mirror.load("sess-1")) !== null);
    assert.equal(store.runs.length, 1);
    const run = store.runs[0]!;
    assert.equal(run.status, "completed");
    assert.equal(run.input, "hi");
    assert.equal(run.output, "Hello from dsh.");
    assert.equal(run.id, "u1");

    const loaded = await mirror.load("sess-1");
    assert.ok(loaded && loaded.messages.length >= 2, "the mirror must persist the transcript");
  } finally {
    await adapter.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fresh adapter instance cold-starts from the mirror and reconciles history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-cold-"));
  const store = new FakeRecordStore();
  const adapter1 = new DshRuntimeAdapter({
    createClient: () => new FakeDshClient((_sid, _text) => completedReply("am1", "Hello from dsh.")),
    transcriptDir: dir,
  });
  try {
    await adapter1.init({ gateway: { url: "", token: "" }, recordStore: store, config: {} });
    await collect(adapter1.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));
    const mirror = new TranscriptMirror(dir);
    await waitFor(async () => (await mirror.load("sess-1")) !== null);
    assert.equal(store.runs.length, 1);

    // Simulate a service restart: brand-new adapter, same transcript dir, no
    // shared memory. A probe must reconcile the FULL prior history.
    const store2 = new FakeRecordStore();
    const adapter2 = new DshRuntimeAdapter({
      createClient: () => new FakeDshClient(() => []),
      transcriptDir: dir,
    });
    await adapter2.init({ gateway: { url: "", token: "" }, recordStore: store2, config: {} });
    const deltas = await collect(adapter2.run(session(), []));
    const reconcile = deltas.find((d) => d.type === "reconcile") as
      | { messages: { id: string; role: string }[] }
      | undefined;
    assert.ok(reconcile, "a probe yields a reconcile snapshot");
    assert.deepEqual(
      reconcile.messages.map((m) => m.id),
      ["u1", "am1"],
      "cold start must restore the full canonical transcript from the mirror",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a turn/end reason of error settles the session to error and persists an error Run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-error-"));
  const store = new FakeRecordStore();
  const client = new FakeDshClient((_sid, _text) => [
    ev("turn/start", { turn: 1 }, 1),
    ev("turn/end", { turn: 1, reason: { kind: "error", error: { message: "llm down", code: "UNKNOWN" } } }, 2),
  ]);
  const adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
  try {
    await adapter.init({ gateway: { url: "", token: "" }, recordStore: store, config: {} });
    const deltas = await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));
    const error = deltas.find((d) => d.type === "session-status" && d.status === "error");
    assert.ok(error, "the session must settle to error");
    const mirror = new TranscriptMirror(dir);
    await waitFor(async () => (await mirror.load("sess-1")) !== null);
    assert.equal(store.runs.length, 1);
    assert.equal(store.runs[0]!.status, "error", "failed turns are still recorded as Runs");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
