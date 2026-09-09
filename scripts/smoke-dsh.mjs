/**
 * Dev smoke test for the dsh runtime adapter.
 *
 * Drives the REAL dsh harness: the adapter spawns `dsh --profile sdk` (via
 * @deepseek-ai/dsh-sdk-client) and runs one prompt on the default session,
 * printing every state delta.
 *
 * Needs a DeepSeek API key and launch env. It reads
 * `examples/transport-dsh-example/.env` when present (see its `.env.example`);
 * launch-only `DSH_*` keys are NOT allowed in that file, so DSH_HOME,
 * DSH_MODEL, DSH_DEFAULT_SESSION… come from the ambient process env
 * (export them). Point at a scratch conversation with `DSH_DEFAULT_SESSION`:
 *
 *   DSH_DEFAULT_SESSION="smoke-$(date +%s)" node scripts/smoke-dsh.mjs
 *
 * Prereq: `npm run build` (the adapter is imported from dist).
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: "examples/transport-dsh-example/.env", quiet: true });
import { DshRuntimeAdapter } from "../packages/transport-dsh/dist/index.js";

const sessionId = process.env.DSH_DEFAULT_SESSION ?? "default";

const adapter = new DshRuntimeAdapter();
const recordStore = {
  addRun: async () => {},
  addArtifact: async () => {},
};
await adapter.init({
  gateway: { url: "", token: "" },
  recordStore,
  config: { ...process.env },
});

console.log(`running one prompt on ${sessionId} (25s cap, then exit)...`);
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
