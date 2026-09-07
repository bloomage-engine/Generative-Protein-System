/**
 * Dev smoke test for the openclaw runtime adapter.
 *
 * Connects to a live gateway (URL/token from services/transport-service/.env),
 * initializes the adapter and drives one `chat.send` against the default
 * session, printing every state delta.
 *
 * NOTE: this sends a real message to the configured session. Use
 * `SMOKE_SESSION` to point it at a scratch session instead of the default:
 *
 *   SMOKE_SESSION="agent:smoke:$(date +%s)" node scripts/smoke-openclaw-adapter.mjs
 *
 * Prereq: `npm run build` (the adapter is imported from dist).
 */
import { OpenClawRuntimeAdapter } from "../packages/transport-openclaw/dist/index.js";
import "dotenv/config";

const sessionId =
  process.env.SMOKE_SESSION ??
  process.env.OPENCLAW_DEFAULT_SESSION ??
  "agent:main:main";

const adapter = new OpenClawRuntimeAdapter();
try {
  await adapter.init({
    gateway: {
      url: process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789",
      token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
    },
    recordStore: {
      addRun: async () => {},
      addArtifact: async () => {},
    },
  });
  console.log("INIT OK");
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
