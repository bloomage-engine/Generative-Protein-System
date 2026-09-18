/**
 * Conformance suite for `RuntimeFactory` + the `RuntimePlugin` export contract.
 *
 * A runtime package must: declare a non-empty id, declare boolean capabilities
 * that AGREE with what its adapter actually implements, construct an adapter
 * for its own binding, and REFUSE a binding belonging to another runtime. That
 * last one is what keeps a misconfigured deployment from silently connecting
 * the wrong runtime.
 *
 * `init()` is only exercised on the foreign binding, so the suite never opens a
 * network connection or spawns a harness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  RecordStoreLike,
  RuntimeBinding,
  RuntimeFactory,
} from "@science-studio/transport/seams";

const noopRecordStore: RecordStoreLike = {
  addRun: async () => {},
};

export interface RuntimeFactoryCase {
  factory: RuntimeFactory;
  /** A binding this runtime accepts (used for identity assertions only). */
  validBinding: RuntimeBinding;
  /** A binding for a DIFFERENT runtime; `init` must reject it. */
  foreignBinding: RuntimeBinding;
}

export function testRuntimeFactory(
  name: string,
  make: () => RuntimeFactoryCase | Promise<RuntimeFactoryCase>,
): void {
  test(`${name}: declares an identity and boolean capabilities`, async () => {
    const { factory } = await make();
    assert.equal(typeof factory.runtime, "string");
    assert.ok(factory.runtime.length > 0, "runtime id must be non-empty");
    for (const [key, value] of Object.entries(factory.capabilities)) {
      assert.equal(typeof value, "boolean", `capability "${key}" must be a boolean`);
    }
  });

  test(`${name}: creates an adapter for its own runtime`, async () => {
    const { factory, validBinding } = await make();
    const adapter = factory.create(validBinding);
    assert.equal(adapter.runtime, factory.runtime);
    assert.equal(typeof adapter.run, "function");
    assert.equal(typeof adapter.init, "function");
    assert.equal(typeof adapter.abort, "function");

    // The declared capability must match reality (the seam makes `approve`
    // optional, so `capabilities.approvals` is the ONLY thing a consumer may
    // branch on).
    assert.equal(
      factory.capabilities.approvals,
      typeof adapter.approve === "function",
      "capabilities.approvals must match whether the adapter implements approve()",
    );
    assert.equal(
      factory.capabilities.subagents,
      typeof adapter.subagents === "function",
      "capabilities.subagents must match whether the adapter implements subagents()",
    );
    assert.equal(
      factory.capabilities.subagentTranscript,
      typeof adapter.subagentTranscript === "function",
      "capabilities.subagentTranscript must match whether the adapter implements subagentTranscript()",
    );
  });

  test(`${name}: refuses a binding for another runtime`, async () => {
    const { factory, foreignBinding } = await make();
    const adapter = factory.create(foreignBinding);
    await assert.rejects(
      () => adapter.init({ binding: foreignBinding, recordStore: noopRecordStore, env: {} }),
      `init() must reject a ${foreignBinding.runtime} binding`,
    );
  });
}
