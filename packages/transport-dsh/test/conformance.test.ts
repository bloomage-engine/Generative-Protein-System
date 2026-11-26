import {
  testAdapterLifecycle,
  testResolveSessionKey,
  testRuntimeFactory,
  testSubagents,
} from "@gps/contract-tests";
import { createDshRuntimeFactory, dshBinding, DshRuntimeAdapter } from "../src/index.js";
import { dshLifecycleCase } from "./lifecycle-case.js";

/**
 * The dsh package runs the SHARED runtime-factory contract, so the seam's
 * expectations are enforced here rather than only in the suite package.
 */
testRuntimeFactory("dsh runtime factory", () => ({
  factory: createDshRuntimeFactory(),
  validBinding: dshBinding(),
  foreignBinding: { runtime: "openclaw", config: { url: "ws://127.0.0.1:1", token: "" } },
}));

/**
 * …and the SHARED run-lifecycle contract, driven through the public
 * `RuntimeAdapter` surface with a scripted turn client (docs/adr/0005).
 */
testAdapterLifecycle("dsh adapter lifecycle", dshLifecycleCase);

/**
 * …and the SHARED session-key contract: an unclaimed session (the mount probe)
 * and assistant-ui's `__LOCALID_*` ids must converge on ONE stable canonical
 * key, so a probe and a send reconcile the same transcript. The adapter is
 * built exactly as sessionkey.test.ts builds one (no env override), and dsh's
 * own policy values live there.
 */
testResolveSessionKey("dsh adapter session key", () => ({ adapter: new DshRuntimeAdapter() }));

/**
 * …and the SHARED optional subagent surface: an advertised capability must be a
 * real method that always answers an array (dsh implements it live-only).
 */
testSubagents("dsh adapter subagents", () => ({
  adapter: new DshRuntimeAdapter(),
  sessionKey: "sess-1",
}));
