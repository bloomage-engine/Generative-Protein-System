import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createInMemoryRecordStore } from "@gps/record";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type RuntimeAdapter,
  type SessionState,
  type TransportCommand,
} from "@gps/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

/**
 * Generative Protein System owns the record (`docs/adr/0002`), so the `SessionState` a run
 * is driven with must come from the record layer rather than fabricated
 * constants. These tests pin that the service resolves the Session from the
 * store, files it under a Project (explicitly named, or the default one), and
 * reports the record's identity to the adapter.
 */
function capturingAdapter(seen: Partial<SessionState>): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* (session: SessionState, _commands: TransportCommand[]) {
      seen.sessionId = session.sessionId;
      seen.projectId = session.projectId;
      seen.agentId = session.agentId;
    },
    abort: () => {},
  };
}

function localEnv(adapter: RuntimeAdapter): LocalEnvironmentProvider {
  return new LocalEnvironmentProvider({
    environmentFor: async () => ({ adapter, workspace: new NullWorkspace() }),
  });
}

async function withServer(backend: Backend, fn: (base: string) => Promise<void>): Promise<void> {
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

async function postProbe(
  base: string,
  threadId: string,
  projectId?: string,
): Promise<void> {
  const res = await fetch(`${base}/api/transport`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commands: [],
      state: { status: "idle", messages: {} },
      threadId,
      ...(projectId ? { projectId } : {}),
    }),
  });
  assert.equal(res.status, 200);
  await res.text(); // drain; the probe terminates with [DONE]
}

test("a run is driven by the record's Session identity, filed under the named Project", async () => {
  const records = createInMemoryRecordStore();
  const seen: Partial<SessionState> = {};
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: localEnv(capturingAdapter(seen)),
    cors: { origin: true },
    records,
    recordDefaults: {
      projectId: "proj-x",
      projectName: "Project X",
      agentId: "bp-x",
    },
  };

  await withServer(backend, async (base) => {
    await postProbe(base, "sess-1");

    // The adapter saw the record's identity, not fabricated constants.
    assert.deepEqual(seen, { sessionId: "sess-1", projectId: "proj-x", agentId: "bp-x" });

    // First use minted the Session under the (auto-ensured) Project.
    const session = await records.getSession("sess-1");
    assert.ok(session, "the Session row exists");
    assert.equal(session.projectId, "proj-x");
    assert.equal(session.agentId, "bp-x");

    const project = await records.getProject("proj-x");
    assert.ok(project, "the Project row exists");
  });
});

test("a reused session key is not reminted, and falls back to the default Project", async () => {
  const records = createInMemoryRecordStore();
  const seen: Partial<SessionState> = {};
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: localEnv(capturingAdapter(seen)),
    cors: { origin: true },
    records,
  };

  await withServer(backend, async (base) => {
    await postProbe(base, "sess-default");
    assert.deepEqual(seen, {
      sessionId: "sess-default",
      projectId: "project-default",
      agentId: "main",
    });

    const before = await records.getSession("sess-default");
    await postProbe(base, "sess-default");
    const after = await records.getSession("sess-default");
    assert.deepEqual(after, before, "a second use returns the same Session row");
  });
});
