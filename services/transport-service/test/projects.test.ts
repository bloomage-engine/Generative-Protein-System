import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createInMemoryRecordStore, type Project, type Run } from "@science-studio/record";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type RuntimeAdapter,
} from "@science-studio/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

/**
 * The Project / Session / Run record routes and the transport route's Project
 * scoping (docs/adr/0006, 0007): identity comes from the record, a Project is
 * created explicitly, and a claimed session key is first-use recorded under the
 * request's Project (omitted → the default Project).
 */
function fakeAdapter(): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* () {},
    abort: () => {},
  };
}

async function withServer(
  backend: Backend,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

function backendWith(records = createInMemoryRecordStore()): Backend {
  return {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: fakeAdapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records,
  };
}

const json = { "content-type": "application/json" };

test("POST /api/projects creates a slugged Project and GET lists it", async () => {
  const records = createInMemoryRecordStore();
  await withServer(backendWith(records), async (base) => {
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "Metabolism Study" }),
    });
    assert.equal(created.status, 201);
    const { project } = (await created.json()) as { project: Project };
    assert.match(project.id, /^metabolism-study-[a-z0-9-]+$/, "the id is a filesystem-safe slug");
    assert.equal(project.name, "Metabolism Study");

    const listed = (await (await fetch(`${base}/api/projects`)).json()) as {
      projects: Project[];
    };
    assert.deepEqual(
      listed.projects.map((p) => p.id),
      [project.id],
    );

    const nameless = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({}),
    });
    assert.equal(nameless.status, 400);
  });
});

test("sessions are created under a Project and listed; an unknown Project is 404", async () => {
  const records = createInMemoryRecordStore();
  await withServer(backendWith(records), async (base) => {
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "Project A" }),
    });
    const { project } = (await created.json()) as { project: Project };

    const made = await fetch(`${base}/api/projects/${project.id}/sessions`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "First look" }),
    });
    assert.equal(made.status, 201);

    const listed = (await (
      await fetch(`${base}/api/projects/${project.id}/sessions`)
    ).json()) as { sessions: { id: string; projectId: string; title?: string }[] };
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0]!.projectId, project.id);
    assert.equal(listed.sessions[0]!.title, "First look");

    const missing = await fetch(`${base}/api/projects/nope/sessions`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 404);
  });
});

test("GET /api/projects/:id/runs rolls up the Runs of all its Sessions", async () => {
  const records = createInMemoryRecordStore();
  const run = (id: string, projectId: string, sessionId: string): Run => ({
    id,
    sessionId,
    projectId,
    status: "completed",
    agentId: "main",
    parameters: {},
    input: "q",
    output: "a",
  });
  await records.createProject({ id: "p1", name: "P1", createdAt: "2026-01-01T00:00:00.000Z" });
  await records.addRun(run("r1", "p1", "s1"));
  await records.addRun(run("r2", "p1", "s2"));
  await records.addRun(run("r3", "p2", "s3"));

  await withServer(backendWith(records), async (base) => {
    const body = (await (await fetch(`${base}/api/projects/p1/runs`)).json()) as { runs: Run[] };
    assert.deepEqual(
      body.runs.map((r) => r.id),
      ["r1", "r2"],
    );
  });
});

test("the transport route first-use records a Session under the named Project", async () => {
  const records = createInMemoryRecordStore();
  await withServer(backendWith(records), async (base) => {
    const res = await fetch(`${base}/api/transport`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        commands: [],
        state: { status: "idle", messages: {} },
        threadId: "sess-1",
        projectId: "proj-x",
      }),
    });
    assert.equal(res.status, 200);
    await res.text(); // drain; the probe terminates with [DONE]

    const session = await records.getSession("sess-1");
    assert.ok(session, "the Session row was created on first use");
    assert.equal(session.projectId, "proj-x");
    assert.ok(await records.getProject("proj-x"), "the Project row was ensured");
  });
});

test("an explicit query projectId wins over the body's", async () => {
  const records = createInMemoryRecordStore();
  await withServer(backendWith(records), async (base) => {
    const res = await fetch(`${base}/api/transport?projectId=proj-query`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        commands: [],
        state: { status: "idle", messages: {} },
        threadId: "sess-q",
        projectId: "proj-body",
      }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(
      (await records.getSession("sess-q"))?.projectId,
      "proj-query",
      "the URL's Project must win over the body's",
    );
  });
});

test("a request with no ProjectId falls back to the default Project", async () => {
  const records = createInMemoryRecordStore();
  await withServer(backendWith(records), async (base) => {
    const res = await fetch(`${base}/api/transport`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        commands: [],
        state: { status: "idle", messages: {} },
        threadId: "sess-plain",
      }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal((await records.getSession("sess-plain"))?.projectId, "project-default");
  });
});
