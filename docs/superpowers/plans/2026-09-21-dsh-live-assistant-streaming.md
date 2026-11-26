# dsh Live Assistant Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream dsh assistant output (reasoning, text, tool calls) to the workbench token-by-token while a step is still running, instead of dumping it in one burst at step commit.

**Architecture:** The harness child's process-local `agent/assistant-stream` frames are forwarded by the existing child-side bridge plugin over a streaming NDJSON route on the private bridge socket. The adapter's bridge client holds that stream and hands each `{sessionId, frame}` to the dsh `SessionBehavior`, which maps frames to the shared `StateDelta` ops and emits them into the active `RunControl`. The durable `assistant/message` event remains authoritative and finalizes the row.

**Tech Stack:** TypeScript (ESM, `tsc -b`), Node `node:http`/`node:test`, `@deepseek-ai/dsh-*` 0.1.5-alpha.1, `@gps/transport`.

## Global Constraints

- ADR-0022 is the spec: `docs/adr/0022-dsh-live-assistant-streaming.md`. Every decision there binds this plan.
- Artifacts (code comments, docs, commit messages) are English; conversation is Chinese.
- `packages/transport-dsh/src/bridge-plugin.ts` is loaded INTO the harness child: it must stay dependency-free (no runtime import of `@deepseek-ai/*`, no runtime import of a module that imports `@gps/transport`) and must NEVER write to stdout.
- Live streaming is best-effort: a missing bridge or a dead stream must degrade silently to the existing step-granular behavior. No new failure mode may escape a run.
- The durable `assistant/message` remains authoritative; live content is overwritten by `contentToParts(message.content)` at settlement.
- No `remove-message` seam op. The live row id is deterministic and reused on retry.
- Tests are type-checked by `tsconfig.tests.json` (root `npm run build` last step).
- Do NOT commit unless the user explicitly asks. The commit steps below are the intended checkpoints; confirm with the user before running any of them.

---

### Task 1: `stream-reasoning` seam delta

**Files:**
- Modify: `packages/transport/src/types.ts` (add the variant after `stream-text`, around line 101)
- Modify: `packages/transport/src/fold.ts` (add a `case` after `stream-text`, around line 123)
- Test: `packages/transport/test/fold.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `StateDelta` variant `{ type: "stream-reasoning"; messageId: Id; text: string; replace?: boolean }`, folded to a `text-appended` (or `text-set` with `replace`) effect on the trailing `reasoning` part, or to a new `reasoning` part via `parts-set`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/transport/test/fold.test.ts` (after the `stream-text` tests, around line 122):

```ts
test("stream-reasoning appends to a reasoning tail", () => {
  const s = state([{ id: "m1", role: "assistant", parts: [{ type: "reasoning", text: "th" }] }]);
  const effects = foldState(s, { type: "stream-reasoning", messageId: "m1", text: "ink" });
  assert.deepEqual(effects, [{ type: "text-appended", messageId: "m1", partIndex: 0, appended: "ink" }]);
  assert.deepEqual(s.messages[0]!.parts, [{ type: "reasoning", text: "think" }]);
});

test("stream-reasoning with replace overwrites a reasoning tail", () => {
  const s = state([{ id: "m1", role: "assistant", parts: [{ type: "reasoning", text: "old" }] }]);
  const effects = foldState(s, { type: "stream-reasoning", messageId: "m1", text: "fresh", replace: true });
  assert.deepEqual(effects, [{ type: "text-set", messageId: "m1", partIndex: 0, text: "fresh" }]);
  assert.deepEqual(s.messages[0]!.parts, [{ type: "reasoning", text: "fresh" }]);
});

test("stream-reasoning on a non-reasoning tail (or no tail) starts a new reasoning part", () => {
  const withText = state([{ id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }] }]);
  const effects = foldState(withText, { type: "stream-reasoning", messageId: "m1", text: "why" });
  assert.deepEqual(effects, [{ type: "parts-set", messageId: "m1" }]);
  assert.deepEqual(withText.messages[0]!.parts, [
    { type: "text", text: "hi" },
    { type: "reasoning", text: "why" },
  ]);

  const empty = state([{ id: "m1", role: "assistant", parts: [] }]);
  foldState(empty, { type: "stream-reasoning", messageId: "m1", text: "x", replace: true });
  assert.deepEqual(empty.messages[0]!.parts, [{ type: "reasoning", text: "x" }]);
});

test("stream-reasoning on an unknown message is dropped", () => {
  const s = state([{ id: "m1", role: "assistant", parts: [] }]);
  assert.deepEqual(foldState(s, { type: "stream-reasoning", messageId: "ghost", text: "x" }), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @gps/transport`
Expected: FAIL (`stream-reasoning` is not a known StateDelta / no effect).

- [ ] **Step 3: Add the variant to `StateDelta`**

In `packages/transport/src/types.ts`, immediately after the `stream-text` variant (before `set-part-text`):

```ts
  | {
      /**
       * A streaming reasoning fragment: append to (or, with `replace`,
       * replace) the message's trailing reasoning part. The reasoning twin of
       * `stream-text`, kept separate because `stream-text` only grows a `text`
       * part — a cumulative `set-part-text` stream would be O(n²) in the
       * reasoning length (docs/adr/0022).
       */
      type: "stream-reasoning";
      messageId: Id;
      text: string;
      replace?: boolean;
    }
```

- [ ] **Step 4: Fold it**

In `packages/transport/src/fold.ts`, add a `case` immediately after the `stream-text` case (before `set-part-text`):

```ts
    case "stream-reasoning": {
      const msg = findMessage(state.messages, delta.messageId);
      if (!msg) return [];
      const idx = msg.parts.length - 1;
      const last = idx >= 0 ? msg.parts[idx] : undefined;
      if (last && last.type === "reasoning") {
        msg.parts[idx] = {
          ...last,
          text: delta.replace ? delta.text : (last.text ?? "") + delta.text,
        };
        return delta.replace
          ? [{ type: "text-set", messageId: msg.id, partIndex: idx, text: delta.text }]
          : [{ type: "text-appended", messageId: msg.id, partIndex: idx, appended: delta.text }];
      }
      msg.parts.push({ type: "reasoning", text: delta.text });
      return [{ type: "parts-set", messageId: msg.id }];
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @gps/transport`
Expected: PASS (all existing fold tests plus the four new ones).

