import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { RecordStoreLike, StateDelta } from "@gps/transport/seams";
import type { Run } from "@gps/record";
import { type AdapterLifecycleCase, sessionState } from "@gps/contract-tests";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: Date.now(), data } as unknown as SessionEvent;
}

/** A scripted turn client: emits a committed completed turn per prompt. */
class ScriptedClient implements DshTurnClient {
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async runTurn(
    _sessionId: string,
    _text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    onEvent(ev("turn/start", { turn: 1 }, 1));
    onEvent(
      ev(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            id: "am1",
            role: "assistant",
            content: [{ type: "text", text: "reply" }],
            source: { kind: "model" },
          },
        },
        2,
      ),
    );
    onEvent(ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 3));
  }
}

/**
 * The dsh driver for `testAdapterLifecycle`: a scripted turn client plus a
 * throwaway transcript-mirror directory, so the shared suite can drive a full
 * turn through the public `RuntimeAdapter` surface without spawning the harness.
 */
export async function dshLifecycleCase(): Promise<AdapterLifecycleCase> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-lifecycle-"));
  const runs: Run[] = [];
  const store: RecordStoreLike = {
    addRun: async (run) => void runs.push(run),
  };
  const client = new ScriptedClient();
  const adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
  await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });

  return {
    adapter,
    runs,
    async runTurn(text: string): Promise<StateDelta[]> {
      const deltas: StateDelta[] = [];
      for await (const delta of adapter.run(sessionState(), [
        { type: "add-message", message: { id: "u1", role: "user", content: text } },
      ])) {
        deltas.push(delta);
      }
      return deltas;
    },
  };
}
