import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { DshRuntimeAdapter } from "../src/index.js";
import {
  collect,
  command,
  FakeDshClient,
  FakeRecordStore,
  InterceptingDshClient,
  replies,
  ScriptedBridge,
  session,
  tmpTranscriptDir,
  type BridgeScript,
  type ScriptedClient,
} from "./command-case.js";

/**
 * Harness commands over the dsh adapter (docs/adr/0011): the adapter's own two
 * commands stay local; a session that HAS a harness agent executes the rest in
 * the child through the bridge; and a session that has none yet drives the line
 * as the first prompt that CREATES that agent, which the child's pre-step
 * interception runs instead of the model. No harness process runs here — the
 * turn client and the bridge are scripted; the socket pair and the interception
 * itself are covered by `bridge-plugin.test.ts`.
 */

/** An initialized adapter with a scripted child; `bridge` records every call. */
async function adapterCase(
  script: BridgeScript = () => ({ status: "unknown" }),
  client: ScriptedClient = new FakeDshClient(),
): Promise<{
  dir: string;
  store: FakeRecordStore;
  client: ScriptedClient;
  bridge: ScriptedBridge;
  adapter: DshRuntimeAdapter;
}> {
  const dir = await tmpTranscriptDir();
  const store = new FakeRecordStore();
  const bridge = new ScriptedBridge(script);
  const adapter = new DshRuntimeAdapter({
    createClient: () => client,
    transcriptDir: dir,
    // Same directory as the mirror: the launch artifacts are cleaned with it.
    bridgeDir: dir,
    createBridge: () => bridge,
  });
  await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
  return { dir, store, client, bridge, adapter };
}

/** One real model turn, so this session HAS a harness agent. */
async function warmTurn(
  adapter: DshRuntimeAdapter,
  client: ScriptedClient,
  id = "u1",
): Promise<string> {
  await collect(adapter.run(session(), [command("hi", id)]));
  return client.sessionIds.at(-1)!;
}

const NO_AGENT = "`/compact` needs this session's agent, which has not started yet — send a message first, then run it again.";
const UNAVAILABLE =
  "The dsh harness is not available, so `/compact` cannot run — see the transport-service logs.";