- [ ] **Step 6: Commit** (only with the user's go-ahead)

```bash
git add packages/transport/src/types.ts packages/transport/src/fold.ts packages/transport/test/fold.test.ts
git commit -m "feat(transport): add the stream-reasoning delta"
```

---

### Task 2: The pure live-frame mapper

> **AMENDED during execution (user decision):** tool calls stream instead of
> appearing only at `block-end`. The first `tool-call-delta` emits `add-part`
> with the accumulated args, later deltas emit `update-message` with a COPY of
> the full `parts` array, and `block-end` applies the authoritative
> `{id,name,args}` only when it changes them. `LiveAssistantMessage` therefore
> keeps a `parts` mirror in sync with `foldState`'s trailing-part rule for text
> and reasoning too. See `packages/transport-dsh/src/assistant-stream.ts` and
> `docs/adr/0022-dsh-live-assistant-streaming.md`; the code/test blocks below
> describe the original (block-end-only) version.

**Files:**
- Create: `packages/transport-dsh/src/assistant-stream.ts`
- Test: `packages/transport-dsh/test/assistant-stream.test.ts`

**Interfaces:**
- Consumes: `StateDelta` from `@gps/transport`; the `stream-reasoning` op from Task 1.
- Produces: `AssistantStreamFrame`, `DshAssistantStreamMessage`, `LiveStreamChunk`, and `class LiveAssistantMessage` with `begin()`, `reset()`, `accept(chunk: LiveStreamChunk)`. `LiveAssistantMessage` emits through its constructor's `emit(delta)` callback.

- [ ] **Step 1: Write the failing test**

Create `packages/transport-dsh/test/assistant-stream.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StateDelta } from "@gps/transport";
import { LiveAssistantMessage } from "../src/assistant-stream.js";

function collect(): { emit: (delta: StateDelta) => void; deltas: StateDelta[] } {
  const deltas: StateDelta[] = [];
  return { emit: (delta) => void deltas.push(delta), deltas };
}

test("begin creates an empty row and reset clears its parts", () => {
  const { emit, deltas } = collect();
  const live = new LiveAssistantMessage("s:1:1", emit);
  live.begin();
  live.reset();
  assert.deepEqual(deltas, [
    { type: "add-message", message: { id: "s:1:1", role: "assistant", parts: [] } },
    { type: "update-message", messageId: "s:1:1", patch: { parts: [] } },
  ]);
});

test("a reasoning block streams via stream-reasoning, a text block via stream-text", () => {
  const { emit, deltas } = collect();
  const live = new LiveAssistantMessage("s:1:1", emit);
  live.accept({ type: "block-start", index: 0, blockType: "reasoning" });
  live.accept({ type: "reasoning-delta", index: 0, text: "th" });
  live.accept({ type: "reasoning-delta", index: 0, text: "ink" });
  live.accept({ type: "block-end", index: 0 });
  live.accept({ type: "block-start", index: 1, blockType: "text" });
  live.accept({ type: "text-delta", index: 1, text: "hi" });
  assert.deepEqual(deltas, [
    { type: "stream-reasoning", messageId: "s:1:1", text: "th" },
    { type: "stream-reasoning", messageId: "s:1:1", text: "ink" },
    { type: "stream-text", messageId: "s:1:1", text: "hi" },
  ]);
});

test("a tool-call block adds one complete tool-call part at block-end", () => {
  const { emit, deltas } = collect();
  const live = new LiveAssistantMessage("s:1:1", emit);
  live.accept({ type: "block-start", index: 0, blockType: "tool-call" });
  live.accept({ type: "tool-call-delta", index: 0, id: "tc-1", name: "fs.read", argumentsDelta: '{"pa' });
  live.accept({ type: "tool-call-delta", index: 0, id: "tc-1", argumentsDelta: 'th":"a"}' });
  live.accept({
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id: "tc-1", name: "fs.read", arguments: '{"path":"a"}' },
  });
  assert.deepEqual(deltas, [
    {
      type: "add-part",
      messageId: "s:1:1",
      part: { type: "tool-call", id: "tc-1", name: "fs.read", args: '{"path":"a"}' },
    },
  ]);
});

test("usage and finish chunks are ignored; a delta with no matching block is a no-op", () => {
  const { emit, deltas } = collect();
  const live = new LiveAssistantMessage("s:1:1", emit);
  live.accept({ type: "text-delta", index: 0, text: "stray" });
  live.accept({ type: "usage" });
  live.accept({ type: "finish" });
  assert.deepEqual(deltas, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @gps/transport-dsh`
Expected: FAIL (`../src/assistant-stream.js` does not exist).

- [ ] **Step 3: Implement the mapper**

Create `packages/transport-dsh/src/assistant-stream.ts`:

```ts
/**
 * Pure, adapter-side support for the dsh child's LIVE assistant stream.
 *
 * The harness publishes a process-local `agent/assistant-stream` event
 * (start / chunk / end) for every `StreamChunk`; the child-side bridge plugin
 * forwards them over its private socket (`bridge-plugin.ts`). This module owns
 * the frame vocabulary and the state machine that turns one attempt's chunks
 * into the shared `StateDelta` ops — unit-tested without a runtime.
 *
 * The durable `assistant/message` event stays authoritative: a
 * {@link LiveAssistantMessage} only decides WHEN parts appear, and the
 * committed event overwrites the row's parts with `contentToParts(...)` at
 * settlement (`behavior.ts`, docs/adr/0022).
 */
import type { StateDelta } from "@gps/transport";

/** One forwarded frame's dsh-llm `StreamChunk` fields, read structurally. */
export interface LiveStreamChunk {
  type?: string;
  index?: number;
  blockType?: string;
  text?: string;
  id?: string;
  name?: string;
  argumentsDelta?: string;
  /** `block-end` carries the assembled block. */
  block?: { type?: string; text?: string; id?: string; name?: string; arguments?: string };
}

/**
 * One process-local `agent/assistant-stream` frame, as the bridge forwards it.
 * `sessionId` rides the envelope (the plugin adds it from `agent.session.id`),
 * not the dsh frame itself.
 */
export interface AssistantStreamFrame {
  type: "start" | "chunk" | "end";
  attemptId?: string;
  revision?: number;
  turn?: number;
  step?: number;
  index?: number;
  time?: number;
  chunk?: LiveStreamChunk;
  /** `end` carries the durable settlement (or abandonment) of the attempt. */
  outcome?: { kind?: string; eventType?: string; seq?: number };
}

/** One forwarded envelope: the harness session id plus its frame. */
export interface DshAssistantStreamMessage {
  sessionId: string;
  frame: AssistantStreamFrame;
}

type BlockKind = "none" | "text" | "reasoning" | "tool-call";

/**
 * One live assistant row under construction. It emits only shared
 * `StateDelta` ops (folded by `foldState`, streamed by the wire) and keeps a
 * local block model so reasoning and text stream into the RIGHT part: the
 * `stream-*` ops grow the trailing part of their own kind, so a block change
 * naturally starts a new part.
 *
 * The caller owns the row's lifecycle: `begin()` on the FIRST start frame of a
 * `(session, turn, step)`, `reset()` on a later one (a retried attempt reuses
 * the row), and the durable `assistant/message` finalizes it.
 */
export class LiveAssistantMessage {
  private kind: BlockKind = "none";
  private tool: { id: string; name: string; args: string } | null = null;

  constructor(
    readonly messageId: string,
    private readonly emit: (delta: StateDelta) => void,
  ) {}

  /** The row does not exist yet: create it empty. */
  begin(): void {
    this.resetState();
    this.emit({ type: "add-message", message: { id: this.messageId, role: "assistant", parts: [] } });
  }

  /** The row already exists (a retried attempt): clear its parts and rebuild. */
  reset(): void {
    this.resetState();
    this.emit({ type: "update-message", messageId: this.messageId, patch: { parts: [] } });
  }

  private resetState(): void {
    this.kind = "none";
    this.tool = null;
  }

  /** Map one `StreamChunk`, ignoring block/usage/finish chunks it has no rendering for. */
  accept(chunk: LiveStreamChunk): void {
    switch (chunk.type) {
      case "block-start":
        this.kind =
          chunk.blockType === "reasoning"
            ? "reasoning"
            : chunk.blockType === "text"
              ? "text"
              : chunk.blockType === "tool-call"
                ? "tool-call"
                : "none";
        if (this.kind === "tool-call") this.tool = null;
        return;
      case "text-delta":
        if (this.kind === "text" && typeof chunk.text === "string") {
          this.emit({ type: "stream-text", messageId: this.messageId, text: chunk.text });
        }
        return;
      case "reasoning-delta":
        if (this.kind === "reasoning" && typeof chunk.text === "string") {
          this.emit({ type: "stream-reasoning", messageId: this.messageId, text: chunk.text });
        }
        return;
      case "tool-call-delta": {
        if (this.kind !== "tool-call") return;
        if (this.tool === null) {
          this.tool = {
            id: typeof chunk.id === "string" ? chunk.id : "",
            name: typeof chunk.name === "string" ? chunk.name : "",
            args: "",
          };
        } else if (typeof chunk.name === "string" && chunk.name !== "") {
          this.tool.name = chunk.name;
        }
        if (typeof chunk.argumentsDelta === "string") this.tool.args += chunk.argumentsDelta;
        return;
      }
      case "block-end": {
        const block = chunk.block;
        if (this.kind === "tool-call" && block?.type === "tool-call") {
          this.emit({
            type: "add-part",
            messageId: this.messageId,
            part: {
              type: "tool-call",
              id: this.tool?.id || (typeof block.id === "string" ? block.id : ""),
              name: this.tool?.name || (typeof block.name === "string" ? block.name : ""),
              args: typeof block.arguments === "string" ? block.arguments : (this.tool?.args ?? ""),
            },
          });
          this.tool = null;
        }
        this.kind = "none";
        return;
      }
      default:
        return;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @gps/transport-dsh`
Expected: PASS (the new file's four tests pass; existing tests still pass).

- [ ] **Step 5: Commit** (only with the user's go-ahead)

```bash
git add packages/transport-dsh/src/assistant-stream.ts packages/transport-dsh/test/assistant-stream.test.ts
git commit -m "feat(dsh): pure live assistant-frame mapper"
```

---

### Task 3: The streaming wire — child route and adapter client

**Files:**
- Modify: `packages/transport-dsh/src/bridge-plugin.ts`
- Modify: `packages/transport-dsh/src/bridge.ts`
- Test: `packages/transport-dsh/test/bridge-plugin.test.ts`

**Interfaces:**
- Consumes: the `agent/assistant-stream` event payload `{ agent, frame }` from the harness child; `DshAssistantStreamMessage` from Task 2.
- Produces: `GET /assistant-stream`, an NDJSON response whose lines are `{"sessionId": string, "frame": object}`; the exported structural types `BridgeAssistantStreamFrame`, `BridgeAssistantStreamPayload`, `BridgeStreamAgent`; a second `on?` overload on `BridgeHost`; and `DshCommandBridge.subscribeAssistantStream?(listener: (message: DshAssistantStreamMessage) => void): () => void`.

> The plugin route and the adapter client are one wire pair and are implemented
> together: the end-to-end test drives them against each other over a real
> socket, so neither half is independently testable.

- [ ] **Step 1: Write the failing test (and update the fake host first)**

In `packages/transport-dsh/test/bridge-plugin.test.ts`, replace the `fakeHost` return's `on` implementation and add a `stream` accessor. Move the two listener types to module scope (above `fakeHost`) and add `stream` to the declared return type:

```ts
type PreStepListener = (
  payload: BridgePreStepPayload,
  next: () => Promise<BridgePreStepDecision>,
) => Promise<BridgePreStepDecision>;
type StreamListener = (payload: BridgeAssistantStreamPayload) => void;
```

Then, inside `fakeHost`, replace:

```ts
  let preStep: Parameters<NonNullable<BridgeHost["on"]>>[1] | undefined;
```

with:

```ts
  const preStepListeners: PreStepListener[] = [];
  const streamListeners: StreamListener[] = [];
```

and add `stream: () => StreamListener | undefined;` to the function's declared return type object (after `preStep:`), so it reads:

```ts
): {
  ctx: BridgeHost;
  effects: () => number;
  executions: () => string[];
  preStep: () => PreStepListener | undefined;
  stream: () => StreamListener | undefined;
  dispose: () => void;
} {
```

Replace the `on:` property with:

```ts
    on: ((event: string, listener: (...args: unknown[]) => unknown) => {
      const bucket = event === "agent/assistant-stream" ? streamListeners : preStepListeners;
      bucket.push(listener as never);
      return () => {
        const index = bucket.indexOf(listener as never);
        if (index >= 0) bucket.splice(index, 1);
      };
    }) as unknown as NonNullable<BridgeHost["on"]>,
```

Replace the returned `preStep` accessor with:

```ts
    preStep: () => preStepListeners[0],
    stream: () => streamListeners[0],
```

Update the import list at the top of the file to add the new types:

```ts
import {
  apply,
  type BridgeAssistantStreamPayload,
  type BridgeCommandDescriptor,
  type BridgeHost,
  type BridgePreStepDecision,
  type BridgePreStepPayload,
} from "../src/bridge-plugin.js";
```

Then append this test to the file:

```ts
test("the child forwards live assistant frames as NDJSON over the bridge socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bridge-"));
  const socket = join(dir, "b.sock");
  const host = fakeHost(DESCRIPTORS, new Map([["sess-1", { id: "sess-1" }]]));
  try {
    apply(host.ctx, { socket });
    await waitForPath(socket);
    const messages: { sessionId: string; frame: unknown }[] = [];
    const close = createCommandBridge(socket).subscribeAssistantStream!((message) => messages.push(message));
    // The plugin registers its listener when the adapter's GET arrives.
    await delay(50);

    const listener = host.stream();
    assert.ok(listener, "the plugin registers an agent/assistant-stream listener");
    listener({
      agent: { session: { id: "sess-1" } },
      frame: {
        type: "chunk",
        attemptId: "sess-1:1",
        revision: 3,
        turn: 1,
        step: 1,
        index: 0,
        chunk: { type: "text-delta", index: 0, text: "hi" },
      },
    });
    // A frame with no session id is dropped, not forwarded.
    listener({ agent: {}, frame: { type: "start" } });

    await delay(50);
    assert.deepEqual(messages, [
      {
        sessionId: "sess-1",
        frame: {
          type: "chunk",
          attemptId: "sess-1:1",
          revision: 3,
          turn: 1,
          step: 1,
          index: 0,
          chunk: { type: "text-delta", index: 0, text: "hi" },
        },
      },
    ]);

    close();
    await delay(50);
    // After the client closes, the plugin disposes its listener.
    assert.equal(host.stream(), undefined);
  } finally {
    host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @gps/transport-dsh`
Expected: FAIL (`subscribeAssistantStream` is not a function / route 404s).

- [ ] **Step 3: Add the structural types and the second `on` overload**

In `packages/transport-dsh/src/bridge-plugin.ts`, after `BridgePreStepDecision` add:

```ts
/** Structural view of the agent an `agent/assistant-stream` frame belongs to. */
export interface BridgeStreamAgent {
  session?: { id?: unknown };
}

/** One live assistant frame, read structurally (the child owns the real shape). */
export interface BridgeAssistantStreamFrame {
  type: "start" | "chunk" | "end";
  attemptId?: string;
  revision?: number;
  turn?: number;
  step?: number;
  index?: number;
  time?: number;
  chunk?: unknown;
  outcome?: unknown;
}

/** The `agent/assistant-stream` payload the forwarder reads. */
export interface BridgeAssistantStreamPayload {
  agent: BridgeStreamAgent;
  frame: BridgeAssistantStreamFrame;
}
```

Then replace the `on?` declaration inside `BridgeHost`:

```ts
  /**
   * The `agent/pre-step` waterfall (optional: a harness that moved it must
   * degrade to "no interception" rather than failing the child's boot).
   */
  on?(
    event: "agent/pre-step",
    listener: (
      payload: BridgePreStepPayload,
      next: () => Promise<BridgePreStepDecision>,
    ) => Promise<BridgePreStepDecision>,
  ): () => void;
  /**
   * The process-local `agent/assistant-stream` publication (optional, same
   * fail-soft rule). A host-scope listener receives every agent's frames.
   */
  on?(
    event: "agent/assistant-stream",
    listener: (payload: BridgeAssistantStreamPayload) => void,
    options?: { global?: boolean },
  ): () => void;
```

- [ ] **Step 4: Add the streaming route**

Add `streamAssistant` before `dispatch`:

```ts
/**
 * `GET /assistant-stream` — hold the connection open and write one NDJSON line
 * per live assistant frame, `{ sessionId, frame }`. The listener is registered
 * when the client connects and disposed on disconnect; a subsystem without the
 * event surface answers 503 so the adapter falls back to step granularity.
 */
function streamAssistant(ctx: BridgeHost, res: ServerResponse): void {
  if (typeof ctx.on !== "function") {
    send(res, 503, { status: "unavailable", message: "no event surface" });
    return;
  }
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let off: (() => void) | null = null;
  const cleanup = (): void => {
    const fn = off;
    off = null;
    try {
      fn?.();
    } catch {
      // already disposed
    }
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
  try {
    off = ctx.on(
      "agent/assistant-stream",
      ({ agent, frame }) => {
        const sessionId = agent?.session?.id;
        if (typeof sessionId !== "string" || sessionId === "") return;
        try {
          res.write(`${JSON.stringify({ sessionId, frame })}\n`);
        } catch (err) {
          warn("assistant-stream write failed", err);
          cleanup();
        }
      },
      { global: true },
    );
  } catch (err) {
    warn("assistant-stream subscription unavailable", err);
    cleanup();
    if (!res.writableEnded) res.end();
  }
}
```

Add the route to `dispatch`, before the final `send(res, 404, ...)`:

```ts
  if (req.method === "GET" && path === "/assistant-stream") {
    streamAssistant(ctx, res);
    return;
  }
```

- [ ] **Step 5: Add the adapter-side stream client**

In `packages/transport-dsh/src/bridge.ts`, add the type import near the top:

```ts
import type { DshAssistantStreamMessage } from "./assistant-stream.js";
```

Add to the `DshCommandBridge` interface:

```ts
  /**
   * Open the child's live assistant-frame stream (`GET /assistant-stream`) and
   * invoke `listener` for each forwarded frame. Returns a close handle. The
   * connection is re-established if the child restarts mid-watch; a missing or
   * failing bridge simply never calls the listener (best-effort — docs/adr/0022).
   */
  subscribeAssistantStream?(listener: (message: DshAssistantStreamMessage) => void): () => void;
```

Add these module-level pieces before `createCommandBridge`:

```ts
/** Reconnect delay when the streaming watch loses the child. */
const STREAM_RETRY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * One connection to `GET /assistant-stream`, resolving when the child closes
 * or the response errors. Lines are NDJSON; a malformed line is skipped.
 */
async function pumpAssistantStream(
  endpoint: string,
  listener: (message: DshAssistantStreamMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: endpoint, path: "/assistant-stream", method: "GET", signal });
    req.on("error", reject);
    req.on("response", (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET /assistant-stream answered ${res.statusCode}`));
        return;
      }
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line === "") continue;
          try {
            const parsed = JSON.parse(line) as DshAssistantStreamMessage;
            if (typeof parsed?.sessionId === "string" && parsed.frame !== undefined) listener(parsed);
          } catch {
            // a malformed line is not fatal to the watch
          }
        }
      });
      res.on("end", () => resolve());
      res.on("error", reject);
    });
    req.end();
  });
}
```

Inside `createCommandBridge`, add the method to the returned object:

```ts
    subscribeAssistantStream(listener: (message: DshAssistantStreamMessage) => void): () => void {
      const controller = new AbortController();
      let closed = false;
      const watch = async (): Promise<void> => {
        while (!closed) {
          try {
            await pumpAssistantStream(endpoint, listener, controller.signal);
          } catch {
            // the child is gone or restarting: retry while this watch is wanted
          }
          if (closed) return;
          await sleep(STREAM_RETRY_MS);
        }
      };
      void watch();
      return () => {
        closed = true;
        controller.abort();
      };
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w @gps/transport-dsh`
Expected: PASS (the streaming test plus the existing bridge tests).

- [ ] **Step 7: Commit** (only with the user's go-ahead)

```bash
git add packages/transport-dsh/src/bridge-plugin.ts packages/transport-dsh/src/bridge.ts packages/transport-dsh/test/bridge-plugin.test.ts
git commit -m "feat(dsh): forward live assistant frames over the bridge socket"
```

---

### Task 4: Route live frames into the active Run

**Files:**
- Modify: `packages/transport-dsh/src/behavior.ts`
- Test: `packages/transport-dsh/test/behavior.test.ts`

**Interfaces:**
- Consumes: `LiveAssistantMessage`, `AssistantStreamFrame`, `DshAssistantStreamMessage` from Task 2; `run.emit(delta)` and `RunControl` from the kit.
- Produces: `interface DshBehavior extends SessionBehavior<SessionEvent> { ingestAssistantStream(message: DshAssistantStreamMessage): void }`; `createDshBehavior(...)` now returns `DshBehavior`.

- [ ] **Step 1: Write the failing test**

In `packages/transport-dsh/test/behavior.test.ts`, extend `fakeRun` to collect deltas. Replace the `fakeRun` function with:

```ts
function fakeRun(): {
  control: RunControl<SessionEvent>;
  notes: { status?: string; usage?: unknown }[];
  deltas: StateDelta[];
} {
  const notes: { status?: string; usage?: unknown }[] = [];
  const deltas: StateDelta[] = [];
  const control: RunControl<SessionEvent> = {
    targetRunId: null,
    ingest: () => {},
    emit: (delta) => void deltas.push(delta),
    note: (meta) => void notes.push(meta),
    settle: () => {},
    abort: () => {},
  };
  return { control, notes, deltas };
}
```

Add `StateDelta` and `foldState` to the imports from `@gps/transport`:

```ts
import {
  createApplyContext,
  foldState,
  type ApplyContext,
  type RunControl,
  type SessionState,
  type SettleContext,
  type StateDelta,
} from "@gps/transport";
```

Then add this import beside the existing `../src/behavior.js` import:

```ts
import type { AssistantStreamFrame } from "../src/assistant-stream.js";
```

Then append these tests:

```ts
test("live frames create the row and stream reasoning, text and a tool call", () => {
  const state = freshState();
  const run = fakeRun();
  const harnessSessions = new Map<string, string>();
  const client: DshTurnClient = {
    start: async () => {},
    close: async () => {},
    runTurn: (_sessionId, _text, _onEvent) => new Promise<void>(() => {}),
  };
  const b = behavior({ client, harnessSessions });
  b.dispatch?.({ sessionKey: "sess-1", messages: [{ id: "u1", content: "hi" }] }, run.control);
  const harnessId = harnessSessions.get("sess-1");
  assert.ok(harnessId, "dispatch mints and publishes the harness id before the turn runs");

  const frame = (next: AssistantStreamFrame): void =>
    b.ingestAssistantStream({
      sessionId: harnessId,
      frame: { turn: 1, step: 1, ...next },
    });
  frame({ type: "start", attemptId: "a1" });
  frame({ type: "chunk", chunk: { type: "block-start", index: 0, blockType: "reasoning" } });
  frame({ type: "chunk", chunk: { type: "reasoning-delta", index: 0, text: "think" } });
  frame({ type: "chunk", chunk: { type: "block-start", index: 1, blockType: "text" } });
  frame({ type: "chunk", chunk: { type: "text-delta", index: 1, text: "hi" } });
  frame({ type: "chunk", chunk: { type: "block-start", index: 2, blockType: "tool-call" } });
  frame({
    type: "chunk",
    chunk: { type: "block-end", index: 2, block: { type: "tool-call", id: "tc-1", name: "fs.read", arguments: "{}" } },
  });

  const folded = createApplyContext<SessionEvent>(state);
  for (const delta of run.deltas) folded.emit(delta);

  assert.deepEqual(
    state.messages.map((m) => m.id),
    ["sess-1:1:1"],
  );
  assert.deepEqual(
    state.messages[0]!.parts.map((p) => p.type),
    ["reasoning", "text", "tool-call"],
  );
});

test("the durable assistant/message finalizes the live row and keeps its id", () => {
  const state = freshState();
  const run = fakeRun();
  const harnessSessions = new Map<string, string>();
  const client: DshTurnClient = {
    start: async () => {},
    close: async () => {},
    runTurn: (_sessionId, _text, _onEvent) => new Promise<void>(() => {}),
  };
  const b = behavior({ client, harnessSessions });
  b.dispatch?.({ sessionKey: "sess-1", messages: [{ id: "u1", content: "hi" }] }, run.control);
  const harnessId = harnessSessions.get("sess-1")!;
  b.ingestAssistantStream({ sessionId: harnessId, frame: { type: "start", turn: 1, step: 1 } });
  b.ingestAssistantStream({
    sessionId: harnessId,
    frame: { type: "chunk", turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "text" } },
  });
  b.ingestAssistantStream({
    sessionId: harnessId,
    frame: { type: "chunk", turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "hi" } },
  });
  const ctx = makeCtx(state);
  for (const delta of run.deltas) ctx.emit(delta);

  b.apply?.(
    ev("assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "am1",
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
        source: { kind: "model" },
      },
    }),
    ctx,
  );
  assert.deepEqual(
    state.messages.map((m) => m.id),
    ["sess-1:1:1"],
    "the durable id is not adopted; the live row is finalized in place",
  );
  assert.deepEqual(state.messages[0]!.parts, [{ type: "text", text: "hi there" }]);
});

