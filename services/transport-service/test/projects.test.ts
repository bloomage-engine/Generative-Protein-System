import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInMemoryRecordStore, type Project, type Run } from "@science-studio/record";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type RuntimeAdapter,
} from "@science-studio/transport";
import { FsWorkspace } from "@science-studio/workspace";
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

test("a Project can be renamed/archived/unarchived/deleted; the default is immutable", async () => {
  const records = createInMemoryRecordStore();
  await withServer(backendWith(records), async (base) => {
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "Alpha" }),
    });
    const { project } = (await created.json()) as { project: Project };

    const renamed = await fetch(`${base}/api/projects/${project.id}/rename`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "Beta" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { project: Project }).project.name, "Beta");

    const archived = await fetch(`${base}/api/projects/${project.id}/archive`, { method: "POST" });
    assert.equal(archived.status, 200);
    let listed = (await (await fetch(`${base}/api/projects`)).json()) as {
      projects: Project[];
      defaultProjectId: string;
    };
    assert.deepEqual(listed.projects.map((p) => p.id), [], "archived is hidden");
    listed = (await (
      await fetch(`${base}/api/projects?includeArchived=1`)
    ).json()) as { projects: Project[]; defaultProjectId: string };
    assert.deepEqual(
      listed.projects.map((p) => p.id),
      [project.id],
    );
    assert.equal(listed.defaultProjectId, "project-default");

    const unarchived = await fetch(`${base}/api/projects/${project.id}/unarchive`, {
      method: "POST",
    });
    assert.equal(unarchived.status, 200);
    listed = (await (await fetch(`${base}/api/projects`)).json()) as {
      projects: Project[];
      defaultProjectId: string;
    };
    assert.deepEqual(
      listed.projects.map((p) => p.id),
      [project.id],
    );

    const guards: [string, RequestInit][] = [
      ["rename", { method: "POST", headers: json, body: JSON.stringify({ name: "x" }) }],
      ["archive", { method: "POST" }],
      ["unarchive", { method: "POST" }],
      ["delete", { method: "POST" }],
    ];
    for (const [action, init] of guards) {
      const res = await fetch(`${base}/api/projects/project-default/${action}`, init);
      assert.equal(res.status, 403, `${action} on the default project`);
    }

    const deleted = await fetch(`${base}/api/projects/${project.id}/delete`, { method: "POST" });
    assert.equal(deleted.status, 200);
    assert.equal(await records.getProject(project.id), null);
  });
});

test("a Session can be renamed/archived/unarchived/deleted; a deleted Session takes its Runs", async () => {
  const records = createInMemoryRecordStore();
  await records.createProject({ id: "p1", name: "P1", createdAt: "2026-01-01T00:00:00.000Z" });
  await withServer(backendWith(records), async (base) => {
    const made = await fetch(`${base}/api/projects/p1/sessions`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "First" }),
    });
    const { session } = (await made.json()) as { session: { id: string } };
    await records.addRun({
      id: "r1",
      sessionId: session.id,
      projectId: "p1",
      status: "completed",
      agentId: "main",
      parameters: {},
      input: "q",
      output: "a",
    });

    const renamed = await fetch(`${base}/api/projects/p1/sessions/${session.id}/rename`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "Renamed" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(
      ((await renamed.json()) as { session: { title?: string } }).session.title,
      "Renamed",
    );

    await fetch(`${base}/api/projects/p1/sessions/${session.id}/archive`, { method: "POST" });
    let listed = (await (
      await fetch(`${base}/api/projects/p1/sessions`)
    ).json()) as { sessions: { id: string }[] };
    assert.deepEqual(listed.sessions, [], "an archived Session is hidden");
    listed = (await (
      await fetch(`${base}/api/projects/p1/sessions?includeArchived=1`)
    ).json()) as { sessions: { id: string }[] };
    assert.deepEqual(
      listed.sessions.map((s) => s.id),
      [session.id],
    );

    await fetch(`${base}/api/projects/p1/sessions/${session.id}/unarchive`, { method: "POST" });
    listed = (await (
      await fetch(`${base}/api/projects/p1/sessions`)
    ).json()) as { sessions: { id: string }[] };
    assert.deepEqual(
      listed.sessions.map((s) => s.id),
      [session.id],
    );

    // A Session that belongs to another Project is not addressable through this one.
    const wrongProject = await fetch(`${base}/api/projects/other/sessions/${session.id}/delete`, {
      method: "POST",
    });
    assert.equal(wrongProject.status, 404);

    const deleted = await fetch(`${base}/api/projects/p1/sessions/${session.id}/delete`, {
      method: "POST",
    });
    assert.equal(deleted.status, 200);
    assert.equal(await records.getSession(session.id), null);
    assert.deepEqual(await records.listRuns("p1"), [], "its Runs are cascaded");
  });
});

test("deleting a Project recycles its workspace and releases its environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-recycle-api-"));
  const root = join(dir, "projects");
  await mkdir(join(root, "p1"), { recursive: true });
  await writeFile(join(root, "p1", "data.csv"), "a,b\n1,2\n");
  const records = createInMemoryRecordStore();
  await records.createProject({ id: "p1", name: "P1", createdAt: "2026-01-01T00:00:00.000Z" });
  const released: string[] = [];
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: {
      acquire: async (_principal, projectId) => ({
        adapter: fakeAdapter(),
        workspace: new FsWorkspace(join(root, projectId), { agentRoot: join(root, projectId) }),
        projectId,
      }),
      release: async (_principal, projectId) => {
        released.push(projectId);
      },
      dispose: async () => {},
    },
    cors: { origin: true },
    records,
  };
  try {
    await withServer(backend, async (base) => {
      const res = await fetch(`${base}/api/projects/p1/delete`, { method: "POST" });
      assert.equal(res.status, 200);
      assert.equal(await records.getProject("p1"), null);
      assert.deepEqual(released, ["p1"], "the Project's environment is released");

      const bin = join(root, ".recycle");
      const moved = await readdir(bin);
      assert.equal(moved.length, 1);
      assert.equal(await readFile(join(bin, moved[0]!, "data.csv"), "utf8"), "a,b\n1,2\n");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
