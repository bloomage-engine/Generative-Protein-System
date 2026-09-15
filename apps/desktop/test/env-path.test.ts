import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { augmentPath } from "../src/shared/env-path.js";

test("appends the common GUI install directories", () => {
  const out = augmentPath("/usr/bin", "/home/me");
  assert.equal(
    out,
    ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", join("/home/me", ".local", "bin"), join("/home/me", "bin")].join(
      delimiter,
    ),
  );
});

test("preserves the existing order and dedupes", () => {
  const existing = ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"].join(delimiter);
  const out = augmentPath(existing, "/home/me");
  assert.equal(
    out,
    ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", join("/home/me", ".local", "bin"), join("/home/me", "bin")].join(
      delimiter,
    ),
  );
});

test("an unset PATH becomes the appended list", () => {
  assert.equal(augmentPath(undefined, "/home/me"), ["/usr/local/bin", "/opt/homebrew/bin", join("/home/me", ".local", "bin"), join("/home/me", "bin")].join(delimiter));
});

test("win32 is a no-op", () => {
  assert.equal(augmentPath("/a;/b", "C:\\Users\\me", "win32"), "/a;/b");
  assert.equal(augmentPath(undefined, "C:\\Users\\me", "win32"), "");
});
