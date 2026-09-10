import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultRuntimeModules } from "../src/composition.js";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { dependencies?: Record<string, string> };

/**
 * The default runtime list is DATA (package.json), not code: adding a runtime
 * must not edit the composition root. This pins the one invariant that keeps
 * that honest — every specifier the service loads by default must also be a
 * declared dependency, or the dynamic import cannot resolve.
 */
test("the default runtime modules are declared, installable dependencies", () => {
  const modules = defaultRuntimeModules();
  assert.ok(modules.length > 0, "the single-user default must name at least one runtime");

  const deps = Object.keys(pkg.dependencies ?? {});
  for (const specifier of modules) {
    assert.ok(
      deps.includes(specifier),
      `${specifier} is loaded by default but not declared in package.json dependencies`,
    );
  }
});
