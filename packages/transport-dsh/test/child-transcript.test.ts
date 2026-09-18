import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { projectKey, readChildTranscript } from "../src/child-transcript.js";

// `zstdCompressSync` is present at runtime (Node >= 23.8) but not declared in
// this repo's pinned @types/node — reached the same way as the production module.
const zstdCompressSync = (zlib as unknown as {
  zstdCompressSync: (buf: string | Buffer) => Buffer;
}).zstdCompressSync;

const CHILD = "f625a7c7-8708-431e-a380-0a52729da6af";
const CWD = "/home/zhonghua/dsh-workspace/project-1";

function logLines(over: Array<Record<string, unknown>> = []): string[] {
  return [
    { type: "session", version: 3, id: CHILD, createdAt: 1789655889309, cwd: CWD, parentSession: "sess-1", isSeeded: false, origin: "subagent", delegationDepth: 1 },
    { type: "subagent/descriptor", seq: 0, time: 1789655889320, data: { version: 3, mode: "continuable", provider: "spawn", label: "收集足球类24小时体育新闻", agentProvider: "ollama-local", agentModel: "qwen3.8:latest" } },
    { type: "user/message", seq: 8, time: 1789655889575, data: { content: [{ type: "text", text: "收集足球新闻。" }] } },
    { type: "assistant/message", seq: 14, time: 1789655911253, data: { turn: 1, step: 1, message: { role: "assistant", id: "m-a1", content: [{ type: "reasoning", text: "plan" }, { type: "text", text: "我先查当前时间。" }] } } },
    { type: "tool/call", seq: 15, time: 1789655911258, data: { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: '{"command":"date"}' } },
    { type: "tool/result", seq: 16, time: 1789655911535, data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: "call-1" }, content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "Thu Sep 17 2026" }], isError: false }], role: "user", id: "m-tool-1" } } },
    { type: "turn/end", seq: 80, time: 1789656491505, data: { turn: 1, reason: { kind: "completed" } } },
    ...over,
  ].map((row) => JSON.stringify(row));
}

async function homeWith(logs: Array<{ name: string; text: string }>, cwd = CWD): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "dsh-child-transcript-"));
  const dir = join(home, "sessions", projectKey(cwd), CHILD);
  await mkdir(dir, { recursive: true });
  for (const { name, text } of logs) {
    await writeFile(join(dir, name), text, "utf8");
  }
  return home;
}

test("projectKey matches the harness's session-root directory encoding", () => {
  assert.equal(
    projectKey("/home/zhonghua/dsh-workspace/project-default"),
    "--home-zhonghua-dsh-workspace-project-default--",
  );
  assert.equal(projectKey("C:\\proj\\x"), "--C-proj-x--");
  assert.equal(projectKey("/a//b"), "--a-b--");
});

test("readChildTranscript folds a full child log into the seam shape", async () => {
  const home = await homeWith([
    { name: "session.v3.jsonl.zstd", text: "" },
  ]);
  // Overwrite with the real zstd payload (writeFile above just creates it).
  const dir = join(home, "sessions", projectKey(CWD), CHILD);
  await writeFile(join(dir, "session.v3.jsonl.zstd"), zstdCompressSync(logLines().join("\n")), "utf8");
  try {
    const t = await readChildTranscript({ home, cwd: CWD, sessionKey: "sess-1", childId: CHILD });
    assert.ok(t, "the record must be found");
    assert.equal(t!.id, CHILD);
    assert.equal(t!.parentId, "sess-1");
    assert.equal(t!.label, "收集足球类24小时体育新闻");
    assert.equal(t!.provider, "spawn");
    assert.equal(t!.agentProvider, "ollama-local");
    assert.equal(t!.agentModel, "qwen3.8:latest");
    assert.equal(t!.status, "completed");
    assert.equal(t!.startedAt, "2026-09-17T14:38:09.309Z");
    assert.equal(t!.finishedAt, "2026-09-17T14:48:11.505Z");

    const roles = t!.messages.map((m) => m.role);
    assert.deepEqual(roles, ["user", "assistant"], "user row, then ONE assistant row with the tool work merged");
    const assistant = t!.messages[1]!;
    const tool = assistant.parts.find((p) => p.type === "tool-call") as { type: "tool-call"; name: string; result?: string };
    assert.equal(tool.name, "bash");
    assert.equal(tool.result, "Thu Sep 17 2026", "the tool result merges into the call");
    assert.ok(assistant.parts.some((p) => p.type === "text" && p.text.includes("我先查当前时间。")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a newer format generation wins over an older one", async () => {
  const home = await homeWith([]);
  const dir = join(home, "sessions", projectKey(CWD), CHILD);
  await writeFile(join(dir, "session.v2.jsonl"), logLines([{ type: "turn/end", seq: 1, time: 1, data: { turn: 1, reason: { kind: "error", error: { message: "old" } } } }]).join("\n"), "utf8");
  await writeFile(join(dir, "session.v3.jsonl.zstd"), zstdCompressSync(logLines().join("\n")), "utf8");
  try {
    const t = await readChildTranscript({ home, cwd: CWD, sessionKey: "sess-1", childId: CHILD });
    assert.equal(t!.status, "completed", "v3 (newer) wins over v2");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("absences and malformed content all answer null, never throw", async () => {
  const cases = [
    readChildTranscript({ home: join(tmpdir(), "no-such-home"), cwd: CWD, sessionKey: "s", childId: CHILD }),
    readChildTranscript({ home: join(tmpdir(), "x"), cwd: CWD, sessionKey: "s", childId: "../escape" }),
  ];
  for (const p of cases) {
    assert.equal(await p, null);
  }
  // A home whose child dir exists but holds no session log.
  const home = await homeWith([{ name: "session.lock", text: "" }]);
  try {
    assert.equal(await readChildTranscript({ home, cwd: CWD, sessionKey: "s", childId: CHILD }), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  // A decodable log whose header names a DIFFERENT session is not this record.
  const other = ["{" + '"type":"session","id":"other",' + '"version":3,"createdAt":1,"cwd":"/x","delegationDepth":0,"isSeeded":false' + "}"].map((s) => s);
  const home2 = await homeWith([]);
  const dir = join(home2, "sessions", projectKey(CWD), CHILD);
  await writeFile(join(dir, "session.v3.jsonl"), other[0]!, "utf8");
  try {
    assert.equal(await readChildTranscript({ home: home2, cwd: CWD, sessionKey: "s", childId: CHILD }), null, "a header id mismatch is not this record");
  } finally {
    await rm(home2, { recursive: true, force: true });
  }
});
