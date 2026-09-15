import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { detectDsh } from "../src/shared/dsh.js";

test("returns the first PATH entry containing an executable dsh", () => {
  const found = detectDsh({
    pathEnv: ["/none", "/opt/bin", "/usr/bin"].join(delimiter),
    access: (p) => {
      if (p !== join("/opt/bin", "dsh")) throw new Error("ENOENT");
    },
  });
  assert.equal(found, "/opt/bin/dsh");
});

test("returns null when no PATH entry has dsh", () => {
  assert.equal(detectDsh({ pathEnv: "/a:/b", access: () => { throw new Error("ENOENT"); } }), null);
});

test("returns null for an unset PATH", () => {
  const saved = process.env.PATH;
  delete process.env.PATH;
  try {
    assert.equal(detectDsh({ access: () => {} }), null);
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
});
