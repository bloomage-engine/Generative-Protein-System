/**
 * Dev smoke test for the dsh runtime adapter.
 *
 * Drives the REAL dsh harness: the adapter spawns `dsh --profile sdk` (via
 * @deepseek-ai/dsh-sdk-client) and runs one prompt on the default session,
 * printing every state delta. It initializes the adapter through the same
 * launch surface the service uses (`dshLocalBinding` over the process env).
 *
 * Needs the route's credential and the launch env. It reads
 * `examples/transport-dsh-example/.env` when present (see its `.env.example`);
 * launch-only `DSH_*` keys are NOT allowed in that file, so the route
 * (`DSH_PROVIDER`/`DSH_MODEL`), the workspace (`DSH_WORKSPACE`) and
 * `DSH_DEFAULT_SESSION` come from the ambient process env (export them). Unset,
 * the adapter falls back to `deepseek-official`/`deepseek-v4-flash` with the
 * key the loaded `.env` supplies. Point at a scratch conversation with
 * `DSH_DEFAULT_SESSION`:
 *
 *   DSH_PROVIDER=ollama-local DSH_MODEL=qwen3.8:latest \
 *   DSH_DEFAULT_SESSION="smoke-$(date +%s)" node scripts/smoke-dsh.mjs
 *
 * Prereq: `npm run build` (the adapter is imported from dist).
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: "examples/transport-dsh-example/.env", quiet: true });
import { DshRuntimeAdapter, dshLocalBinding } from "../packages/transport-dsh/dist/index.js";

const sessionId = process.env.DSH_DEFAULT_SESSION ?? "default";
const binding = dshLocalBinding(process.env);

const adapter = new DshRuntimeAdapter();
await adapter.init({
  binding,
  recordStore: {
    addRun: async () => {},
    addArtifact: async () => {},
  },
  env: { ...process.env },
});

const route =
  typeof binding.config.provider === "string" ? binding.config.provider : "deepseek-official";
const model =
  typeof binding.config.model === "string" ? binding.config.model : "deepseek-v4-flash";
const cwd =
  typeof binding.config.workspace === "string" ? binding.config.workspace : process.cwd();
console.log(`running one prompt on ${sessionId} · ${route}/${model} · cwd ${cwd} (25s cap, then exit)...`);
const cap = setTimeout(() => {
  console.log("TIMEOUT: turn still pending (harness busy / model unreachable)");
  adapter.abort();
}, 25_000);
try {
  const iter = adapter.run(
    { sessionId, studyId: "s", agentId: "main", status: "idle", messages: [] },
    [{ type: "add-message", message: { id: "m1", role: "user", content: "hi" } }],
  );
  for await (const delta of iter) {
    console.log("DELTA", JSON.stringify(delta).slice(0, 160));
  }
  clearTimeout(cap);
  console.log("run settled");
} catch (e) {
  console.log("RUN THREW", String(e));
  clearTimeout(cap);
}
process.exit(0);
