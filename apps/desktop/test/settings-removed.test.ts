import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rendererDir = fileURLToPath(new URL("../src/renderer/", import.meta.url));

test("the standalone config window is retired", async () => {
  await assert.rejects(() => access(`${rendererDir}config.ts`));
  await assert.rejects(() => access(`${rendererDir}config.html`));
});
