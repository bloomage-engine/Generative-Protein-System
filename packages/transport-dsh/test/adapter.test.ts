import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { RecordStoreLike, SessionState, StateDelta } from "@science-studio/transport";
import { sessionState } from "@science-studio/contract-tests";
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
  readonly sessionIds: string[] = [];
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
    this.sessionIds.push(sessionId);
    for (const event of this.script(sessionId, text)) onEvent(event);
  }
}

/**
 * A harness home SHARED by every client generation: the SDK runtime materializes
 * each prompted session id into it, and a later child can never create an id it
 * already holds (`session "<id>" already exists` — the pinned SDK has no resume
 * path). Reusing an id across generations is therefore a rejected prompt, not a
 * resumed conversation.
 */
class HarnessHome {
  readonly materialized = new Set<string>();
}

/** One harness child generation over a durable home. */
class HomeBackedClient implements DshTurnClient {
  readonly sessionIds: string[] = [];
  /** Ids THIS child created: resumable in-process, though never by a later child. */
  private readonly live = new Set<string>();
  constructor(private readonly home: HarnessHome) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async runTurn(
    sessionId: string,
    _text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    this.sessionIds.push(sessionId);
    if (!this.live.has(sessionId)) {
      if (this.home.materialized.has(sessionId)) throw new Error(`session "${sessionId}" already exists`);
      this.home.materialized.add(sessionId);
      this.live.add(sessionId);
    }
    const assistantId = `am-${sessionId}-${this.sessionIds.length}`;
    for (const event of completedReply(assistantId, "Hello from dsh.")) onEvent(event);
  }
}

/**
 * A home that already holds the exact id this generation asks for (another
 * process minted the same one): the create fails BEFORE any agent work, so the
 * adapter must retry once on a fresh id rather than settle the run to error.
 */
class CollidingHomeClient implements DshTurnClient {
  readonly sessionIds: string[] = [];
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async runTurn(
    sessionId: string,
    _text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    this.sessionIds.push(sessionId);
    if (this.sessionIds.length === 1) throw new Error(`session "${sessionId}" already exists`);
    for (const event of completedReply(`am-${sessionId}`, "Hello from dsh.")) onEvent(event);
  }
}

class FakeRecordStore implements RecordStoreLike {
  readonly runs: Run[] = [];
  async addRun(run: Run): Promise<void> {
    this.runs.push(run);
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
  return sessionState({ sessionId: "sess-1" });
}

async function collect(iter: AsyncIterable<StateDelta>): Promise<StateDelta[]> {
  const out: StateDelta[] = [];
  for await (const delta of iter) out.push(delta);
  return out;
}

test("run() streams user + assistant deltas, persists a Run, and writes the mirror", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-adapter-"));
  const store = new FakeRecordStore();
  const client = new FakeDshClient((_sid, _text) => completedReply("am1", "Hello from dsh."));
  const adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
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

    // The run persists BEFORE its stream ends (settle is awaited post-drain),
    // so the Run and the mirror are already final when collect() returns.
    const mirror = new TranscriptMirror(dir);
    const loaded = await mirror.load("sess-1");
    assert.ok(loaded, "the mirror must be written before the run stream settles");
    assert.equal(store.runs.length, 1);
    const run = store.runs[0]!;
    assert.equal(run.status, "completed");
    assert.equal(run.input, "hi");
    assert.equal(run.output, "Hello from dsh.");
    assert.equal(run.id, "u1");

    assert.ok(loaded && loaded.messages.length >= 2, "the mirror must persist the transcript");
  } finally {
    await adapter.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a request that beats the background init waits for it instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-init-race-"));
  const store = new FakeRecordStore();
  const client = new FakeDshClient(() => completedReply("am1", "Hello from dsh."));
  const adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
  try {
    // The composition answers the request that first names a Project at once and
    // starts `init` in the background (docs/adr/0008), so the run, the catalog
    // read and a watch attach can all beat it. Every one of them must WAIT for
    // it — the dsh init has a real await before the behavior exists.
    const initializing = adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    const pushed: unknown[] = [];
    const unsubscribe = adapter.subscribe("sess-1", (snapshot) => pushed.push(snapshot));

    const catalog = await adapter.listCommands();
    const deltas = await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));
    await initializing;

    assert.deepEqual(
      catalog.map((descriptor) => descriptor.id),
      ["status", "new", "compact", "feedback", "goal", "permission", "plan"],
      "the menu answers during init, with the curated harness layer",
    );
    assert.ok(
      deltas.some((delta) => delta.type === "session-status" && delta.status === "idle"),
      "and the first request completes instead of failing",
    );
    assert.deepEqual(client.prompts, ["hi"]);
    assert.equal(store.runs.length, 1);
    assert.ok(pushed.length > 0, "the watch bound before init returned still sees the settled run");
    assert.equal(typeof unsubscribe, "function");
    unsubscribe();
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
    await adapter1.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    await collect(adapter1.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));
    const mirror = new TranscriptMirror(dir);
    assert.ok(await mirror.load("sess-1"), "the first run persists the mirror before it returns");
    assert.equal(store.runs.length, 1);

    // Simulate a service restart: brand-new adapter, same transcript dir, no
    // shared memory. A probe must reconcile the FULL prior history.
    const store2 = new FakeRecordStore();
    const adapter2 = new DshRuntimeAdapter({
      createClient: () => new FakeDshClient(() => []),
      transcriptDir: dir,
    });
    await adapter2.init({ binding: { runtime: "dsh", config: {} }, recordStore: store2 });
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

