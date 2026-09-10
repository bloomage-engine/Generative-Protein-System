import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type RuntimeAdapter,
  type SessionState,
  type TransportCommand,
} from "@science-studio/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

/** Boot the service with a recording adapter and run one POST. */
async function postWithAdapter(
  adapter: RuntimeAdapter,
  body: unknown,
): Promise<void> {
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({ adapter, workspace: new NullWorkspace() }),
    cors: { origin: true },
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/transport`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    await res.text();
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

function recordingAdapter(seen: { commands: TransportCommand[] }): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* (_session: SessionState, commands: TransportCommand[]) {
      seen.commands = commands;
    },
    abort: () => {},
  };
}

const claimedState = { status: "idle", messages: {} };

test("a file part in a message becomes a workspace attachment", async () => {
  const seen = { commands: [] as TransportCommand[] };
  await postWithAdapter(recordingAdapter(seen), {
    commands: [
      {
        type: "add-message",
        message: {
          id: "u1",
          role: "user",
          parts: [
            { type: "text", text: "look at this" },
            {
              type: "file",
              path: "analysis/plot.png",
              name: "plot.png",
              mime: "image/png",
              size: 12,
              source: "workspace",
            },
          ],
        },
      },
    ],
    state: claimedState,
  });

  const command = seen.commands[0] as Extract<TransportCommand, { type: "add-message" }>;
  assert.equal(command.type, "add-message");
  assert.equal(command.message.content, "look at this");
  assert.deepEqual(command.message.attachments, [
    {
      kind: "workspace",
      path: "analysis/plot.png",
      name: "plot.png",
      mime: "image/png",
      size: 12,
    },
  ]);
});

test("an assistant-ui file part (filename/data) becomes an upload attachment", async () => {
  const seen = { commands: [] as TransportCommand[] };
  await postWithAdapter(recordingAdapter(seen), {
    commands: [
      {
        type: "add-message",
        message: {
          id: "u2",
          role: "user",
          parts: [
            { type: "text", text: "see attached" },
            { type: "file", filename: "notes.md", mimeType: "text/markdown", data: "IyBub3Rlcwo=" },
          ],
        },
      },
    ],
    state: claimedState,
  });

  const command = seen.commands[0] as Extract<TransportCommand, { type: "add-message" }>;
  assert.deepEqual(command.message.attachments, [
    {
      kind: "upload",
      name: "notes.md",
      mime: "text/markdown",
      data: "IyBub3Rlcwo=",
    },
  ]);
});

test("a text-only message carries no attachments key", async () => {
  const seen = { commands: [] as TransportCommand[] };
  await postWithAdapter(recordingAdapter(seen), {
    commands: [
      { type: "add-message", message: { id: "u3", role: "user", parts: [{ type: "text", text: "hi" }] } },
    ],
    state: claimedState,
  });

  const command = seen.commands[0] as Extract<TransportCommand, { type: "add-message" }>;
  assert.equal(command.message.content, "hi");
  assert.equal(command.message.attachments, undefined);
});
