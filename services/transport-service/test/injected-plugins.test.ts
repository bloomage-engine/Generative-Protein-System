import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackend } from "../src/composition.js";
import type { RuntimePlugin } from "@science-studio/transport";

const stubPlugin: RuntimePlugin = {
  runtime: "dsh",
  factory: {
    runtime: "dsh",
    capabilities: {
      commandCatalog: false,
      remoteSettleWatch: false,
      tokenStreaming: false,
      approvals: false,
      hostedSandbox: false,
      perSessionCwd: false,
    },
    create: () => ({ runtime: "dsh", init: async () => {}, run: async function* () {} }) as never,
  },
  localBinding: () => ({ runtime: "dsh", config: {} }),
};

test("createBackend uses preloaded plugins instead of importing by specifier", async () => {
  const backend = await createBackend({ TRANSPORT_RUNTIME: "dsh", RECORD_STORE: "memory" }, [stubPlugin]);
  assert.ok(backend.environments);
  assert.equal(backend.capabilities?.approvals, false);
});

test("createBackend throws when the selected runtime has no preloaded plugin", async () => {
  await assert.rejects(
    () => createBackend({ TRANSPORT_RUNTIME: "nope", RECORD_STORE: "memory" }, [stubPlugin]),
    /no runtime plugin registered for "nope"/,
  );
});