test("harness session ids are generation-scoped, so a restart never prompts an id the home holds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-generation-"));
  const home = new HarnessHome();
  const store = new FakeRecordStore();
  const first = new HomeBackedClient(home);
  const adapter1 = new DshRuntimeAdapter({ createClient: () => first, transcriptDir: dir });
  try {
    await adapter1.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });

    // Every prompt lands on an id minted for THIS child generation — never the
    // bare session key, which an earlier generation may already have created.
    const deltas = await collect(adapter1.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));
    const idle = deltas.find((d) => d.type === "session-status" && d.status === "idle");
    assert.ok(idle, "the first turn of a generation must settle idle");
    assert.equal(first.sessionIds.length, 1, "a fresh generation issues exactly one prompt");
    const harnessId = first.sessionIds[0]!;
    assert.ok(
      harnessId.startsWith("sess-1-") && harnessId !== "sess-1",
      "the harness id is scoped to the child generation, never the bare session key",
    );
    assert.deepEqual([...home.materialized], [harnessId], "the turn created exactly that one harness session");

    const mirror = new TranscriptMirror(dir);
    assert.ok(await mirror.load("sess-1"), "the run persists its mirror before the stream ends");
    assert.equal(store.runs.length, 1);
    assert.equal(store.runs[0]!.status, "completed");
    assert.equal(store.runs[0]!.output, "Hello from dsh.");

    // Later turns in the SAME child continue that one harness session.
    await collect(adapter1.run(session(), [
      { type: "add-message", message: { id: "u2", role: "user", content: "hi again" } },
    ]));
    assert.equal(first.sessionIds.length, 2, "a second turn issues exactly one prompt");
    assert.equal(first.sessionIds[1], harnessId, "later turns continue the SAME harness session");

    // Simulate a service restart: a NEW child generation over the SAME home.
    // Nothing it asks for may be an id the home already holds, or the restart
    // would burn a rejected prompt before its first reply.
    const store2 = new FakeRecordStore();
    const second = new HomeBackedClient(home);
    const adapter2 = new DshRuntimeAdapter({ createClient: () => second, transcriptDir: dir });
    await adapter2.init({ binding: { runtime: "dsh", config: {} }, recordStore: store2 });
    const restarted = await collect(adapter2.run(session(), [
      { type: "add-message", message: { id: "u3", role: "user", content: "after restart" } },
    ]));
    assert.equal(second.sessionIds.length, 1, "a restart must NOT burn a prompt on an id the home already holds");
    assert.notEqual(second.sessionIds[0], harnessId, "the new generation gets its own harness session");
    assert.ok(
      restarted.some((d) => d.type === "session-status" && d.status === "idle"),
      "the restarted turn settles idle");
    assert.equal(store2.runs.length, 1);
    assert.equal(store2.runs[0]!.status, "completed");
  } finally {
    await adapter1.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a harness id another process already took falls back to a fresh harness session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-collision-"));
  const store = new FakeRecordStore();
  const client = new CollidingHomeClient();
  const adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });

    // First attempt collides; the adapter must retry on a fresh id so the turn
    // settles with a reply instead of dying as an error.
    const deltas = await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));
    assert.ok(
      deltas.every((d) => !(d.type === "session-status" && d.status === "error")),
      "a create-only harness failure must NOT settle the run to error",
    );
    assert.equal(client.sessionIds.length, 2, "first attempt on the collided id, retry on a fresh one");
    const fresh = client.sessionIds[1]!;
    assert.ok(fresh.startsWith(`${client.sessionIds[0]}-`), "the retry stays in this generation's id space");

    const mirror = new TranscriptMirror(dir);
    assert.ok(await mirror.load("sess-1"), "the fallback run persists before its stream ends");
    assert.equal(store.runs.length, 1);
    assert.equal(store.runs[0]!.status, "completed", "the fallback turn is recorded as a completed Run");
    assert.equal(store.runs[0]!.output, "Hello from dsh.");

    // The fresh id is the one this child keeps using.
    await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u2", role: "user", content: "hi again" } },
    ]));
    assert.equal(client.sessionIds.length, 3, "second run issues exactly one prompt");
    assert.equal(client.sessionIds[2], fresh, "later turns continue the SAME fresh harness session");
    assert.equal(store.runs.length, 2);
  } finally {
    await adapter.abort();
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
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    const deltas = await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));
    const error = deltas.find((d) => d.type === "session-status" && d.status === "error");
    assert.ok(error, "the session must settle to error");
    const mirror = new TranscriptMirror(dir);
    assert.ok(await mirror.load("sess-1"), "an error turn persists before its stream ends");
    assert.equal(store.runs.length, 1);
    assert.equal(store.runs[0]!.status, "error", "failed turns are still recorded as Runs");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
