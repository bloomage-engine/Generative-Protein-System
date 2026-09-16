import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
await mkdir(join(root, "dist", "renderer"), { recursive: true });
await cp(join(root, "src", "renderer", "config.html"), join(root, "dist", "renderer", "config.html"));
