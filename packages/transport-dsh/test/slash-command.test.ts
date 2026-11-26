import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { RecordStoreLike, StateDelta } from "@gps/transport";
import type { Run } from "@gps/record";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";
import {
  collect,
  command,
  completedReply,
  FakeDshClient,
  FakeRecordStore,
  InterceptingDshClient,
  replies,
  session,
} from "./command-case.js";

/**
 * Slash commands over the dsh adapter (docs/adr/0003, docs/adr/0010, docs/adr/0011).
 *
 * Two layers answer them: the ADAPTER's own commands (`/status`, `/new`) come
 * from its own state, and the harness's registry (docs/adr/0011) is reached over
 * the child bridge. Either way a command never prompts the child, never records
 * a `Run`, and still lands in the transcript — and in the record's saved
 * transcript, so it survives a reload (docs/adr/0019).
 */

/**
 * A harness home shared by every child generation — it rejects any id it
 * already holds with the SDK's create-only `session "<id>" already exists`.
 * A later mint that re-used the current conversation's id would therefore be a
 * rejected prompt instead of a fresh conversation.
 */
class HomeBackedClient implements DshTurnClient {
  readonly prompts: string[] = [];
  readonly sessionIds: string[] = [];
  private readonly materialized = new Set<string>();
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async runTurn(
    sessionId: string,
    text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    this.prompts.push(text);
    this.sessionIds.push(sessionId);
    if (this.materialized.has(sessionId)) throw new Error(`session "${sessionId}" already exists`);
    this.materialized.add(sessionId);
    for (const event of completedReply(`am-${sessionId}-${this.prompts.length}`, "Hello from dsh.")) {
      onEvent(event);
    }
  }
}

test("the catalog is served before the harness child has ever started", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-commands-"));
  const client = new FakeDshClient();
  const adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: new FakeRecordStore() });
    const catalog = await adapter.listCommands();
    assert.deepEqual(
      catalog.map((d) => [d.id, d.invocationText]),
      [
        ["status", "/status"],
        ["new", "/new"],
        // The pinned profile's own commands (docs/adr/0011): the registry is
        // agent-scoped, so a cold runtime cannot enumerate it — without the
        // curated layer the menu would look empty until the first message.
        ["compact", "/compact"],
        ["feedback", "/feedback"],
        ["goal", "/goal"],
        ["permission", "/permission"],
        ["plan", "/plan"],
        // This package's own project plugin (docs/adr/0012), curated for the
        // same cold-registry reason.
        ["project", "/project"],
        // This package's own cron plugin, curated for the same reason.
        ["cron", "/cron"],
        // This package's own worktree plugin, curated for the same reason.
        ["worktree", "/worktree"],
      ],
    );
    assert.equal(client.started, false, "the menu must not need a spawned harness");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [line, expected, prompts] of [
  ["/status", /ollama-local\/qwen3\.8:latest/, []],
  ["/compact", /Condensed 12 items/, ["/compact"]],
] as const) {
  test(`a command run answers ${line}: one reply row, no Run, a reply in the transcript`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-command-run-"));
    const store = new FakeRecordStore();
    const client = new InterceptingDshClient();
    const adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
    try {
      await adapter.init({
        binding: {
          runtime: "dsh",
          config: { provider: "ollama-local", model: "qwen3.8:latest", workspace: "/projects/p1" },
        },
        recordStore: store,
      });

      const deltas = await collect(adapter.run(session(), [command(line)]));

      assert.deepEqual(
        client.prompts,
        prompts,
        prompts.length === 0
          ? "a command the adapter answers itself prompts nothing at all"
          : "a cold session's harness command IS the prompt that creates its agent — the child rejects the step before the model",
      );
      assert.equal(
        client.started,
        prompts.length > 0,
        prompts.length > 0
          ? "a harness command IS a deliberate request to use the runtime, so the child is started"
          : "a command the adapter answers itself must not need the child at all",
      );
      assert.equal(store.runs.length, 0, "a command is not a research turn (docs/adr/0003)");
      const reply = replies(deltas);
      assert.equal(reply.length, 1, "a command has exactly one reply row");
      assert.match(reply[0]!, expected);
      assert.ok(
        deltas.some((d) => d.type === "session-status" && d.status === "idle"),
        "the session must settle idle after the reply",
      );

      const loaded = await store.loadSessionTranscript("sess-1");
      const texts = (loaded?.messages as { parts: Array<{ type: string; text?: string }> }[] | undefined)?.flatMap(
        (m) => m.parts.filter((p) => p.type === "text").map((p) => p.text as string),
      );
      assert.equal(texts?.[0], line, "the command row is visible in the transcript");
      assert.ok(texts?.some((t) => t === reply[0]), "the reply is in the record, so it survives a reload");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("/new forgets the conversation: the next turn starts a fresh harness session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-command-new-"));
  const store = new FakeRecordStore();
  const client = new HomeBackedClient();
  const adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });

    await collect(adapter.run(session(), [command("hi", "u1")]));
    const first = client.sessionIds[0]!;

    const reset = await collect(adapter.run(session(), [command("/new", "u2")]));
    assert.equal(client.prompts.length, 1, "/new itself prompts nothing");
    assert.match(replies(reset)[0]!, /fresh agent conversation/);

    // The home REJECTS a re-used id, so a second prompt on `first` — or on any
    // id this child already created — would surface as a failed turn.
    const after = await collect(adapter.run(session(), [command("hi again", "u3")]));
    assert.equal(client.sessionIds.length, 2, "the turn after /new prompts exactly once");
    assert.notEqual(client.sessionIds[1], first, "and on a harness session newer than the dropped one");
    assert.ok(
      after.every((d) => !(d.type === "session-status" && d.status === "error")),
      "starting the fresh conversation must not be a rejected prompt",
    );
    assert.equal(store.runs.length, 2, "both real turns are Runs; the command is not");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
