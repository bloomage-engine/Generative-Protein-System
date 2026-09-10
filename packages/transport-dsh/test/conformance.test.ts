import { testRuntimeFactory } from "@science-studio/contract-tests";
import { createDshRuntimeFactory, dshBinding } from "../src/index.js";

/**
 * The dsh package runs the SHARED runtime-factory contract, so the seam's
 * expectations are enforced here rather than only in the suite package.
 */
testRuntimeFactory("dsh runtime factory", () => ({
  factory: createDshRuntimeFactory(),
  validBinding: dshBinding(),
  foreignBinding: { runtime: "openclaw", config: { url: "ws://127.0.0.1:1", token: "" } },
}));
