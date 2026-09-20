#!/usr/bin/env node
// Bundle src/index.ts into dist/index.js.
//
// `typebox` is a pure-JS schema builder, so it is inlined into the bundle and
// the plugin declares NO runtime dependencies. That makes `openclaw plugins
// install` skip its "Installing plugin dependencies…" npm step, which is slow
// and registry-flaky. `openclaw/*` stays external — the gateway links its own
// copy into the installed plugin.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const root = join(here, "..", "..", "..", "..");

await build({
  entryPoints: [join(pkg, "src", "index.ts")],
  outfile: join(pkg, "dist", "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["openclaw", "openclaw/*"],
  sourcemap: true,
  logLevel: "info",
});
