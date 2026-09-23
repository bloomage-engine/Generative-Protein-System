import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKTREE_ID } from "@science-studio/record";
import type { Backend } from "../src/composition.js";
import { createBackend } from "../src/composition.js";
import type { RecordingAdapter } from "./fixtures/per-project-runtime.js";

/**
 * Provisioning is per PROJECT, not per deployment: a Project's requests resolve
 * to an environment carrying that Project's workspace — and, because an
 * adapter's workspace-derived launch surface is fixed at `init`, its OWN
 * adapter. One shared adapter could only ever serve one directory (the default
 * Project's), which is exactly the bug this pins: switching to a Project left
 * the session working in `project-default`.
 *
 * The fixture runtime records the agent view (`toAgentPath("")`) each `init` was
 * handed, so the assertions are about where the agent works, not about wiring.
 * Its module specifier is runtime-selected — it stands in for a deployment's
 * runtime package — so it is addressed by URL.
 */
const RUNTIME = "fake-per-project";
const MODULE_URL = new URL("./fixtures/per-project-runtime.ts", import.meta.url).href;

/** A fresh backend whose only runtime is the recording fixture. */
async function backendOver(env: NodeJS.ProcessEnv): Promise<Backend> {
  return createBackend({
    TRANSPORT_RUNTIME: RUNTIME,
    SS_RUNTIME_MODULES: MODULE_URL,
    RECORD_STORE: "memory",
    ...env,
  });
}

async function principalOf(backend: Backend) {
  const principal = await backend.principal.resolve({ headers: {}, url: "/" });
  assert.ok(principal, "the single-user principal resolver must resolve without headers");
  return principal;
}

test("every Project gets its own adapter, launched in that Project's directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ss-provisioning-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const backend = await backendOver({
    PROJECT_ROOT: join(root, "projects"),
    PROJECT_AGENT_ROOT: join(root, "agent"),
  });
  const principal = await principalOf(backend);

  const alpha = await backend.environments.acquire(principal, "alpha", DEFAULT_WORKTREE_ID);
  const beta = await backend.environments.acquire(principal, "beta", DEFAULT_WORKTREE_ID);

  assert.notEqual(alpha.adapter, beta.adapter, "two Projects must not share one adapter");
  assert.deepEqual(
    (alpha.adapter as RecordingAdapter).inits.map((o) => o.agentRoot),
    [join(root, "agent", "alpha")],
    "alpha's adapter must be initialized with alpha's workspace",
  );
  assert.deepEqual(
    (beta.adapter as RecordingAdapter).inits.map((o) => o.agentRoot),
    [join(root, "agent", "beta")],
    "beta's adapter must be initialized with beta's workspace",
  );
  assert.deepEqual(
    (beta.adapter as RecordingAdapter).inits.map((o) => o.samplePath),
    [join(root, "agent", "beta", "notes.md")],
    "attachment paths must map into the Project's own agent directory",
  );

  // The environment's file surface and its agent view are the same Project.
  assert.equal(alpha.workspace.toAgentPath(""), join(root, "agent", "alpha"));
  assert.equal(alpha.projectId, "alpha");

  // A Project's Sessions share ONE adapter, and re-acquiring must not re-init it.
  const alphaAgain = await backend.environments.acquire(principal, "alpha", DEFAULT_WORKTREE_ID);
  assert.equal(alphaAgain.adapter, alpha.adapter, "a Project's adapter is built once");
  assert.equal(
    (alpha.adapter as RecordingAdapter).inits.length,
    1,
    "acquire must not re-initialize an adapter",
  );
});

test("an adapter is initialized with the record-owned Project identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ss-provisioning-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const backend = await backendOver({
    PROJECT_ROOT: join(root, "projects"),
    PROJECT_AGENT_ROOT: join(root, "agent"),
  });
  const principal = await principalOf(backend);
  const records = backend.records;
  assert.ok(records, "the backend exposes its record store");
  const project = await records.createProject({
    id: "drought-screen",
    name: "抗旱基因筛选",
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  const environment = await backend.environments.acquire(principal, project.id, DEFAULT_WORKTREE_ID);
  assert.deepEqual(
    (environment.adapter as RecordingAdapter).inits.map((o) => o.project),
    [{ id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" }],
    "the adapter renders the record's own Project, not a fabricated one",
  );
});

test("an unconfigured root stays a NullWorkspace for every Project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ss-provisioning-none-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const backend = await backendOver({});
  const principal = await principalOf(backend);

  const alpha = await backend.environments.acquire(principal, "alpha", DEFAULT_WORKTREE_ID);
  assert.equal(
    alpha.workspace.toAgentPath(""),
    "",
    "a deployment with no PROJECT_ROOT exposes no workspace at all",
  );
});

test("the default Project is provisioned like any other", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ss-provisioning-default-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const backend = await backendOver({
    PROJECT_ROOT: join(root, "projects"),
    PROJECT_AGENT_ROOT: join(root, "agent"),
  });
  const principal = await principalOf(backend);

  const environment = await backend.environments.acquire(
    principal,
    "project-default",
    DEFAULT_WORKTREE_ID,
  );
  assert.equal(environment.workspace.toAgentPath(""), join(root, "agent", "project-default"));
  assert.equal(
    (environment.adapter as RecordingAdapter).inits.length,
    1,
    "no adapter is built until a Project is actually used",
  );
});
