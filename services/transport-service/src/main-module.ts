import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Is this module the process entry point?
 *
 * The naive `import.meta.url === \`file://${process.argv[1]}\`` comparison
 * breaks whenever the two representations differ: Windows drive paths, a
 * checkout path with spaces or non-ASCII characters (the URL is percent-
 * encoded), or a symlinked clone (Node may keep the URL's path while argv holds
 * the invoked path). Both sides are therefore resolved to real filesystem
 * paths first.
 *
 * `moduleUrl` is deliberately required: `import.meta.url` must be the CALLER's
 * URL. A default parameter would capture this helper module's own URL, making
 * the comparison always fail.
 */
export function isMainModule(entry: string | undefined, moduleUrl: string): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
