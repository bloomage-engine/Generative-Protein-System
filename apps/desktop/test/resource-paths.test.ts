import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveResourcePaths } from "../src/main/resource-paths.js";

test("packaged resources live under resourcesPath", () => {
  const paths = resolveResourcePaths({
    isPackaged: true,
    resourcesPath: "/app/resources",
    appRoot: "/app/resources/app.asar",
  });
  assert.equal(paths.hostEntry, "/app/resources/host/host.mjs");
  assert.equal(paths.nextDir, "/app/resources/next/apps/web");
});

test("dev resources come from the build and the web app", () => {
  const paths = resolveResourcePaths({
    isPackaged: false,
    resourcesPath: "/unused",
    appRoot: "/repo/apps/desktop",
  });
  assert.equal(paths.hostEntry, "/repo/apps/desktop/build/host/host.mjs");
  assert.equal(paths.nextDir, "/repo/apps/web/.next/standalone/apps/web");
});