test("a harness command runs in the child: one result row, no prompt, no Run", async () => {
  const { dir, store, client, bridge, adapter } = await adapterCase(() => ({
    status: "ok",
    kind: "success",
    text: "Condensed 12 items",
  }));
  try {
    const harnessSession = await warmTurn(adapter, client, "u1");

    const deltas = await collect(adapter.run(session(), [command("/compact", "u2")]));

    assert.deepEqual(bridge.calls, [{ sessionId: harnessSession, line: "/compact" }]);
    assert.equal(client.prompts.length, 1, "the command never reaches the model");
    assert.equal(bridge.listCalls, 0, "a result-bearing command needs no catalog read");
    assert.deepEqual(replies(deltas), ["Condensed 12 items"], "the harness's own text is the reply");
    assert.ok(
      deltas.some((d) => d.type === "session-status" && d.status === "running"),
      "the kit reports the run as running while the command works",
    );
    assert.ok(
      deltas.some((d) => d.type === "session-status" && d.status === "idle"),
      "and idle once it settles",
    );
    assert.equal(store.runs.length, 1, "only the model turn is a Run (docs/adr/0003)");

    // The command row and the reply are in the RECORD's saved transcript
    // (docs/adr/0019), so they survive a reload.
    const loaded = await store.loadSessionTranscript("sess-1");
    const texts = (loaded?.messages as { parts: Array<{ type: string; text?: string }> }[] | undefined)?.flatMap(
      (m) => m.parts.filter((p) => p.type === "text").map((p) => p.text as string),
    );
    assert.ok(texts?.includes("/compact"), "the command row is in the record's transcript");
    assert.ok(texts?.includes("Condensed 12 items"), "and so is the harness's result");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a name the harness does not know is answered, and names what this runtime answers", async () => {
  const { dir, client, bridge, adapter } = await adapterCase();
  try {
    await warmTurn(adapter, client);

    const deltas = await collect(adapter.run(session(), [command("/nope", "u2")]));

    assert.deepEqual(replies(deltas), [
      "Unknown command `/nope`. This runtime answers: `/status`, `/new`, `/compact`, `/plan`.",
    ]);
    assert.equal(client.prompts.length, 1);
    assert.equal(bridge.calls.length, 1, "the harness is what decides a name is unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the harness's own outcomes each get their literal reply", async () => {
  for (const [outcome, expected] of [
    [{ status: "no-agent" } as const, NO_AGENT],
    [{ status: "unavailable", message: "socket gone" } as const, UNAVAILABLE],
  ] as const) {
    const { dir, client, bridge, adapter } = await adapterCase(() => outcome);
    try {
      await warmTurn(adapter, client);
      const deltas = await collect(adapter.run(session(), [command("/compact", "u2")]));
      assert.deepEqual(replies(deltas), [expected]);
      assert.equal(bridge.calls.length, 1);
      assert.equal(client.prompts.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a bridge failure is a reply, never a broken run stream", async () => {
  const { dir, client, adapter } = await adapterCase(() => {
    throw new Error("the child died mid-command");
  });
  try {
    await warmTurn(adapter, client);
    const deltas = await collect(adapter.run(session(), [command("/compact", "u2")]));
    assert.deepEqual(replies(deltas), [UNAVAILABLE]);
    assert.ok(
      deltas.every((d) => !(d.type === "session-status" && d.status === "error")),
      "a command never fails the run",
    );
    assert.ok(deltas.some((d) => d.type === "session-status" && d.status === "idle"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cold session's harness command rides the prompt that creates its agent", async () => {
  const client = new InterceptingDshClient();
  const { dir, store, bridge, adapter } = await adapterCase(
    () => ({ status: "ok", kind: "success", text: "Condensed 12 items" }),
    client,
  );
  try {
    const deltas = await collect(adapter.run(session(), [command("/compact")]));

    assert.deepEqual(client.prompts, ["/compact"], "the line IS the session's first prompt");
    assert.ok(
      client.sessionIds[0]!.startsWith("sess-1-"),
      "and it lands on a harness session minted for THIS Generative Protein System session",
    );
    assert.deepEqual(bridge.calls, [], "with no agent yet there is nothing to aim the bridge at");
    assert.deepEqual(replies(deltas), ["Condensed 12 items"], "the harness's own command/done is the reply");
    assert.equal(store.runs.length, 0, "a command is not a research turn (docs/adr/0003)");
    assert.ok(
      deltas.some((d) => d.type === "session-status" && d.status === "running"),
      "the command reports itself as running while it works",
    );
    assert.ok(deltas.some((d) => d.type === "session-status" && d.status === "idle"));

    // The agent exists now: the next turn continues on the SAME harness
    // conversation, and the next command takes the warm bridge path.
    await collect(adapter.run(session(), [command("hi", "u2")]));
    assert.equal(client.sessionIds.length, 2);
    assert.equal(client.sessionIds[1], client.sessionIds[0], "one agent, one conversation");

    const warm = await collect(adapter.run(session(), [command("/compact", "u3")]));
    assert.deepEqual(bridge.calls, [{ sessionId: client.sessionIds[0], line: "/compact" }]);
    assert.deepEqual(replies(warm), ["Condensed 12 items"]);
    assert.equal(store.runs.length, 1, "only the model turn is a Run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cold command this runtime does not publish is answered, never prompted", async () => {
  const client = new InterceptingDshClient();
  const { dir, bridge, adapter } = await adapterCase(() => ({ status: "unknown" }), client);
  try {
    const deltas = await collect(adapter.run(session(), [command("/nope")]));

    assert.deepEqual(client.prompts, [], "an unknown name never buys an agent");
    assert.deepEqual(bridge.calls, []);
    assert.deepEqual(replies(deltas), [
      "Unknown command `/nope`. This runtime answers: `/status`, `/new`, `/compact`, `/plan`.",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a curated name this harness does not resolve is still answered, not left silent", async () => {
  const client = new InterceptingDshClient();
  const { dir, bridge, adapter } = await adapterCase(() => ({ status: "unknown" }), client);
  // The registry cannot be read, so the CURATED cold catalog is what the menu
  // and this gate see — and `/feedback` is a name it claims.
  bridge.list = async () => {
    throw new Error("the child died");
  };
  try {
    const deltas = await collect(adapter.run(session(), [command("/feedback")]));

    assert.deepEqual(client.prompts, ["/feedback"], "the curation is what sent it to the child");
    assert.deepEqual(bridge.calls, [], "and the bridge had nothing to run it on");
    assert.deepEqual(replies(deltas), [
      "Unknown command `/feedback`. This runtime answers: `/status`, `/new`, `/compact`, `/feedback`, `/goal`, `/permission`, `/plan`, `/project`, `/cron`, `/worktree`.",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("after /new, a harness command starts this session's OWN fresh conversation", async () => {
  const client = new InterceptingDshClient();
  const { dir, bridge, adapter } = await adapterCase(() => ({ status: "unknown" }), client);
  try {
    const first = await warmTurn(adapter, client, "u1");
    // `/new` drops this session's harness conversation, so it has no agent
    // until the next prompt — and the registry executes against ONE exact agent.
    await collect(adapter.run(session(), [command("/new", "u2")]));

    const deltas = await collect(adapter.run(session(), [command("/compact", "u3")]));

    assert.deepEqual(bridge.calls, [], "no other session's agent is aimed at");
    assert.equal(client.sessionIds.length, 2, "the command is the fresh conversation's first prompt");
    const after = client.sessionIds[1]!;
    assert.notEqual(after, first);
    assert.ok(after.startsWith("sess-1-"), "and it belongs to THIS session");
    assert.deepEqual(replies(deltas), ["Condensed 12 items"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/status is answered locally: no child, no bridge", async () => {
  const { dir, client, bridge, adapter } = await adapterCase();
  try {
    const deltas = await collect(adapter.run(session(), [command("/status")]));
    assert.match(replies(deltas)[0]!, /deepseek-official\/deepseek-v4-flash/);
    assert.equal(client.started, false, "the commands that must survive a dead harness never need it");
    assert.equal(bridge.calls.length, 0);
    assert.equal(bridge.listCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a harness command named like a local one never shadows it", async () => {
  const { dir, client, bridge, adapter } = await adapterCase(() => ({
    status: "ok",
    kind: "success",
    text: "the harness's own status",
  }));
  try {
    await warmTurn(adapter, client);
    bridge.listed = [
      { name: "status", description: "the harness's own status" },
      { name: "compact", description: "Condense the conversation" },
    ];

    const catalog = await adapter.listCommands();
    assert.deepEqual(catalog.map((d) => d.id), ["status", "new", "compact"]);
    const status = catalog.filter((d) => d.id === "status");
    assert.equal(status.length, 1, "one name = one row");
    assert.equal(status[0]!.label, "/status");
    assert.equal(status[0]!.invocationText, "/status");

    const deltas = await collect(adapter.run(session(), [command("/status", "u2")]));
    assert.match(replies(deltas)[0]!, /deepseek-official\/deepseek-v4-flash/);
    assert.equal(bridge.calls.length, 0, "the local command still never reaches the harness");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the catalog curates the harness's own commands while cold, then takes the live list", async () => {
  const { dir, client, bridge, adapter } = await adapterCase();
  try {
    const cold = (await adapter.listCommands()).map((d) => d.id);
    assert.deepEqual(
      cold,
      ["status", "new", "compact", "feedback", "goal", "permission", "plan", "project", "cron", "worktree"],
      "a cold runtime still shows the harness's own commands (docs/adr/0011)",
    );
    assert.equal(client.started, false, "a menu request must never boot a harness child");
    assert.equal(bridge.listCalls, 0);

    await warmTurn(adapter, client);

    // `ScriptedBridge` lists exactly compact+plan, so the live catalog IS these
    // four: the fallback is only a fallback — a command the harness dropped
    // leaves the menu the moment the registry can be read.
    assert.deepEqual(
      (await adapter.listCommands()).map((d) => d.id),
      ["status", "new", "compact", "plan"],
    );
    assert.equal(bridge.listCalls, 1);

    await adapter.listCommands();
    assert.equal(bridge.listCalls, 1, "a second read inside the TTL is served from the cache");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bridge that cannot list falls back to the curated harness catalog", async () => {
  const dir = await tmpTranscriptDir();
  const client = new FakeDshClient();
  const bridge = new ScriptedBridge();
  bridge.list = async () => {
    throw new Error("the child died");
  };
  const adapter = new DshRuntimeAdapter({
    createClient: () => client,
    transcriptDir: dir,
    bridgeDir: dir,
    createBridge: () => bridge,
  });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: new FakeRecordStore() });
    await warmTurn(adapter, client);
    assert.deepEqual(
      (await adapter.listCommands()).map((d) => d.id),
      ["status", "new", "compact", "feedback", "goal", "permission", "plan", "project", "cron", "worktree"],
      "the adapter degrades to its own commands plus the curated harness set",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