test("a durable assistant/message with no live frames keeps the durable id", () => {
  const state = freshState();
  behavior().apply?.(
    ev("assistant/message", {
      turn: 1,
      step: 1,
      message: { id: "am1", role: "assistant", content: [{ type: "text", text: "hi" }], source: { kind: "model" } },
    }),
    makeCtx(state),
  );
  assert.deepEqual(state.messages.map((m) => m.id), ["am1"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @gps/transport-dsh`
Expected: FAIL (`ingestAssistantStream` is not a function).

- [ ] **Step 3: Define the behavior type and add the live state**

In `packages/transport-dsh/src/behavior.ts`, add to the imports:

```ts
import {
  LiveAssistantMessage,
  type DshAssistantStreamMessage,
} from "./assistant-stream.js";
```

After the `DshBehaviorDeps` interface, add:

```ts
/**
 * The dsh behavior plus the adapter's out-of-band door for the child's live
 * assistant frames (`bridge.subscribeAssistantStream` → here). Frames are
 * routed to the session's active Run; a frame for an unknown or subagent
 * session is ignored (docs/adr/0022).
 */
export interface DshBehavior extends SessionBehavior<SessionEvent> {
  ingestAssistantStream(message: DshAssistantStreamMessage): void;
}
```

Change the function signature from:

```ts
export function createDshBehavior(deps: DshBehaviorDeps): SessionBehavior<SessionEvent> {
```

to:

```ts
export function createDshBehavior(deps: DshBehaviorDeps): DshBehavior {
```

Inside the function, after the `modelContexts` declaration, add the live state:

```ts
  /** The Run currently driving each Generative Protein System session (for live frames). */
  const activeRuns = new Map<string, RunControl<SessionEvent>>();
  /** Live assistant rows under construction, keyed `${sessionKey}:${turn}:${step}`. */
  const liveRows = new Map<string, LiveAssistantMessage>();
  /** Steps whose settlement already landed, so late frames cannot recreate a row. */
  const finalizedSteps = new Set<string>();
  /** Bound on {@link finalizedSteps}: recent steps only (monotonic turn/step). */
  const FINALIZED_KEEP = 512;

  /**
   * The deterministic live row id for a step. The caller's channel delivers a
   * step's frames in order, so `(sessionKey, turn, step)` identifies the row
   * unambiguously; the durable settlement finalizes that same id (docs/adr/0022).
   */
  function liveKey(sessionKey: string, turn: unknown, step: unknown): string | null {
    return typeof turn === "number" && typeof step === "number" ? `${sessionKey}:${turn}:${step}` : null;
  }

  /** The Generative Protein System session key a harness session id belongs to. */
  function sessionKeyForHarness(harnessId: string): string | undefined {
    for (const [key, id] of harnessSessions) if (id === harnessId) return key;
    return undefined;
  }

  function markFinalized(key: string): void {
    finalizedSteps.add(key);
    while (finalizedSteps.size > FINALIZED_KEEP) {
      const oldest = finalizedSteps.values().next().value;
      if (oldest === undefined) break;
      finalizedSteps.delete(oldest);
    }
  }
```

Add the `ingestAssistantStream` implementation before the `return` at the end of the function:

```ts
  /**
   * Route one forwarded live frame to the session's active Run. Best-effort and
   * total: an unknown session, a subagent, or a frame outside a run is ignored,
   * never thrown — this sits beside the run stream and must not break a turn.
   */
  function ingestAssistantStream({ sessionId, frame }: DshAssistantStreamMessage): void {
    const sessionKey = sessionKeyForHarness(sessionId);
    if (sessionKey === undefined) return;
    const run = activeRuns.get(sessionKey);
    if (!run) return;
    const key = liveKey(sessionKey, frame.turn, frame.step);
    if (key === null || finalizedSteps.has(key)) return;

    if (frame.type === "start") {
      const existing = liveRows.get(key);
      if (existing) {
        // A retried attempt reuses the row: clear it and rebuild.
        existing.reset();
      } else {
        const live = new LiveAssistantMessage(key, (delta) => run.emit(delta));
        live.begin();
        liveRows.set(key, live);
      }
      return;
    }

    const live = liveRows.get(key);
    if (!live) return;
    if (frame.type === "chunk" && frame.chunk) live.accept(frame.chunk);
    // `end`: keep the row. The durable assistant/message finalizes it, and an
    // abandoned attempt leaves its partial output visible (docs/adr/0022).
  }
```

- [ ] **Step 4: Register the active Run and finalize on commit**

In `dispatch`, register the run before the async work and remove it in a `finally`:

```ts
    dispatch(request, run) {
      const message = request.messages[0];
      if (!message) return;
      if (isCommandText(message.content)) {
        void answerCommand(message.content, request.sessionKey, run);
        return;
      }
      const prompt = promptWithAttachments(
        message.content,
        message.attachments,
        workspace ? { toAgentPath: (relPath) => workspace.toAgentPath(relPath) } : {},
      );
      activeRuns.set(request.sessionKey, run);
      void (async () => {
        try {
          await driveTurn(request.sessionKey, prompt, run);
          run.settle();
        } catch (err) {
          log("turn failed", err);
          run.emit({ type: "session-status", status: "error" });
          run.settle({ status: "error" });
        } finally {
          if (activeRuns.get(request.sessionKey) === run) activeRuns.delete(request.sessionKey);
        }
      })();
    },
```

Replace the whole `case "assistant/message": { ... }` block in `applyEvent` with:

```ts
      case "assistant/message": {
        const data = event.data;
        if (data.message.role !== "assistant") return;
        const key = liveKey(ctx.sessionKey, data.turn, data.step);
        const settled = key !== null && finalizedSteps.has(key);
        const live = key === null ? undefined : liveRows.get(key);
        if (key !== null && live !== undefined) {
          // The live row streamed this step: finalize it with the authoritative
          // content and KEEP its id, so the client's row never remounts.
          liveRows.delete(key);
          markFinalized(key);
          ctx.emit({
            type: "update-message",
            messageId: key,
            patch: { parts: contentToParts(data.message.content) },
          });
        } else if (settled) {
          // Already settled (a duplicate event, or a late live frame was
          // ignored): never mint a second row for one step.
        } else if (!ctx.state.messages.some((m) => m.id === data.message.id)) {
          // No live row (bridge unavailable, a lagging stream, or a non-live
          // build): the durable id path, unchanged. Mark the step settled so a
          // late live frame cannot create a second row.
          if (key !== null) markFinalized(key);
          ctx.emit({
            type: "add-message",
            message: {
              id: data.message.id,
              role: "assistant",
              parts: contentToParts(data.message.content),
            },
          });
        }
        if (data.usage) ctx.run?.note({ usage: data.usage });
        return;
      }
```

Finally add `ingestAssistantStream` to the returned behavior object:

```ts
  return {
    apply(event, ctx) {
      return applyEvent(event, ctx);
    },
    ingestAssistantStream,
    // ...the existing prepare / dispatch / beforePersist / projectRun / watch fields stay unchanged
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @gps/transport-dsh`
Expected: PASS (the three new behavior tests plus every existing test, including the original `assistant/message maps content blocks to parts in order`).

- [ ] **Step 6: Commit** (only with the user's go-ahead)

```bash
git add packages/transport-dsh/src/behavior.ts packages/transport-dsh/test/behavior.test.ts
git commit -m "feat(dsh): stream live assistant frames into the active run"
```

---

### Task 5: Wire the stream at adapter init

**Files:**
- Modify: `packages/transport-dsh/src/adapter.ts`
- Test: `packages/transport-dsh/test/adapter.test.ts`

**Interfaces:**
- Consumes: `DshBehavior` (Task 4), `DshCommandBridge.subscribeAssistantStream` (Task 3).
- Produces: no new public type; the adapter attaches the stream in `ensureStarted` and resets the flag on a failed start.

- [ ] **Step 1: Write the failing test**

In `packages/transport-dsh/test/adapter.test.ts`, find the existing subagent/bridge test setup (`FakeRecordStore`, the `createBridge` seam usage / `DshRuntimeAdapterOptions`). Add this import beside the `../src/index.js` import:

```ts
import type { DshCommandBridge } from "../src/bridge.js";
import type { DshAssistantStreamMessage } from "../src/assistant-stream.js";
```

Add a test that injects a bridge whose `subscribeAssistantStream` captures the listener, and drives frames from `FakeDshClient.duringTurn`. Append:

```ts
test("live assistant frames reach the transcript through the bridge watch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-adapter-"));
  const store = new FakeRecordStore();
  let streamListener: ((message: DshAssistantStreamMessage) => void) | null = null;
  let subscribed = false;
  const bridge: DshCommandBridge = {
    list: async () => [],
    execute: async () => ({ status: "unknown" }),
    subscribeAssistantStream: (listener) => {
      subscribed = true;
      streamListener = listener;
      return () => {
        streamListener = null;
      };
    },
  };
  const client = new FakeDshClient((_sid, _text) => completedReply("am1", "Hello from dsh."));
  const adapter = new DshRuntimeAdapter({
    createClient: () => client,
    createBridge: () => bridge,
    bridgeDir: dir,
  });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    // The turn's live frames are produced through the captured bridge listener.
    client.duringTurn = (sessionId) => {
      streamListener?.({ sessionId, frame: { type: "start", turn: 1, step: 1 } });
      streamListener?.({
        sessionId,
        frame: { type: "chunk", turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "text" } },
      });
      streamListener?.({
        sessionId,
        frame: { type: "chunk", turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "Hello" } },
      });
    };

    const deltas = await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));
    assert.ok(subscribed, "the adapter subscribed to the bridge stream");
    assert.ok(
      deltas.some((delta) => delta.type === "stream-text" && delta.text === "Hello"),
      "the live text delta reached the client stream",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @gps/transport-dsh`
Expected: FAIL (`streamListener` stays null / no `stream-text` delta).

- [ ] **Step 3: Implement the attachment**

In `packages/transport-dsh/src/adapter.ts`, change the behavior import to include the type:

```ts
import { createDshBehavior, type DshBehavior } from "./behavior.js";
```

Change the field declaration:

```ts
  private behavior: DshBehavior | null = null;
```

Add a flag beside `subagentWatchAttached`:

```ts
  private subagentWatchAttached = false;
  private assistantStreamAttached = false;
```

In `ensureStarted`, after `this.attachSubagents();` add `this.attachAssistantStream();`, and in the `catch` reset the new flag beside the subagent one:

```ts
        } catch (err) {
          this.ready = null;
          this.subagentWatchAttached = false;
          this.assistantStreamAttached = false;
          console.error("[dsh] runtime start failed (check DSH_HOME/DSH_PROFILE and the LLM credentials)", err);
          throw new Error(`dsh runtime not ready: ${String(err)}`);
        }
```

Add the attachment method beside `attachSubagents`:

```ts
  /**
   * Attach the child-wide live assistant-frame watch ONCE per child generation.
   * Both surfaces are optional, so a client or bridge without them simply
   * reports nothing; the watch is best-effort and silently degrades to
   * step-granular rendering (docs/adr/0022).
   */
  private attachAssistantStream(): void {
    const bridge = this.bridge;
    const behavior = this.behavior;
    if (
      this.assistantStreamAttached ||
      bridge === null ||
      behavior === null ||
      typeof bridge.subscribeAssistantStream !== "function"
    ) {
      return;
    }
    this.assistantStreamAttached = true;
    bridge.subscribeAssistantStream((message) => behavior.ingestAssistantStream(message));
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @gps/transport-dsh`
Expected: PASS.

- [ ] **Step 5: Commit** (only with the user's go-ahead)

```bash
git add packages/transport-dsh/src/adapter.ts packages/transport-dsh/test/adapter.test.ts
git commit -m "feat(dsh): attach the live assistant-frame watch at child start"
```

---

### Task 6: Docs and full verification

**Files:**
- Modify: `AGENTS.md` (the `packages/transport-dsh` bullet and the dsh wire-contract section)
- Verify: `docs/adr/0022-dsh-live-assistant-streaming.md` already exists (the approved spec).

**Interfaces:**
- Consumes: every prior task.
- Produces: no code.

- [ ] **Step 1: Update AGENTS.md**

In the `packages/transport-dsh` bullet, add a clause after the command-bridge description:

```markdown
  a dependency-free child plugin ALSO forwards the harness's process-local
  `agent/assistant-stream` frames (`start`/`chunk`/`end`) as NDJSON over the
  same bridge socket (`GET /assistant-stream`), so thinking / text / tool calls
  stream token-by-token while a step is still running; the adapter maps them to
  `stream-text` / `stream-reasoning` deltas into the active Run and the durable
  `assistant/message` finalizes the row (docs/adr/0022)
```

In the dsh wire-contract bullet, replace the sentence that says dsh events arrive per committed log event (the `(2)` clause) so it reads:

```markdown
  (2) events arrive per COMMITTED log event, not per token — each step's
  `assistant/message` becomes a whole-message final `set`, but a live path
  (`GET /assistant-stream` on the bridge socket, docs/adr/0022) streams the
  step's `text-delta` / `reasoning-delta` / `tool-call-delta` frames as small
  `stream-text` / `stream-reasoning` ops while the step runs, so replies render
  progressively and the committed `set` only finalizes the row;
```

- [ ] **Step 2: Run the full type gate**

Run: `npm run build`
Expected: PASS (record → transport → … → transport-dsh → transport-service, then `typecheck:tests`).

- [ ] **Step 3: Run the affected suites**

Run: `npm run test -w @gps/transport && npm run test -w @gps/transport-dsh`
Expected: PASS, including the new `fold`, `assistant-stream`, `bridge-plugin`, `behavior`, and `adapter` tests.

- [ ] **Step 4: Manual smoke (optional, needs a live dsh route)**

Run: `npm run dev:dsh`, open the workbench, send a message, and confirm reasoning/text appear progressively instead of in one burst. If no route is configured, skip — the automated tests are the gate.

- [ ] **Step 5: Commit** (only with the user's go-ahead)

```bash
git add AGENTS.md
git commit -m "docs: record dsh live assistant streaming"
```

---

## Notes for the implementer

- Task order matters: Task 1 (`stream-reasoning`) must land before Task 2/4 so the mapper's op exists in the `StateDelta` union.
- The uncommitted `behavior.ts` patch in the working tree (the `data.stream` block) is **replaced** by Task 4's `case "assistant/message"`. Do not keep the old block.
- `packages/transport-dsh/src/bridge-plugin.ts` must not gain a runtime import of `assistant-stream.ts` (that module imports `@gps/transport`). The plugin declares its own structural `BridgeAssistantStreamFrame` for exactly this reason.
- The live row id is the Generative Protein System session key, not the harness id: `harnessSessions` is the stable-key → harness-id map, and `liveKey` builds `${sessionKey}:${turn}:${step}`.
