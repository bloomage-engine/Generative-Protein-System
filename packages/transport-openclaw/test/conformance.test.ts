import {
  testAdapterLifecycle,
  testResolveSessionKey,
  testRuntimeFactory,
} from "@gps/contract-tests";
import { OpenClawRuntimeAdapter, createOpenClawRuntimeFactory, openClawBinding } from "../src/index.js";
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

/**
 * …and the SHARED session-key contract: openclaw collapses anything the gateway
 * does not namespace — the mount probe AND assistant-ui's local-mint ids — onto
 * ONE canonical session, so a probe and a send reconcile the same transcript.
 */
testResolveSessionKey("openclaw adapter session key", () => ({
  adapter: new OpenClawRuntimeAdapter(),
}));
