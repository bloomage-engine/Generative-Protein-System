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
 */
export function isMainModule(
  entry: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
