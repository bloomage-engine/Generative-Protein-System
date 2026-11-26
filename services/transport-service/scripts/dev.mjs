import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
const defaults = {
  DSH_PROVIDER: "ollama-local",
  DSH_MODEL: "qwen3.8:latest",
  DSH_WORKSPACE: join(homedir(), "workspace", "dsh-workspace"),
  DSH_DEFAULT_SESSION: "gps",
};
for (const [key, value] of Object.entries(defaults)) {
  if (!env[key]) env[key] = value;
}
if (process.argv.includes("--dsh")) env.TRANSPORT_RUNTIME = "dsh";

const child = spawn(process.execPath, ["--import", "tsx", join(root, "src", "index.ts")], {
  cwd: root,
  stdio: "inherit",
  env,
});
child.on("error", (err) => {
  console.error("[transport-service] failed to start", err);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
