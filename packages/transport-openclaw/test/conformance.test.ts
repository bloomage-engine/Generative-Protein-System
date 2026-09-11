import { testAdapterLifecycle, testRuntimeFactory } from "@science-studio/contract-tests";
import { createOpenClawRuntimeFactory, openClawBinding } from "../src/index.js";
import { openClawLifecycleCase } from "./lifecycle-case.js";

/**
 * The openclaw package runs the SHARED runtime-factory contract, so the seam's
 * expectations are enforced here rather than only in the suite package.
 */
testRuntimeFactory("openclaw runtime factory", () => ({
  factory: createOpenClawRuntimeFactory(),
  validBinding: openClawBinding("ws://127.0.0.1:1", "token"),
  foreignBinding: { runtime: "dsh", config: {} },
}));

/**
 * …and the SHARED run-lifecycle contract, driven through the public
 * `RuntimeAdapter` surface with a scripted gateway (docs/adr/0005).
 */
testAdapterLifecycle("openclaw adapter lifecycle", openClawLifecycleCase);
