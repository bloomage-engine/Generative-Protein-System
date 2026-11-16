import { test } from "node:test";
import assert from "node:assert/strict";
import { electronLaunchOptions } from "../src/shared/electron-launch.js";

test("dev defaults to the local web server and keeps an explicit URL", () => {
  assert.equal(
    electronLaunchOptions({ dev: true, platform: "linux", env: {} }).env.DESKTOP_DEV_URL,
    "http://localhost:3000",
  );
  assert.equal(
    electronLaunchOptions({
      dev: true,
      platform: "linux",
      env: { DESKTOP_DEV_URL: "http://127.0.0.1:4000" },
    }).env.DESKTOP_DEV_URL,
    "http://127.0.0.1:4000",
  );
  assert.equal(
    electronLaunchOptions({ dev: false, platform: "linux", env: {} }).env.DESKTOP_DEV_URL,
    undefined,
  );
});

test("the no-sandbox default is Linux-only and an explicit flag list wins", () => {
  assert.deepEqual(electronLaunchOptions({ dev: false, platform: "linux", env: {} }).flags, [
    "--no-sandbox",
  ]);
  assert.deepEqual(electronLaunchOptions({ dev: false, platform: "win32", env: {} }).flags, []);
  assert.deepEqual(electronLaunchOptions({ dev: false, platform: "darwin", env: {} }).flags, []);
  assert.deepEqual(
    electronLaunchOptions({
      dev: false,
      platform: "win32",
      env: { DESKTOP_ELECTRON_FLAGS: "--disable-gpu --inspect=9229" },
    }).flags,
    ["--disable-gpu", "--inspect=9229"],
  );
  assert.deepEqual(
    electronLaunchOptions({
      dev: false,
      platform: "linux",
      env: { DESKTOP_ELECTRON_FLAGS: "" },
    }).flags,
    [],
  );
});
