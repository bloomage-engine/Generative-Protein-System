import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackend } from "../src/composition.js";
import type { RuntimePlugin } from "@gps/transport";

const stubPlugin: RuntimePlugin = {
  runtime: "stub-runtime",
  factory: {
    runtime: "stub-runtime",
    capabilities: {
      commandCatalog: false,
      remoteSettleWatch: false,
      tokenStreaming: false,
      approvals: false,
      hostedSandbox: false,
      perSessionCwd: false,
      subagents: false,
      subagentTranscript: false,
      mcp: false,
    },
    create: () =>
      ({ runtime: "stub-runtime", init: async () => {}, run: async function* () {} }) as never,
  },
  localBinding: () => ({ runtime: "stub-runtime", config: {} }),
};

test("createBackend uses preloaded plugins instead of importing by specifier", async () => {
  const backend = await createBackend(
    { TRANSPORT_RUNTIME: "stub-runtime", RECORD_STORE: "memory" },
    [stubPlugin],
  );
  assert.ok(backend.environments);
  assert.equal(
    backend.capabilities?.commandCatalog,
    false,
    "the injected plugin's capabilities must be used (the real openclaw/dsh plugins cannot produce commandCatalog:false)",
  );
});

test("createBackend falls back to dynamic resolution when no plugins are preloaded", async () => {
  const backend = await createBackend(
    { TRANSPORT_RUNTIME: "dsh", RECORD_STORE: "memory" },
    [],
  );
  assert.ok(backend.environments);
  assert.equal(
    backend.capabilities?.commandCatalog,
    true,
    "an empty preloaded list must fall back to the real dsh plugin, whose commandCatalog is true (the stub's is false)",
  );
});

test("createBackend throws when the selected runtime has no preloaded plugin", async () => {
  await assert.rejects(
    () => createBackend({ TRANSPORT_RUNTIME: "nope", RECORD_STORE: "memory" }, [stubPlugin]),
    /no runtime plugin registered for "nope" \(available: stub-runtime\)/,
  );
});
