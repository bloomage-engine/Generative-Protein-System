import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createInMemoryRecordStore } from "@science-studio/record";
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

/**
 * Science Studio owns the record (`docs/adr/0002`), so the `SessionState` a run
 * is driven with must come from the record layer rather than fabricated
 * constants (`study-1` / `main`). These tests pin that the service resolves the
 * Session from the store, mints it (and a default Study) on first use, and
 * reports the record's identity to the adapter.
 */
function capturingAdapter(seen: Partial<SessionState>): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* (session: SessionState, _commands: TransportCommand[]) {
      seen.sessionId = session.sessionId;
      seen.studyId = session.studyId;
      seen.agentId = session.agentId;
    },
    abort: () => {},
  };
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

async function postProbe(base: string, threadId: string): Promise<void> {
  const res = await fetch(`${base}/api/transport`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commands: [],
      state: { status: "idle", messages: {} },
      threadId,
    }),
  });
  assert.equal(res.status, 200);
  await res.text(); // drain; the probe terminates with [DONE]
}

test("a run is driven by the record's Session identity, minted on first use", async () => {
  const records = createInMemoryRecordStore();
  const seen: Partial<SessionState> = {};
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      adapter: capturingAdapter(seen),
      workspace: new NullWorkspace(),
    }),
    cors: { origin: true },
    records,
    sessionDefaults: {
      projectId: "proj-x",
      studyId: "study-x",
      agentBlueprintId: "bp-x",
    },
  };

  await withServer(backend, async (base) => {
    await postProbe(base, "sess-1");

    // The adapter saw the record's identity, not fabricated constants.
    assert.deepEqual(seen, { sessionId: "sess-1", studyId: "study-x", agentId: "bp-x" });

    // First use minted the Session and the default Study it hangs off.
    const session = await records.getSession("sess-1");
    assert.ok(session, "the Session row exists");
    assert.equal(session.studyId, "study-x");
    assert.equal(session.agentBlueprintId, "bp-x");

    const study = await records.getStudy("study-x");
    assert.ok(study, "the default Study row exists");
    assert.equal(study.projectId, "proj-x");
  });
});

test("a reused session key is not reminted, and falls back to the default identity", async () => {
  const records = createInMemoryRecordStore();
  const seen: Partial<SessionState> = {};
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      adapter: capturingAdapter(seen),
      workspace: new NullWorkspace(),
    }),
    cors: { origin: true },
    records,
  };

  await withServer(backend, async (base) => {
    await postProbe(base, "sess-default");
    assert.deepEqual(seen, {
      sessionId: "sess-default",
      studyId: "study-default",
      agentId: "main",
    });

    const before = await records.getSession("sess-default");
    await postProbe(base, "sess-default");
    const after = await records.getSession("sess-default");
    assert.deepEqual(after, before, "a second use returns the same Session row");
  });
});
