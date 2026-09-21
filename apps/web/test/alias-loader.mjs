/**
 * Node ESM cannot resolve the app's `@/` alias — it is a TypeScript `paths`
 * mapping, known only to Next and tsc. This registers a SYNC resolve hook so
 * the Node tests can import app sources (like `store/studio-store.ts`, which
 * imports `@/lib/scope-memory`) exactly the way Next does, while the app code
 * keeps its canonical alias style.
 *
 * Load with `node --import ./test/alias-loader.mjs` (see `test:e2e`). Only
 * specifiers starting with `@/` are rewritten — resolved against this
 * package's root, trying the extensions a source tree uses; everything else
 * falls through to the default resolver untouched.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      for (const candidate of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}.js`]) {
        if (existsSync(`${root}/${candidate}`)) {
          return { url: pathToFileURL(`${root}/${candidate}`).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
