/**
 * Regression check: does the assistant-ui client state mark an in-flight
 * tool-call / reasoning part as `running`?
 *
 * Guards a past bug: the transport converter in packages/transport-client/src/converter.ts did
 * not pass the session running flag into `toThreadMessages`, so assistant-ui
 * auto-status never produced `running` — reasoning shimmer and tool-call
 * spinners never appeared and the tool card popped in already-looking-finished
 * (worse: a message holding a result-less tool-call was auto-classified
 * `requires-action`).
 *
 * Replays a realistic openclaw run (user msg → thinking stream → tool start →
 * tool result → text → done) through the browser's pipeline: wire state frames
 * → the transport converter callback (mirror of transport.tsx) → assistant-ui
 * convertExternalMessages + toMessagePartStatus.
 *
 * Run: node scripts/check-running-part-status.mjs   (green when fixed)
 *      node scripts/check-running-part-status.mjs --legacy  (red: pre-fix path)
 * NOTE: imports assistant-ui internals by node_modules path; if an upgrade
 * breaks the path, update the two imports below.
 */
import { convertExternalMessages } from "../node_modules/@assistant-ui/core/dist/runtime/utils/external-message-conversion.js";
import { toMessagePartStatus } from "../node_modules/@assistant-ui/core/dist/utils/normalizePartStatus.js";

// --- converter callback: byte-for-byte mirror of packages/transport-client/src/converter.ts ---
function tryParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function toArgs(value) {
  const parsed = tryParse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}
function partToContent(part) {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return { type: "reasoning", text: part.text };
    case "tool-call": {
      const base = {
        type: "tool-call",
        toolCallId: part.id,
        toolName: part.name,
        args: toArgs(part.args),
        argsText: part.args,
      };
      if (part.result !== undefined) return { ...base, result: part.result };
      if (part.isError) return { ...base, isError: true };
      return base;
    }
    case "artifact":
      return { type: "text", text: `[artifact: ${part.name}]` };
    default:
      return null;
  }
}
const converterCallback = (message) => ({
  role: message.role,
  content: message.parts.map(partToContent),
});

// --- realistic frames of one run ---
const user = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] };
const assistant = { id: "r1", role: "assistant", parts: [] };

const F = {
  reasoningStreaming: {
    status: "running",
    messages: [user, { ...assistant, parts: [{ type: "reasoning", text: "thinking slowly…" }] }],
  },
  toolExecuting: {
    status: "running",
    messages: [
      user,
      {
        ...assistant,
        parts: [
          { type: "reasoning", text: "thinking slowly…" },
          { type: "tool-call", id: "t1", name: "web_search", args: "{\"q\":\"x\"}" },
        ],
      },
    ],
  },
  toolDone: {
    status: "running",
    messages: [
      user,
      {
        ...assistant,
        parts: [
          { type: "reasoning", text: "thinking slowly…" },
          { type: "tool-call", id: "t1", name: "web_search", args: "{\"q\":\"x\"}", result: "hits" },
        ],
      },
    ],
  },
  final: {
    status: "idle",
    messages: [
      user,
      {
        ...assistant,
        parts: [
          { type: "reasoning", text: "thinking slowly…" },
          { type: "tool-call", id: "t1", name: "web_search", args: "{\"q\":\"x\"}", result: "hits" },
          { type: "text", text: "Here is the answer." },
        ],
      },
    ],
  },
};

function computePass(isRunning) {
  const rows = [];
  for (const [label, frame] of Object.entries(F)) {
    const msgs = convertExternalMessages(frame.messages, converterCallback, isRunning, {});
    const a = msgs.find((m) => m.role === "assistant");
    const partRows = a.content.map((p, i) => ({
      type: p.type,
      key: p.toolCallId ?? p.type,
      resultSet: p.result !== undefined,
      status: toMessagePartStatus(a, i, p).type,
    }));
    rows.push({ label, messageStatus: a.status.type, parts: partRows });
  }
  return rows;
}

const red = (label, cond) => {
  const mark = cond ? "PASS" : "RED";
  console.log(`  [${mark}] ${label}`);
  return cond;
};

const run = (name, isRunning) => {
  console.log(`\n=== converter pass: ${name} (isRunning=${isRunning}) ===`);
  const rows = computePass(isRunning);
  for (const r of rows) {
    console.log(`  stage ${r.label}: message.status=${r.messageStatus}`);
    for (const p of r.parts) {
      console.log(`    part ${p.type}(${p.key}) resultSet=${p.resultSet} → status=${p.status}`);
    }
  }
  const reasoningStage = rows.find((r) => r.label === "reasoningStreaming");
  const toolStage = rows.find((r) => r.label === "toolExecuting");
  const reasoningRunning =
    reasoningStage.parts.find((p) => p.type === "reasoning")?.status === "running";
  const toolRunning =
    toolStage.parts.find((p) => p.type === "tool-call" && !p.resultSet)?.status === "running";
  const verdict =
    red("reasoning part is 'running' while the model is thinking", reasoningRunning) &&
    red("tool-call part (no result yet) is 'running' while it executes", toolRunning);
  console.log(verdict ? "  => GREEN (running animation possible)" : "  => RED (bug reproduced: no running state ever reaches the UI)");
  return verdict;
};

const legacy = process.argv.includes("--legacy");
const green = run("transport.tsx converter", !legacy);
// --legacy reproduces the pre-fix call (isRunning never forwarded) and must be red.
process.exitCode = green ? 0 : 1;
