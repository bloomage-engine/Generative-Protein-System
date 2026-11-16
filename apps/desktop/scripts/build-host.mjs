import { build } from "esbuild";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childPluginNames } from "./plugin-files.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");
const outDir = join(desktopRoot, "build", "host");
const childPluginDir = join(repoRoot, "packages", "transport-dsh", "dist");

const external = [
  "electron",
  "@deepseek-ai/dsh-sdk-client",
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-session",
  "dotenv",
];

if (!existsSync(childPluginDir)) {
  throw new Error(`missing ${childPluginDir}; run the root build before build:host`);
}
const plugins = childPluginNames(await readdir(childPluginDir));
if (plugins.length === 0) {
  throw new Error(`no *-plugin.js in ${childPluginDir}; run the root build before build:host`);
}

await build({
  entryPoints: [join(desktopRoot, "src", "server", "host-main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: join(outDir, "host.mjs"),
  external,
  banner: {
    js: "import { createRequire } from 'module'; process.argv[1]=''; const require = createRequire(import.meta.url);",
  },
});
for (const name of plugins) {
  await build({
    entryPoints: [join(childPluginDir, name)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: join(outDir, name),
  });
}
console.log(`[desktop] host bundle + ${plugins.length} child plugins -> ${outDir}`);
