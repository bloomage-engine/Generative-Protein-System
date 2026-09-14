/**
 * Dev smoke test for the openclaw runtime adapter.
 *
 * Connects to a live gateway (URL/token from `services/transport-service/.env`,
 * or the ambient env), initializes the adapter through the same launch surface
 * the service uses (`openClawLocalBinding`) and drives one `chat.send` against
 * the default session, printing every state delta.
 *
 * NOTE: this sends a real message to the configured session. Use
 * `SMOKE_SESSION` to point it at a scratch session instead of the default — but
 * the id must name a CONFIGURED agent (the gateway answers `INVALID_REQUEST`
 * `Agent "<id>" no longer exists in configuration` otherwise):
 *
 *   SMOKE_SESSION="agent:main:smoke-$(date +%s)" node scripts/smoke-openclaw-adapter.mjs
 *
 * Prereq: `npm run build` (the adapter is imported from dist).
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: "services/transport-service/.env", quiet: true });
import { OpenClawRuntimeAdapter, openClawLocalBinding } from "../packages/transport-openclaw/dist/index.js";

const sessionId =
  process.env.SMOKE_SESSION ??
  process.env.OPENCLAW_DEFAULT_SESSION ??
  "agent:main:main";

const binding = openClawLocalBinding(process.env);
const adapter = new OpenClawRuntimeAdapter();
try {
  await adapter.init({
    binding,
    recordStore: {
      addRun: async () => {},
      addArtifact: async () => {},
    },
    env: { ...process.env },
  });
  console.log(`INIT OK (gateway ${String(binding.config.url)})`);
} catch (e) {
  console.log("INIT THREW", String(e));
}

console.log(`calling run on ${sessionId} (8s cap, then exit)...`);
const timeout = setTimeout(() => {
  console.log("TIMEOUT: run still pending (hang, no crash)");
  process.exit(0);
}, 8000);
try {
  const iter = adapter.run(
    { sessionId, studyId: "s", agentId: "main", status: "idle", messages: [] },
    [{ type: "add-message", message: { id: "m1", role: "user", content: "hi" } }],
  );
  for await (const d of iter) {
    console.log("DELTA", JSON.stringify(d).slice(0, 120));
  }
  clearTimeout(timeout);
} catch (e) {
  console.log("RUN THREW", String(e));
  clearTimeout(timeout);
}
console.log("done");
process.exit(0);
