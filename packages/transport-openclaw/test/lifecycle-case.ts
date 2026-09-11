import type { EventFrame } from "@openclaw/gateway-client/browser";
import type { RecordStoreLike, SessionState, StateDelta } from "@science-studio/transport/seams";
import type { Run } from "@science-studio/record";
import type { AdapterLifecycleCase } from "@science-studio/contract-tests";
import type { BackendGateway } from "../src/connection.js";
import { OpenClawRuntimeAdapter } from "../src/index.js";

const SESSION = "agent:main:main";

/**
 * The openclaw driver for `testAdapterLifecycle`: a scripted gateway plus a
 * `runTurn` that streams one delta/final exchange, so the shared suite can drive
 * a full turn through the public `RuntimeAdapter` surface without a live
 * gateway.
 */
export async function openClawLifecycleCase(): Promise<AdapterLifecycleCase> {
  const runs: Run[] = [];
  const store: RecordStoreLike = {
    addRun: async (run) => void runs.push(run),
    addArtifact: async () => {},
  };
  let emit: (frame: EventFrame) => void = () => {};

  const adapter = new OpenClawRuntimeAdapter({
    createGateway: (): BackendGateway => {
      const readyListeners = new Set<() => void>();
      let eventCb: ((frame: EventFrame) => void) | null = null;
      const gateway = {
        connected: true,
        start: () => {
          for (const listener of readyListeners) listener();
        },
        stop: () => {},
        request: async (method: string) => {
          if (method === "chat.history") return { sessionKey: SESSION, messages: [] };
          if (method === "chat.send") return { runId: "run-1", status: "started" };
          throw new Error(`unexpected request: ${method}`);
        },
        onEvent: (cb: (frame: EventFrame) => void) => {
          eventCb = cb;
          return () => {
            eventCb = null;
          };
        },
        onReady: (listener: () => void) => {
          readyListeners.add(listener);
          return () => readyListeners.delete(listener);
        },
      } as unknown as BackendGateway;
      emit = (frame) => eventCb?.(frame);
      return gateway;
    },
  });

  await adapter.init({
    binding: { runtime: "openclaw", config: { url: "ws://fake", token: "token" } },
    recordStore: store,
  });

  const session = (): SessionState => ({
    sessionId: SESSION,
    studyId: "study-1",
    agentId: "main",
    status: "idle",
    messages: [],
  });

  return {
    adapter,
    runs,
    session,
    async runTurn(text: string): Promise<StateDelta[]> {
      const deltas: StateDelta[] = [];
      const running = (async () => {
        for await (const delta of adapter.run(session(), [
          { type: "add-message", message: { id: "u1", role: "user", content: text } },
        ])) {
          deltas.push(delta);
        }
      })();
      // Let run() attach the flow and resolve `chat.send` before feeding events.
      await new Promise((resolve) => setTimeout(resolve, 10));
      emit({
        event: "chat",
        payload: { sessionKey: SESSION, state: "delta", runId: "run-1", deltaText: "reply" },
      } as unknown as EventFrame);
      emit({
        event: "chat",
        payload: { sessionKey: SESSION, state: "final", runId: "run-1" },
      } as unknown as EventFrame);
      await running;
      return deltas;
    },
  };
}
