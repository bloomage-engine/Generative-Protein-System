/**
 * Live-gateway verification for runtime slash commands (docs/adr/0003).
 *
 * Connects to a live gateway (URL/token from services/transport-service/.env)
 * and answers the runtime-behavior questions that static code cannot:
 *
 *   ① Does a "/command" sent via `chat.send` land in `chat.history` (as a user
 *      row + assistant reply)? — verifies the A1 "commands are ordinary rows"
 *      convergence assumption.
 *   ② Does `commands.list` reflect enabled/disabled config & authorization?
 *      (drives the curation filter decision)
 *   ③ What event stream / runId does an instant command (`/status`) produce?
 *   ④ What does an unknown "/command" return?
 *
 * Defaults to sending "/status". Point at a scratch session with SMOKE_SESSION
 * to avoid touching the default conversation; set VERIFY_UNKNOWN=1 to also run
 * an unknown command. Prereq: `npm run build`.
 */
import { createBackendGateway } from "../packages/transport-openclaw/dist/connection.js";
import "dotenv/config";

const url = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
const sessionKey =
  process.env.SMOKE_SESSION ?? process.env.OPENCLAW_DEFAULT_SESSION ?? "agent:main:main";
const commandText = process.env.VERIFY_COMMAND ?? "/status";
const WINDOW_MS = 8000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const gw = createBackendGateway({
  url,
  token,
  version: "0.0.0",
  scopes: ["operator.read", "operator.write", "operator.approvals"],
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("gateway not ready within 15s")), 15_000);
  timer.unref?.();
  gw.onReady(() => {
    clearTimeout(timer);
    resolve();
  });
  gw.start();
});
console.log("CONNECT OK", sessionKey);

// --- ② raw catalog vs the v1 allowlist -------------------------------------
const raw = await gw.request("commands.list", { includeArgs: true });
const names = Array.isArray(raw?.commands) ? raw.commands.map((c) => c.name) : [];
const allowlist = [
  "model", "think", "fast", "reasoning", "verbose", "trace", "elevated",
  "status", "tools", "help", "whoami", "context",
];
console.log(
  `commands.list: ${names.length} total; allowlisted present: ${
    allowlist.filter((n) => names.includes(n)).join(", ") || "(none)"
  }; config-gated present: ${
    ["debug", "plugins", "tts", "config"].filter((n) => names.includes(n)).join(", ") || "(none)"
  }`,
);

/** Send `text`, then capture chat/agent frames for the resulting run. */
async function drive(text, seconds = WINDOW_MS) {
  const res = await gw.request("chat.send", {
    sessionKey,
    message: text,
    idempotencyKey: `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    queueMode: "followup",
  });
  const runId = res?.runId;
  console.log(`\nsent ${JSON.stringify(text)} -> runId=${runId ?? "(none)"} status=${res?.status}`);
  if (!runId) return;

  const frames = [];
  const off = gw.onEvent((frame) => {
    const p = (frame.payload ?? {}) ?? {};
    if (p.sessionKey !== sessionKey) return;
    if (frame.event === "chat" && p.runId === runId) frames.push(frame);
    if (frame.event === "agent" && p.runId === runId) frames.push(frame);
  });
  const deadline = Date.now() + seconds;
  while (Date.now() < deadline) {
    const terminal = frames.find((f) =>
      ["final", "aborted", "error"].includes(f.payload?.state),
    );
    if (terminal) break;
    await sleep(100);
  }
  off();
  for (const f of frames) {
    const p = f.payload ?? {};
    const brief =
      p.state === "delta"
        ? `delta deltaText=${JSON.stringify(p.deltaText)}`
        : p.state ?? f.event;
    console.log(`  frame ${f.event} ${JSON.stringify(brief).slice(0, 160)}`);
  }
  const last = frames[frames.length - 1];
  console.log(
    `  stream: ${frames.length} frames, terminal=${
      last ? (last.payload?.state ?? "none") : "TIMEOUT (no chat events)"
    }`,
  );
  return runId;
}

// --- ① history before / after ----------------------------------------------
const before = await gw.request("chat.history", { sessionKey });
console.log(`history before: ${before?.messages?.length ?? 0} rows`);

await drive(commandText);

const after = await gw.request("chat.history", { sessionKey });
const rows = after?.messages ?? [];
console.log(`history after: ${rows.length} rows`);
for (const m of rows.slice(-3)) {
  const text = Array.isArray(m.content)
    ? m.content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("")
    : typeof m.content === "string"
      ? m.content
      : m.text ?? "";
  console.log(`  row ${m.role} ${JSON.stringify(String(text).slice(0, 80))} id=${m.id}`);
}

// --- ④ unknown command ------------------------------------------------------
if (process.env.VERIFY_UNKNOWN === "1") {
  await drive("/__no_such_command_verification__");
}

gw.stop();
console.log("\ndone");
process.exit(0);
