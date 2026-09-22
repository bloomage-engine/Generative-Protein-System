/**
 * Shared fixtures for the dsh command tests: the scripted turn client, the
 * record sink, the session/command constructors and the two delta readers, plus
 * a scripted command bridge.
 *
 * Not a test file (the package's glob is `test/*.test.ts`), so importing it
 * registers nothing and two suites can share one definition of "a completed
 * turn" instead of drifting apart.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { RecordStoreLike, SessionState, StateDelta } from "@science-studio/transport";
import { sessionState } from "@science-studio/contract-tests";
import type { PersistedTranscript, Run } from "@science-studio/record";
import type { DshTurnClient } from "../src/index.js";
import type { DshCommandBridge, HarnessCommandEntry, HarnessInterruptOutcome } from "../src/bridge.js";
import type { HarnessBridgeOutcome } from "../src/commands.js";

export function ev(type: string, data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: Date.now(), data } as unknown as SessionEvent;
}

/** The committed events of one completed turn carrying `text`. */
export function completedReply(assistantId: string, text: string): SessionEvent[] {
  return [
    ev("turn/start", { turn: 1 }, 1),
    ev(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: { id: assistantId, role: "assistant", content: [{ type: "text", text }], source: { kind: "model" } },
      },
      2,
    ),
    ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 3),
  ];
}

/**
 * A scripted child as the cold-path tests see it: the two turn clients below
 * record what they were asked for, so a test can assert which prompt carried
 * which line — and which harness session it landed on.
 */
export interface ScriptedClient extends DshTurnClient {
  started: boolean;
  readonly prompts: string[];
  readonly sessionIds: string[];
}

/** A scripted turn client: records every prompt, then emits a completed turn. */
export class FakeDshClient implements ScriptedClient {
  started = false;
  readonly prompts: string[] = [];
  readonly sessionIds: string[] = [];
  async start(): Promise<void> {
    this.started = true;
  }
  async close(): Promise<void> {}
  async runTurn(
    sessionId: string,
    text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    this.prompts.push(text);
    this.sessionIds.push(sessionId);
    for (const event of completedReply(`am-${sessionId}-${this.prompts.length}`, "Hello from dsh.")) {
      onEvent(event);
    }
  }
}

/**
 * A scripted child that answers a `/`-line prompt the way `bridge-plugin.ts`
 * does: the harness's own registry runs it and the step is REJECTED, so the
 * turn ends `blocked` and the model is never called. A name absent from
 * {@link results} is one the registry does not resolve — nothing is logged for
 * it at all. Any other prompt is an ordinary model turn.
 */
export class InterceptingDshClient implements ScriptedClient {
  started = false;
  readonly prompts: string[] = [];
  readonly sessionIds: string[] = [];
  /** Result text per command name, as the harness's own `/`-command reports it. */
  readonly results = new Map<string, string>([
    ["compact", "Condensed 12 items"],
    ["plan", "plan mode is on"],
    ["goal", "goal set"],
  ]);

  async start(): Promise<void> {
    this.started = true;
  }
  async close(): Promise<void> {}
  async runTurn(
    sessionId: string,
    text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    this.prompts.push(text);
    this.sessionIds.push(sessionId);
    if (!text.startsWith("/")) {
      for (const event of completedReply(`am-${sessionId}-${this.prompts.length}`, "Hello from dsh.")) {
        onEvent(event);
      }
      return;
    }
    const name = text.trim().split(/\s+/)[0]!.slice(1);
    const result = this.results.get(name);
    onEvent(ev("turn/start", { turn: 1 }, 1));
    if (result !== undefined) {
      onEvent(ev("command/run", { commandId: `cmd-${name}`, name, source: { kind: "user" } }, 2));
      onEvent(ev("command/done", { commandId: `cmd-${name}`, kind: "success", text: result }, 3));
    }
    onEvent(ev("turn/end", { turn: 1, reason: { kind: "blocked" } }, 4));
  }
}

export class FakeRecordStore implements RecordStoreLike {
  readonly runs: Run[] = [];
  /** The record's durable session transcripts (docs/adr/0019). */
  readonly transcripts = new Map<string, PersistedTranscript>();
  async addRun(run: Run): Promise<void> {
    this.runs.push(run);
  }
  async saveSessionTranscript(sessionId: string, doc: PersistedTranscript): Promise<void> {
    this.transcripts.set(sessionId, structuredClone(doc));
  }
  async loadSessionTranscript(sessionId: string): Promise<PersistedTranscript | null> {
    const doc = this.transcripts.get(sessionId);
    return doc === undefined ? null : structuredClone(doc);
  }
}

export function session(): SessionState {
  return sessionState({ sessionId: "sess-1" });
}

export async function collect(iter: AsyncIterable<StateDelta>): Promise<StateDelta[]> {
  const out: StateDelta[] = [];
  for await (const delta of iter) out.push(delta);
  return out;
}

export function command(
  content: string,
  id = "u1",
): { type: "add-message"; message: { id: string; role: "user"; content: string } } {
  return { type: "add-message", message: { id, role: "user", content } };
}

/** The assistant reply rows a run streamed. */
export function replies(deltas: readonly StateDelta[]): string[] {
  return deltas
    .filter((d): d is Extract<StateDelta, { type: "add-message" }> => d.type === "add-message")
    .filter((d) => d.message.role === "assistant")
    .flatMap((d) => d.message.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text));
}

/** How a scripted bridge answers one invocation. */
export type BridgeScript = (sessionId: string, line: string) => HarnessBridgeOutcome;

/** A scripted command bridge: records every call and answers from a program. */
export class ScriptedBridge implements DshCommandBridge {
  /** What `list()` reports (the harness's own descriptors). */
  listed: HarnessCommandEntry[] = [
    { name: "compact", description: "Condense the conversation" },
    { name: "plan", description: "Enter plan mode", input: { hint: "<message>" } },
  ];
  listCalls = 0;
  readonly calls: { sessionId: string; line: string }[] = [];
  /** Harness session ids `/interrupt` was asked to cancel. */
  readonly interrupted: string[] = [];

  constructor(private readonly script: BridgeScript = () => ({ status: "unknown" })) {}

  async list(): Promise<HarnessCommandEntry[]> {
    this.listCalls += 1;
    return this.listed;
  }

  async execute(sessionId: string, line: string): Promise<HarnessBridgeOutcome> {
    this.calls.push({ sessionId, line });
    return this.script(sessionId, line);
  }

  async interrupt(sessionId: string): Promise<HarnessInterruptOutcome> {
    this.interrupted.push(sessionId);
    return "ok";
  }
}

/** A throwaway transcript-mirror directory, for `DshRuntimeAdapterOptions.transcriptDir`. */
export function tmpTranscriptDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dsh-commands-"));
}
