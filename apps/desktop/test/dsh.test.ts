import { test } from "node:test";
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { detectDsh } from "../src/shared/dsh.js";

const file = { isFile: () => true };
const missing = () => {
  throw new Error("ENOENT");
};

test("returns the first PATH entry containing an executable dsh", () => {
  const found = detectDsh({
    pathEnv: ["/none", "/opt/bin", "/usr/bin"].join(posix.delimiter),
    stat: (p) => (p === posix.join("/opt/bin", "dsh") ? file : missing()),
    access: () => {},
  });
  assert.equal(found, "/opt/bin/dsh");
});

test("rejects a directory named dsh", () => {
  const found = detectDsh({
    pathEnv: "/opt/bin",
    stat: () => ({ isFile: () => false }),
    access: () => {},
  });
  assert.equal(found, null);
});

test("rejects a dsh that is not executable", () => {
  const found = detectDsh({
    pathEnv: "/opt/bin",
    stat: () => file,
    access: () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(found, null);
});

test("resolves a win32 PATH with semicolons and backslashes", () => {
  const found = detectDsh({
    platform: "win32",
    pathEnv: ["C:\\none", "C:\\Program Files\\dsh"].join(win32.delimiter),
    stat: (p) => (p === win32.join("C:\\Program Files\\dsh", "dsh.cmd") ? file : missing()),
    access: () => {
      throw new Error("executable bit is meaningless on win32");
    },
  });
  assert.equal(found, "C:\\Program Files\\dsh\\dsh.cmd");
});

test("returns null when no PATH entry has dsh", () => {
  assert.equal(detectDsh({ pathEnv: "/a:/b", stat: missing, access: missing }), null);
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
