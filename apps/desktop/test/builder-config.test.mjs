import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("builder config ships the host bundle and the next standalone tree", async () => {
  const text = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(text, /appId: ss\.hx-engine\.com/);
  assert.match(text, /productName: Science Studio/);
  assert.match(text, /from: build\/host\s*\n\s*to: host/);
  assert.match(text, /from: \.\.\/web\/\.next\/standalone\s*\n\s*to: next/);
  assert.match(text, /to: next\/apps\/web\/\.next\/static/);
  assert.match(text, /to: next\/apps\/web\/public/);
});
