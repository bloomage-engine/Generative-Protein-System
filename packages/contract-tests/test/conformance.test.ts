import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalPrincipalResolver,
  NoopQuotaPolicy,
  type Principal,
  type RuntimeAdapter,
  type RuntimeFactory,
  type RuntimeInitOptions,
} from "@science-studio/transport";
import { FsWorkspace } from "@science-studio/workspace";
import {
  testPrincipalResolver,
  testQuotaPolicy,
  testRuntimeFactory,
  testWorkspace,
} from "../src/index.js";

/**
 * The OSS reference implementations run the shared contract. These cases are
 * what the private enterprise module and third-party runtime packages must
 * pass too — running them here proves the suites are satisfiable and match the
 * shipped defaults.
 */

const AGENT_ROOT = "/home/node/.openclaw/workspace";

const PRINCIPAL: Principal = {
  id: "p1",
  tenant: "t1",
  displayName: "Test researcher",
  roles: ["researcher"],
  local: false,
};

testPrincipalResolver("LocalPrincipalResolver", () => new LocalPrincipalResolver(), {
  accepted: { headers: {}, url: "/api/transport" },
});

testQuotaPolicy("NoopQuotaPolicy", () => new NoopQuotaPolicy(), {
  principal: PRINCIPAL,
  allowed: 4096,
});

testWorkspace("FsWorkspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "ss-contract-"));
  const outside = await mkdtemp(join(tmpdir(), "ss-contract-outside-"));
  await writeFile(join(root, "hello.txt"), "hello contract\n");
  await mkdir(join(root, "dir"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));

  return {
    workspace: new FsWorkspace(root, { agentRoot: AGENT_ROOT }),
    fixture: {
      dir: "",
      textFile: { path: "hello.txt", content: "hello contract\n", mime: "text/plain" },
      missing: "nope.txt",
      escapingSymlink: "escape.txt",
      writable: { path: "written/hello.txt", content: "written contract\n" },
    },
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
});

// A minimal factory validates the suite's own logic (identity, capability
// agreement, foreign-binding refusal) without any network or subprocess.
testRuntimeFactory("fake runtime factory", () => {
  const factory: RuntimeFactory = {
    runtime: "fake",
    capabilities: {
      commandCatalog: false,
      remoteSettleWatch: false,
      tokenStreaming: false,
      approvals: false,
      hostedSandbox: false,
      perSessionCwd: false,
      subagents: false,
      subagentTranscript: false,
    },
    create: (): RuntimeAdapter => ({
      runtime: "fake",
      init: async (opts: RuntimeInitOptions): Promise<void> => {
        if (opts.binding.runtime !== "fake") {
          throw new Error(`not a fake binding: ${opts.binding.runtime}`);
        }
      },
      run: async function* () {
        /* never runs in this suite */
      },
      abort: () => {},
    }),
  };
  return {
    factory,
    validBinding: { runtime: "fake", config: {} },
    foreignBinding: { runtime: "other", config: {} },
  };
});
