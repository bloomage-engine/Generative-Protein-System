/**
 * Dev tool: replay recorded assistant-transport SSE frames through the same
 * decoder + accumulator the browser uses.
 *
 * Use it to verify a captured stream (e.g. the output of a curl against
 * /api/transport) folds into the expected client state and terminates with
 * [DONE] without throwing (the client accumulator rejects any op that is not
 * `set`):
 *
 *   curl -sN -X POST http://localhost:3001/api/transport ... > /tmp/frames.txt
 *   node scripts/replay-sse-frames.mjs /tmp/frames.txt
 */
import {
  AssistantTransportDecoder,
  AssistantMessageAccumulator,
  unstable_createInitialMessage,
} from "assistant-stream";
import { readFileSync } from "node:fs";

const frames = readFileSync(process.argv[2], "utf8");

const encoder = new TextEncoder();
const src = new ReadableStream({
  start(c) {
    c.enqueue(encoder.encode(frames));
    c.close();
  },
});

const initialState = { status: "idle", messages: {} };
const accumulator = new AssistantMessageAccumulator({
  initialMessage: unstable_createInitialMessage({ unstable_state: initialState }),
  strict: true,
});

const out = [];
const stream = src.pipeThrough(new AssistantTransportDecoder()).pipeThrough(accumulator);
let err = null;
try {
  for await (const chunk of stream) {
    out.push(chunk);
    const st = chunk.metadata.unstable_state;
    console.log("unstable_state:", JSON.stringify(st).slice(0, 200));
  }
  console.log("STREAM OK, chunks:", out.length);
} catch (e) {
  err = e;
  console.log("STREAM FAILED:", e.message);
}
console.log("final state:", JSON.stringify(out.at(-1)?.metadata.unstable_state ?? (err ? "UNREACHED" : "?")));
