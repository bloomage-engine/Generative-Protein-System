/**
 * A runtime plugin double for the composition tests.
 *
 * Its adapter records the AGENT's view of the workspace it was initialized with
 * — `toAgentPath("")`, the directory a dsh harness child gets as its cwd and the
 * root every workspace attachment path is mapped through. That single value is
 * what decides where an agent reads and writes, so it is the observable a
 * per-Project environment is judged by (docs/adr/0008).
 *
 * Exported as `runtimePlugins` so `SS_RUNTIME_MODULES` can point the composition
 * root at it exactly like a real runtime package: the module specifier is
 * RUNTIME-SELECTED (configuration), which is why the test navigates it by URL
 * rather than by import.
 */
import type { RuntimeAdapter, RuntimePlugin } from "@science-studio/transport";

/** One adapter's observed `init`. */
export interface AdapterInitObservation {
  /** The agent-side root of the workspace handed to `init`. */
  agentRoot: string;
  /** A workspace-relative path mapped through the agent view. */
  samplePath: string;
}

/** The fixture's adapter: the seam surface plus what it was initialized with. */
export interface RecordingAdapter extends RuntimeAdapter {
  /** One entry per `init`, in call order. */
  readonly inits: AdapterInitObservation[];
}

export const runtimePlugins: RuntimePlugin[] = [
  {
    runtime: "fake-per-project",
    localBinding: () => ({ runtime: "fake-per-project", config: {} }),
    factory: {
      runtime: "fake-per-project",
      capabilities: {
        commandCatalog: false,
        remoteSettleWatch: false,
        tokenStreaming: false,
        approvals: false,
        hostedSandbox: false,
        perSessionCwd: true,
      },
      create: (): RecordingAdapter => {
        const inits: AdapterInitObservation[] = [];
        return {
          runtime: "fake-per-project",
          inits,
          init: async (opts) => {
            inits.push({
              agentRoot: opts.workspace?.toAgentPath("") ?? "",
              samplePath: opts.workspace?.toAgentPath("notes.md") ?? "",
            });
          },
          run: async function* () {},
          abort: () => {},
        };
      },
    },
  },
];
