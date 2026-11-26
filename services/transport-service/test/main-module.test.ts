import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "../src/main-module.js";

test("isMainModule compares real paths, so a URL-encoded path still matches", async () => {
  // Spaces and non-ASCII characters make `pathToFileURL` percent-encode the
  // URL while argv keeps the raw path — the Windows/path-with-spaces failure.
  const dir = await mkdtemp(join(tmpdir(), "gps main 入口-"));
  try {
    const entry = join(dir, "entry point.ts");
    await writeFile(entry, "");

    assert.equal(isMainModule(entry, pathToFileURL(entry).href), true);
    assert.equal(isMainModule(fileURLToPath(import.meta.url), import.meta.url), true);
    assert.equal(isMainModule(entry, pathToFileURL(join(dir, "other.ts")).href), false);
    assert.equal(isMainModule(undefined, pathToFileURL(entry).href), false);
    assert.equal(isMainModule(join(dir, "missing.ts"), pathToFileURL(entry).href), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
