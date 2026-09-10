import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  SessionState,
  StateDelta,
  TransportCommand,
  Workspace,
} from "@science-studio/transport";
import { OpenClawRuntimeAdapter } from "../src/index.js";
import type { BackendGateway, BackendGatewayOptions } from "../src/connection.js";

const AGENT_ROOT = "/home/node/.openclaw/workspace";
const noopRecordStore = { addRun: async () => {}, addArtifact: async () => {} };

const stubWorkspace: Workspace = {
  list: async () => ({ path: "", entries: [] }),
  stat: async () => {
    throw new Error("not used");
  },
  open: async () => {
    throw new Error("not used");
  },
  toAgentPath: (relPath: string) => (relPath ? `${AGENT_ROOT}/${relPath}` : AGENT_ROOT),
  toWorkspacePath: () => null,
};

/**
 * Records every `chat.send` payload, then fails the send — failing ends the flow
 * (`run()` returns) without needing gateway events, and the captured payload is
 * exactly what the test asserts on.
 */
function recordingGateway(
  sent: Record<string, unknown>[],
): (opts: BackendGatewayOptions) => BackendGateway {
  return () => {
    const readyListeners = new Set<() => void>();
    return {
      connected: true,
      start: () => {
        for (const listener of readyListeners) listener();
      },
      stop: () => {},
      request: async (method: string, params?: unknown) => {
        if (method === "chat.history") return { sessionKey: "s", messages: [] };
        if (method === "chat.send") {
          sent.push((params ?? {}) as Record<string, unknown>);
          throw new Error("scripted stop");
        }
        throw new Error(`unexpected request: ${method}`);
      },
      onEvent: () => () => {},
      onReady: (listener) => {
        readyListeners.add(listener);
        return () => readyListeners.delete(listener);
      },
    };
  };
}

function freshSession(): SessionState {
  return {
    sessionId: "agent:main:main",
    studyId: "study-1",
    agentId: "main",
    status: "idle",
    messages: [],
  };
}

test("workspace attachments render into chat.send and become a file part on the user message", async () => {
  const sent: Record<string, unknown>[] = [];
  const adapter = new OpenClawRuntimeAdapter({ createGateway: recordingGateway(sent) });
  await adapter.init({
    binding: { runtime: "openclaw", config: { url: "ws://fake", token: "token" } },
    recordStore: noopRecordStore,
    workspace: stubWorkspace,
  });

  const commands: TransportCommand[] = [
    {
      type: "add-message",
      message: {
        id: "u1",
        role: "user",
        content: "look at this",
        attachments: [
          { kind: "workspace", path: "analysis/plot.png", name: "plot.png", mime: "image/png" },
        ],
      },
    },
  ];

  const deltas: StateDelta[] = [];
  for await (const delta of adapter.run(freshSession(), commands)) deltas.push(delta);

  assert.equal(sent.length, 1, "exactly one chat.send");
  assert.equal(
    sent[0]!.message,
    "look at this\n\nAttached files:\n- /home/node/.openclaw/workspace/analysis/plot.png (plot.png)",
    "the agent must receive the file's path as the AGENT sees it",
  );

  const userDelta = deltas.find(
    (delta): delta is Extract<StateDelta, { type: "add-message" }> =>
      delta.type === "add-message" && delta.message.id === "u1",
  );
  assert.ok(userDelta, "the user message must be echoed");
  assert.deepEqual(userDelta.message.parts, [
    { type: "text", text: "look at this" },
    { type: "file", path: "analysis/plot.png", name: "plot.png", mime: "image/png", source: "workspace" },
  ]);
});

test("a message without attachments sends its text verbatim", async () => {
  const sent: Record<string, unknown>[] = [];
  const adapter = new OpenClawRuntimeAdapter({ createGateway: recordingGateway(sent) });
  await adapter.init({
    binding: { runtime: "openclaw", config: { url: "ws://fake", token: "token" } },
    recordStore: noopRecordStore,
    workspace: stubWorkspace,
  });

  for await (const _ of adapter.run(freshSession(), [
    { type: "add-message", message: { id: "u2", role: "user", content: "plain text" } },
  ])) {
    /* drain */
  }

  assert.equal(sent[0]!.message, "plain text", "no attachment block may be appended");
});
