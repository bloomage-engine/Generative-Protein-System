import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("builder config ships the host bundle and the next standalone tree", async () => {
  const text = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(text, /appId: ss\.hx-engine\.com/);
  assert.match(text, /productName: Science Studio/);
  assert.match(text, /files:\s*\n\s*- dist\/\*\*\/\*\s*\n\s*- build\/host\/\*\*\/\*/);
  assert.doesNotMatch(text, /from: build\/host/);
  assert.match(text, /asarUnpack:\s*\n\s*- node_modules\/@img\/\*\*/);
  assert.match(text, /from: \.\.\/web\/\.next\/standalone\s*\n\s*to: next/);
  assert.match(text, /to: next\/apps\/web\/\.next\/static/);
  assert.match(text, /to: next\/apps\/web\/public/);
  assert.match(text, /mac:\s*\n\s*target:\s*\n\s*- dmg/);
  assert.match(text, /linux:\s*\n\s*target:\s*\n\s*- AppImage\s*\n\s*- deb/);
  assert.match(text, /win:\s*\n\s*target:\s*\n\s*- target: nsis\s*\n\s*arch:\s*\n\s*- x64/);
  assert.match(text, /artifactName: science-studio_\$\{version\}_\$\{arch\}\.\$\{ext\}/);
  assert.match(text, /nsis:\s*\n\s*oneClick: false\s*\n\s*perMachine: false/);
});

test("the dsh SDK's protocol peer is a declared dependency", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const dsh = JSON.parse(
    await readFile(new URL("../../../packages/transport-dsh/package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.name, "@science-studio/desktop");
  assert.equal(dsh.dependencies["@deepseek-ai/dsh-sdk-protocol"], "0.1.5-alpha.1");
});
