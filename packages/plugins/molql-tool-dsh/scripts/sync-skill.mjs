#!/usr/bin/env node
// Copy the canonical MolQL skill (packages/skills/molql) into this plugin under
// `skill/` so the published package is self-contained. The master is the single
// source of truth; run this before every build/publish.
import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "..", "skills", "molql");
const dest = join(here, "..", "skill");

await rm(dest, { recursive: true, force: true });
await cp(src, dest, { recursive: true });
console.log(`[molql-tool-dsh] synced skill: ${src} -> ${dest}`);
