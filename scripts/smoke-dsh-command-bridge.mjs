/**
 * Dev smoke test for the dsh child plugins — the command bridge (docs/adr/0011)
 * and the project plugin (docs/adr/0012).
 *
 * Drives a REAL harness child (`dsh --profile sdk`, spawned by
 * @deepseek-ai/dsh-sdk-client — a hoisted workspace dependency, like the other
 * root smoke tools) with the SAME launch patch the adapter writes, and asks the
 * bridge socket directly. This is the check that the launch patch actually loads
 * the plugin into the child: nothing here runs in-process except the client.
 *
 *   node scripts/smoke-dsh-command-bridge.mjs
 *
 * It ALSO mounts the PROJECT plugin (docs/adr/0012) and drives `/project` as a
 * cold session's first prompt: a real child must scaffold the workspace's
 * research layout and `PROJECT.md` on the session-start hook + the command,
 * which exercises the `--patch` mount and the `agent/session-start` listener
 * with no model route needed.
 *
 * Expected without a prompt: the socket answers, `commands` is `[]` and
 * `/compact` is `{"status":"no-agent"}` — no agent exists until a session
 * prompts. With SS_SMOKE_TURN=1 it also sends one tiny prompt (needs a
 * reachable model route) and re-lists, expecting the harness's own registry:
 * `compact`, `feedback`, `goal`, `plan` — and then drives the COLD command path
 * end to end: `/plan` as a session's FIRST prompt must be run by the registry
 * with the step rejected (`turn/end` reason `blocked`, no `assistant/message`),
 * and the session's next real prompt must log `plan/mode {active:true}`, i.e.
 * the command was in force before the conversation's first model request.
 *
 * Reads `examples/transport-dsh-example/.env` when present (for the route's
 * credential name); the route itself comes from the ambient
 * `DSH_PROVIDER`/`DSH_MODEL`, defaulting to the package's own defaults.
 *
 * Prereq: `npm run build` (the bridge helpers are imported from dist).
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: "examples/transport-dsh-example/.env", quiet: true });
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import {
  bridgeSocketPath,
  createCommandBridge,
  writeBridgePatch,
  writeProjectPatch,
} from "../packages/transport-dsh/dist/bridge.js";
import { PROJECT_FILE } from "../packages/transport-dsh/dist/project-scaffold.js";

const pluginPath = fileURLToPath(new URL("../packages/transport-dsh/dist/bridge-plugin.js", import.meta.url));
const projectPluginPath = fileURLToPath(
  new URL("../packages/transport-dsh/dist/project-plugin.js", import.meta.url),
);
const dir = await mkdtemp(join(tmpdir(), "dsh-bridge-smoke-"));
const workspace = await mkdtemp(join(tmpdir(), "dsh-bridge-workspace-"));
const socket = bridgeSocketPath(dir);
const patch = await writeBridgePatch({ dir, pluginPath, socket });
const projectPatch = await writeProjectPatch({
  dir,
  pluginPath: projectPluginPath,
  config: {
    project: { id: "smoke-project", name: "Smoke Project", createdAt: new Date().toISOString() },
    root: workspace,
  },
});
const provider = process.env.DSH_PROVIDER ?? "deepseek-official";
const model = process.env.DSH_MODEL ?? "deepseek-v4-flash";

const harness = new DeepSeekHarness({
  profile: process.env.DSH_PROFILE ?? "sdk",
  ...(process.env.DSH_HOME ? { dshHome: process.env.DSH_HOME } : {}),
  cwd: workspace,
  provider,
  model,
  patches: [patch, projectPatch],
});
const bridge = createCommandBridge(socket);

let failures = 0;
function expect(condition, description, detail) {
  if (condition) {
    console.log(`ok   ${description}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${description}${detail === undefined ? "" : ` — got ${JSON.stringify(detail)}`}`);
}

try {
  console.log(`launching dsh · profile ${process.env.DSH_PROFILE ?? "sdk"} · ${provider}/${model}`);
  console.log(`bridge patch ${patch}`);
  console.log(`project patch ${projectPatch}`);
  console.log(`socket ${socket}`);
  await harness.start();

  const commands = await bridge.list();
  console.log(`GET /commands -> ${JSON.stringify(commands)}`);
  expect(Array.isArray(commands) && commands.length === 0, "the socket answers, and no agent is live yet", commands);

  const noAgent = await bridge.execute("smoke-nope", "/compact");
  console.log(`POST /execute -> ${JSON.stringify(noAgent)}`);
  expect(noAgent.status === "no-agent", "an unknown session's agent is no-agent", noAgent);

  // The PROJECT plugin (docs/adr/0012): `/project` as a COLD session's first
  // prompt creates the agent, fires `agent/session-start`, and the pre-step
  // interception runs the command — no model route needed. A real child must
  // then show the research layout and the Brief in the workspace.
  const projectSession = `smoke-proj-${Date.now().toString(36)}`;
  console.log(`sending "/project" as the FIRST prompt on "${projectSession}"...`);
  const projectTurn = await harness.session(projectSession).run("/project", { onNotification: () => {} });
  const projectTypes = projectTurn.events.map((event) => event.type);
  expect(
    projectTypes.includes("command/done"),
    "the project plugin's /project ran in the real child",
    projectTypes,
  );
  expect(existsSync(join(workspace, PROJECT_FILE)), "the Project Brief was scaffolded", workspace);
  expect(existsSync(join(workspace, "data", "raw")), "the research layout was scaffolded", workspace);
  expect(
    existsSync(join(workspace, "results", "figures")),
    "nested layout directories were scaffolded",
    workspace,
  );

  if (process.env.SS_SMOKE_TURN === "1") {
    const sessionId = `smoke-${Date.now().toString(36)}`;
    console.log(`sending one prompt on "${sessionId}" (needs a reachable model route)...`);
    await harness.session(sessionId).run("Reply with the single word: ok", { onNotification: () => {} });
    const warm = await bridge.list();
    console.log(`GET /commands (warm) -> ${JSON.stringify(warm)}`);
    const names = warm.map((entry) => entry.name);
    for (const name of ["compact", "feedback", "goal", "plan", "project"]) {
      expect(names.includes(name), `the harness's own registry exposes /${name}`, names);
    }
    const outcome = await bridge.execute(sessionId, "/compact");
    console.log(`POST /execute (warm) -> ${JSON.stringify(outcome)}`);
    expect(outcome.status === "ok", "a warm session's agent runs the harness's own /compact", outcome);

    // The COLD command path (docs/adr/0011): a session with no agent sends the
    // line as its FIRST prompt — which is what creates the agent — and the
    // plugin's `agent/pre-step` listener must keep it away from the model.
    const coldId = `smoke-cold-${Date.now().toString(36)}`;
    console.log(`sending "/plan" as the FIRST prompt on "${coldId}"...`);
    const cold = await harness.session(coldId).run("/plan", { onNotification: () => {} });
    const coldTypes = cold.events.map((event) => event.type);
    console.log(`cold turn ended ${JSON.stringify(cold.events.at(-1)?.data)}`);
    expect(
      coldTypes.includes("command/done"),
      "the harness's own registry ran the cold command",
      coldTypes,
    );
    expect(
      !coldTypes.includes("assistant/message"),
      "and the model never saw the line (the step was rejected)",
      coldTypes,
    );
    expect(
      cold.events.find((event) => event.type === "turn/end")?.data?.reason?.kind === "blocked",
      "the turn ended blocked, with no step and no model call",
      cold.events.at(-1),
    );

    console.log(`sending one real prompt on "${coldId}" (plan mode must be in force)...`);
    const after = await harness.session(coldId).run("Reply with the single word: ok", { onNotification: () => {} });
    const planModes = after.events.filter((event) => event.type === "plan/mode");
    expect(
      planModes.at(-1)?.data?.active === true,
      "the command's plan mode is in force for the conversation's first real request",
      planModes,
    );
  } else {
    console.log("SS_SMOKE_TURN is unset: skipping the prompt (no model route needed)");
  }
} catch (err) {
  // A failed child carries its own stderr tail in the error message.
  failures += 1;
  console.error("the harness child did not come up:", err);
} finally {
  await harness.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}

console.log(failures === 0 ? "dsh smoke: OK" : `dsh smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
