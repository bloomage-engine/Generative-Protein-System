import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import type { RecordStoreLike, SessionState, StateDelta, SubagentRun } from "@science-studio/transport";
import { sessionState } from "@science-studio/contract-tests";
import type { Run, Subagent } from "@science-studio/record";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";
import type { PersistedTranscript } from "@science-studio/record";
import type { DshCommandBridge } from "../src/bridge.js";
import type { DshAssistantStreamMessage } from "../src/assistant-stream.js";

function ev(type: string, data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: Date.now(), data } as unknown as SessionEvent;
}

/** A scripted turn client: emits scripted events per prompt, then resolves. */
class FakeDshClient implements DshTurnClient {
  started = false;
  readonly prompts: string[] = [];
  readonly sessionIds: string[] = [];
  private listener: ((notification: HarnessNotification) => void) | null = null;
  /** Invoked after this turn's sessionId is recorded, before its scripted events run. */
  duringTurn: ((sessionId: string) => void) | undefined;
  constructor(private readonly script: (sessionId: string, text: string) => SessionEvent[]) {}
  async start(): Promise<void> {
    this.started = true;
  }
  async close(): Promise<void> {}
  subscribeNotifications(listener: (notification: HarnessNotification) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  emit(notification: HarnessNotification): void {
    this.listener?.(notification);
  }
  async runTurn(
    sessionId: string,
    text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    this.prompts.push(text);
    this.sessionIds.push(sessionId);
    this.duringTurn?.(sessionId);
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
  readonly subagents = new Map<string, Subagent>();
  /** The record's durable session transcripts (docs/adr/0019). */
  readonly transcripts = new Map<string, PersistedTranscript>();
  async addRun(run: Run): Promise<void> {
    this.runs.push(run);
  }
  async saveSessionTranscript(sessionId: string, doc: PersistedTranscript): Promise<void> {
    this.transcripts.set(sessionId, structuredClone(doc));
  }
  async loadSessionTranscript(sessionId: string): Promise<PersistedTranscript | null> {
    const doc = this.transcripts.get(sessionId);
    return doc === undefined ? null : structuredClone(doc);
  }
  async upsertSubagent(subagent: Subagent): Promise<void> {
    this.subagents.set(subagent.id, {...subagent});
  }
  async loadSubagent(id: string): Promise<Subagent | null> {
    return this.subagents.get(id) ?? null;
  }
  async listSubagents(parentSessionId: string): Promise<Subagent[]> {
    return [...this.subagents.values()].filter((s) => s.parentSessionId === parentSessionId);
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

test("run() streams user + assistant deltas, persists a Run, and saves the transcript to the record", async () => {
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
    // so the Run and the record's transcript are already final when
    // collect() returns.
    const loaded = await store.loadSessionTranscript("sess-1");
    assert.ok(loaded, "the record's transcript must be saved before the run stream settles");
    assert.equal(store.runs.length, 1);
    const run = store.runs[0]!;
    assert.equal(run.status, "completed");
    assert.equal(run.input, "hi");
    assert.equal(run.output, "Hello from dsh.");
    assert.equal(run.id, "u1");

    assert.ok(loaded && (loaded.messages as unknown[]).length >= 2, "the record must persist the full transcript");
  } finally {
    await adapter.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

test("DshAdapter mounts the parent-reporting plugin patch unconditionally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-subagent-report-"));
  const client = new FakeDshClient((_sid, _text) => []);
  let captured: string[] = [];
  const adapter = new DshRuntimeAdapter({
    createClient: (options) => {
      captured = options.patches ?? [];
      return client;
    },
    transcriptDir: dir,
  });
  const store = new FakeRecordStore();
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    assert.ok(
      captured.some((p) => p.includes("subagent-reporting-")),
      "the parent-reporting patch is present in `patches`",
    );
    assert.ok(captured.length >= 2, "at least the bridge + report patches (2 min) are mounted");
  } finally {
    await client.close();
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
      ["status", "new", "compact", "feedback", "goal", "permission", "plan", "project", "cron"],
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

test("a fresh adapter instance cold-starts from the record and reconciles history", async () => {
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
    assert.ok(await store.loadSessionTranscript("sess-1"), "the first run persists the transcript to the record before it returns");
    assert.equal(store.runs.length, 1);

    // Simulate a service restart: brand-new adapter over the SAME record
    // (docs/adr/0019: the record IS the durable home), no shared memory.
    // A probe must reconcile the FULL prior history.
    const adapter2 = new DshRuntimeAdapter({
      createClient: () => new FakeDshClient(() => []),
      transcriptDir: dir,
    });
    await adapter2.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    const deltas = await collect(adapter2.run(session(), []));
    const reconcile = deltas.find((d) => d.type === "reconcile") as
      | { messages: { id: string; role: string }[] }
      | undefined;
    assert.ok(reconcile, "a probe yields a reconcile snapshot");
    assert.deepEqual(
      reconcile.messages.map((m) => m.id),
      ["u1", "am1"],
      "cold start must restore the full canonical transcript from the record",
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

    assert.ok(await store.loadSessionTranscript("sess-1"), "the run persists its transcript to the record before the stream ends");
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

    assert.ok(await store.loadSessionTranscript("sess-1"), "the fallback run persists to the record before its stream ends");
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

test("a saved route credential reaches the launch client env", async () => {
  const home = await mkdtemp(join(tmpdir(), "ss-route-env-"));
  try {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const adapter = new DshRuntimeAdapter({
      createClient: (options): DshTurnClient => {
        seenEnv = options.env;
        return { start: async () => {}, close: async () => {}, runTurn: async () => {} };
      },
      transcriptDir: join(tmpdir(), "science-studio-route-env-test"),
    });
    await adapter.init({
      binding: {
        runtime: "dsh",
        config: {
          home,
          provider: "ollama-local",
          model: "qwen3.8:latest",
          endpoint: "http://h/v1",
          apiKey: "secret-key",
        },
      },
      recordStore: { addRun: async () => {} },
    });
    assert.equal(seenEnv?.OLLAMA_LOCAL_API_KEY, "secret-key");
    assert.equal(seenEnv?.PATH, process.env.PATH, "the child env keeps the parent environment");
    const settings = await readFile(join(home, "settings.yaml"), "utf8");
    assert.match(settings, /baseURL: http:\/\/h\/v1/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failing route write does not fail init", async () => {
  const home = await mkdtemp(join(tmpdir(), "ss-route-fail-"));
  try {
    await writeFile(join(home, "settings.yaml"), "", "utf8");
    await mkdir(join(home, "settings.yaml.tmp"));
    const adapter = new DshRuntimeAdapter({
      createClient: (): DshTurnClient => ({ start: async () => {}, close: async () => {}, runTurn: async () => {} }),
      transcriptDir: join(tmpdir(), "science-studio-route-fail-test"),
    });
    await adapter.init({
      binding: {
        runtime: "dsh",
        config: { home, provider: "p", endpoint: "http://x/v1", apiKey: "k" },
      },
      recordStore: { addRun: async () => {} },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
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
    assert.ok(await store.loadSessionTranscript("sess-1"), "an error turn persists to the record before its stream ends");
    assert.equal(store.runs.length, 1);
    assert.equal(store.runs[0]!.status, "error", "failed turns are still recorded as Runs");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a standing subscription reports live subagent runs for the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-subagents-"));
  const store = new FakeRecordStore();
  const client = new FakeDshClient(() => completedReply("am1", "Hello from dsh."));
  const adapter = new DshRuntimeAdapter({
    createClient: () => client,
    transcriptDir: dir,
    now: () => "2026-09-17T00:00:00.000Z",
  });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "delegate" } },
    ]));
    const parent = client.sessionIds[0]!;
    assert.equal(await adapter.subagents("sess-1").then((l) => l.length), 0, "no subagents yet");

    client.emit({
      method: "subagent.started",
      params: { parentSessionId: parent, childSessionId: "child-1" },
    });
    client.emit({
      method: "session.event",
      params: {
        sessionId: "child-1",
        event: { type: "subagent/descriptor", data: { label: "Literature review", provider: "spawn" } },
      },
    });
    const running = await adapter.subagents("sess-1");
    assert.equal(running.length, 1);
    assert.ok(running[0]!.id.startsWith("subagent-"), "the id is the stable record identity, not the wire child id");
    assert.equal(running[0]!.parentId, "sess-1");
    assert.equal(running[0]!.label, "Literature review");
    assert.equal(running[0]!.status, "running");
    assert.equal(running[0]!.startedAt, "2026-09-17T00:00:00.000Z");
    assert.deepEqual(await adapter.subagents("other"), [], "only the owning session lists it");

    client.emit({
      method: "subagent.finished",
      params: {
        parentSessionId: parent,
        childSessionId: "child-1",
        provider: "spawn",
        status: "ok",
        stopReason: "completed",
      },
    });
    const done = await adapter.subagents("sess-1");
    assert.equal(done[0]!.status, "completed");
    assert.equal(done[0]!.stopReason, "completed");
    assert.equal(done[0]!.finishedAt, "2026-09-17T00:00:00.000Z");
  } finally {
    await adapter.abort();
    await adapter.flushSubagents();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a subagent started during the first turn is listed mid-turn and after", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-subagent-first-turn-"));
  const store = new FakeRecordStore();
  const client = new FakeDshClient((_sid, _text) => completedReply("am1", "Hello from dsh."));
  let adapter: DshRuntimeAdapter;
  let pendingRead: Promise<SubagentRun[]> | undefined;
  client.duringTurn = (sessionId) => {
    client.emit({
      method: "subagent.started",
      params: { parentSessionId: sessionId, childSessionId: "child-live" },
    });
    pendingRead = adapter.subagents("sess-1");
  };
  adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "delegate" } },
    ]));

    assert.ok(pendingRead, "the first turn must have been polled mid-run");
    const midRun = await pendingRead;
    assert.equal(midRun.length, 1, "the subagent is live while the parent turn is still running");
    assert.ok(midRun[0]!.id.startsWith("subagent-"), "the id is the stable record identity");

    const after = await adapter.subagents("sess-1");
    assert.equal(after.length, 1, "the subagent survives the parent turn settling");
    assert.equal(after[0]!.id, midRun[0]!.id, "the same stable id survives the parent turn settling");
  } finally {
    await adapter.abort();
    await adapter.flushSubagents();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a finished subagent run belongs to the session's ledger across an adapter restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-subagents-persist-"));
  const now = () => "2026-09-18T00:00:00.000Z";
  const store = new FakeRecordStore();
  const client = new FakeDshClient(() => completedReply("am1", "Hello from dsh."));
  try {
    const first = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir, now });
    await first.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    await collect(first.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "delegate" } },
    ]));
    const parent = client.sessionIds[0]!;
    client.emit({ method: "subagent.started", params: { parentSessionId: parent, childSessionId: "child-1" } });
    client.emit({
      method: "session.event",
      params: { sessionId: "child-1", event: { type: "subagent/descriptor", data: { label: "收集足球类24小时体育新闻", provider: "spawn" } } },
    });
    client.emit({
      method: "subagent.finished",
      params: { parentSessionId: parent, childSessionId: "child-1", provider: "spawn", status: "ok", stopReason: "completed" },
    });
    await first.flushSubagents();
    const done = await first.subagents("sess-1");
    assert.equal(done.length, 1);
    assert.equal(done[0]!.status, "completed");
    await first.abort();

    // A SECOND adapter generation over the SAME transcript dir must still list
    // the finished run (the panel's history across service restarts).
    const restarted = new DshRuntimeAdapter({
      createClient: () => new FakeDshClient(() => completedReply("am2", "Hello again.")),
      transcriptDir: dir,
      now,
    });
    await restarted.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    const restored = await restarted.subagents("sess-1");
    await restarted.abort();
    assert.equal(restored.length, 1, "a finished subagent run survives an adapter restart");
    assert.equal(restored[0]!.id, done[0]!.id, "the SAME stable id survives the adapter restart");
    assert.ok(restored[0]!.id.startsWith("subagent-"));
    assert.equal(restored[0]!.status, "completed");
    assert.equal(restored[0]!.label, "收集足球类24小时体育新闻");
    assert.equal(await restarted.subagents("other").then((l) => l.length), 0, "only the owning Session lists it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subagentTranscript serves the child's record and null for a foreign child", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const zlib = await import("node:zlib");
  // `zstdCompressSync` is present at runtime (Node >= 23.8) but not declared in
  // this repo's pinned @types/node — reached the same way as the production module.
  const zstdCompressSync = (zlib as unknown as {
    zstdCompressSync: (buf: string | Buffer) => Buffer;
  }).zstdCompressSync;
  const { projectKey } = await import("../src/child-transcript.js");
  const dir = await mkdtemp(join(tmpdir(), "dsh-subagent-transcript-"));
  const store = new FakeRecordStore();
  const client = new FakeDshClient(() => completedReply("am1", "Hello from dsh."));
  const adapter = new DshRuntimeAdapter({
    createClient: () => client,
    transcriptDir: dir,
    bindingDshHome: dir, // test seam (added by this task)
  });
  try {
    await adapter.init({
      binding: { runtime: "dsh", config: {} },
      recordStore: store,
      workspace: { toAgentPath: () => "/proj/one", root: "/proj/one" } as never,
    });
    // Lay a child log down where the harness would store it.
    const childDir = join(dir, "sessions", projectKey("/proj/one"), "sub-child-1");
    await (await import("node:fs/promises")).mkdir(childDir, { recursive: true });
    const log = JSON.stringify({ type: "session", id: "sub-child-1", version: 3, createdAt: 1789655889309, cwd: "/proj/one", delegationDepth: 1, isSeeded: false, origin: "subagent" })
      + "\n"
      + JSON.stringify({ type: "assistant/message", seq: 1, time: 1789655911253, data: { turn: 1, step: 1, message: { role: "assistant", id: "m1", content: [{ type: "text", text: "child says hi" }] } } })
      + "\n"
      + JSON.stringify({ type: "turn/end", seq: 2, time: 1789656491505, data: { turn: 1, reason: { kind: "completed" } } });
    await writeFile(join(childDir, "session.v3.jsonl.zstd"), zstdCompressSync(log), "utf8");

    const run: SubagentRun = {
      id: "sub-child-1",
      parentId: "sess-1",
      provider: "spawn",
      status: "running",
      startedAt: "2026-09-17T14:38:09.309Z",
    };
    await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "delegate" } },
    ]));
    client.emit({ method: "subagent.started", params: { parentSessionId: client.sessionIds[0] ?? "root-x", childSessionId: "sub-child-1" } });
    client.emit({
      method: "subagent.finished",
      params: {
        parentSessionId: client.sessionIds[0] ?? "root-x",
        childSessionId: "sub-child-1",
        provider: "spawn",
        status: "ok",
        stopReason: "max-tokens",
      },
    });
    void run;

    // The panel lists the STABLE id (the record's key); the transcript surface
    // accepts that same id and resolves it to the harness's own child log.
    const stableId = (await adapter.subagents("sess-1"))[0]!.id;
    assert.ok(stableId.startsWith("subagent-"));
    const t = await adapter.subagentTranscript("sess-1", stableId);
    assert.ok(t, "the adapter must serve the child's record");
    assert.equal(t!.id, stableId, "the transcript is keyed on the stable id (SubagentRun.id)");
    assert.equal(t!.status, "completed");
    assert.equal(t!.messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "child says hi")), true);
    assert.equal(t!.stopReason, "max-tokens", "the registry's stop reason surfaces on the transcript");

    assert.equal(await adapter.subagentTranscript("sess-1", "not-in-the-ledger"), null, "a child outside the session's ledger is not served");
  } finally {
    await adapter.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live assistant frames reach the transcript through the bridge watch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-adapter-"));
  const store = new FakeRecordStore();
  let streamListener: ((message: DshAssistantStreamMessage) => void) | null = null;
  let subscribed = false;
  const bridge: DshCommandBridge = {
    list: async () => [],
    execute: async () => ({ status: "unknown" }),
    subscribeAssistantStream: (listener) => {
      subscribed = true;
      streamListener = listener;
      return () => {
        streamListener = null;
      };
    },
  };
  const client = new FakeDshClient((_sid, _text) => completedReply("am1", "Hello from dsh."));
  const adapter = new DshRuntimeAdapter({
    createClient: () => client,
    createBridge: () => bridge,
    bridgeDir: dir,
  });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    // The turn's live frames are produced through the captured bridge listener.
    client.duringTurn = (sessionId) => {
      // The real wire carries turn/step only on `start`; chunk/end carry just
      // the attemptId (this is what routes them back to the live row).
      streamListener?.({ sessionId, frame: { type: "start", turn: 1, step: 1, attemptId: "a1" } });
      streamListener?.({
        sessionId,
        frame: { type: "chunk", attemptId: "a1", chunk: { type: "block-start", index: 0, blockType: "text" } },
      });
      streamListener?.({
        sessionId,
        frame: { type: "chunk", attemptId: "a1", chunk: { type: "text-delta", index: 0, text: "Hello" } },
      });
    };

    const deltas = await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));
    assert.ok(subscribed, "the adapter subscribed to the bridge stream");
    assert.ok(
      deltas.some((delta) => delta.type === "stream-text" && delta.text === "Hello"),
      "the live text delta reached the client stream",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
