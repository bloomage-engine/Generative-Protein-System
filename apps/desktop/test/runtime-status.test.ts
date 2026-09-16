import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeStatus } from "../src/shared/runtime-status.js";

test("reports ready when dsh is present", () => {
  assert.deepEqual(runtimeStatus({ dshPath: "/opt/bin/dsh" }), {
    dshPath: "/opt/bin/dsh",
    ready: true,
  });
});

test("is not ready when dsh is missing", () => {
  assert.deepEqual(runtimeStatus({ dshPath: null }), { dshPath: null, ready: false });
});
