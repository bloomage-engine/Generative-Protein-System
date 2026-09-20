#!/usr/bin/env node
// Install this plugin into the local OpenClaw gateway from an `npm pack`
// tarball.
//
// A directory install (`openclaw plugins install .`) copies the whole source
// tree — including node_modules — before doing anything, which is slow. The
// tarball honors `files`, is tiny, and with no runtime dependencies the gateway
// has nothing to npm-install.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "molql-tool-pack-"));

try {
  const packed = execFileSync("npm", ["pack", "--pack-destination", tmp], {
    cwd: pkg,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();
  const tarball = join(tmp, packed);
  execFileSync(
    "openclaw",
    ["plugins", "install", tarball, "--force", "--accept-capabilities"],
    { cwd: pkg, stdio: "inherit" },
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
