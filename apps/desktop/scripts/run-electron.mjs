import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronLaunchOptions } from "../dist/shared/electron-launch.js";

const require = createRequire(import.meta.url);
const electron = require("electron");
const appPath = join(dirname(fileURLToPath(import.meta.url)), "..");
const { flags, env } = electronLaunchOptions({ dev: process.argv.includes("--dev") });

const child = spawn(electron, [...flags, appPath], { stdio: "inherit", env });
child.on("error", (err) => {
  console.error("[desktop] failed to launch Electron", err);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
