import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NullWorkspace, type RecordStoreLike, type Workspace } from "@gps/transport";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";

/**
 * The working directory the adapter gives the turn client — the dsh harness
 * records it on every SDK-created session, so this is the ONE place that
 * decides where the agent reads and writes. It MUST be the Project's workspace
 * as the seam describes it in the AGENT's view (`toAgentPath("")`) — otherwise
 * the agent works in a different directory than the one the Files browser
 * lists, and its output never shows up there.
 *
 * The old expression read the raw `DSH_WORKSPACE` env var, which in the dev
 * setup names the Project PARENT (`<PROJECT_ROOT>`, e.g. `~/workspace/dsh-workspace`),
 * so the agent wrote beside the Project directory while the browser listed the
 * (empty) `<PROJECT_ROOT>/<projectId>/` subdirectory.
 *
 * A `NullWorkspace` (no `PROJECT_ROOT` configured) has no agent-view root: its
 * `toAgentPath("")` answers `""`, which must NOT be handed over as a cwd — the
 * no-workspace deployment keeps the standalone binding/env/cwd fallback.
 */

const TRANSCRIPT_DIR = join(tmpdir(), "gps-launch-cwd-test");

/** A workspace whose agent view is rooted at `agentRoot`. */
function workspaceAt(agentRoot: string): Workspace {
  return {
    list: async () => ({ path: "", entries: [] }),
    stat: async () => ({}) as never,
    open: async () => ({}) as never,
    write: async () => ({}) as never,
    toAgentPath: (relPath: string) => (relPath === "" ? agentRoot : `${agentRoot}/${relPath}`),
    toWorkspacePath: () => null,
  } as unknown as Workspace;
}

const noRecordStore: RecordStoreLike = { addRun: async () => {} };

/** The `cwd` the adapter hands the harness launch for these init options. */
async function launchedCwd(workspace?: Workspace): Promise<string> {
  let cwd: string | undefined;
  const adapter = new DshRuntimeAdapter({
    createClient: (options): DshTurnClient => {
      cwd = options.cwd;
      return {
        start: async () => {},
        close: async () => {},
        runTurn: async () => {},
      };
    },
    transcriptDir: TRANSCRIPT_DIR,
  });
  await adapter.init({
    binding: { runtime: "dsh", config: {} },
    recordStore: noRecordStore,
    ...(workspace === undefined ? {} : { workspace }),
  });
  assert.notEqual(cwd, undefined, "init() must launch a harness client");
  return cwd as string;
}

/** Run `body` with `DSH_WORKSPACE` set, then restore the ambient value. */
async function withDshWorkspace(value: string, body: () => Promise<void>): Promise<void> {
  const previous = process.env.DSH_WORKSPACE;
  process.env.DSH_WORKSPACE = value;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKSPACE;
    else process.env.DSH_WORKSPACE = previous;
  }
}

test("the Project workspace's agent-view root wins over the DSH_WORKSPACE env var", async () => {
  await withDshWorkspace("/parent/of/projects", async () => {
    assert.equal(
      await launchedCwd(workspaceAt("/agent/root/project-default")),
      "/agent/root/project-default",
    );
  });
});

test("a NullWorkspace never launches the harness with an empty cwd", async () => {
  await withDshWorkspace("/standalone/workspace", async () => {
    // `NullWorkspace.toAgentPath("")` is "" — no agent-view root exists, so the
    // standalone fallback chain still applies.
    assert.equal(await launchedCwd(new NullWorkspace()), "/standalone/workspace");
  });
});

test("with no workspace passed (the example app) the env var still decides", async () => {
  await withDshWorkspace("/example/workspace", async () => {
    assert.equal(await launchedCwd(undefined), "/example/workspace");
  });
});
