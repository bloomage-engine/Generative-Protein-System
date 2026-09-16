import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveProject,
  archiveSession,
  deleteProject,
  deleteSession,
  fetchProjectSessions,
  fetchProjectsOverview,
  renameProject,
  renameSession,
  unarchiveProject,
  unarchiveSession,
} from "../src/projects.js";

interface Call {
  url: string;
  method: string;
  body?: string;
  contentType: string | undefined;
}

/** Run `fn` with `fetch` swapped for a recorder that answers `body`. */
async function withFetch(
  body: unknown,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      contentType: headers["content-type"],
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const API = "/api/projects";

test("fetchProjectsOverview returns the default Project id and can include archived", async () => {
  await withFetch({ projects: [], defaultProjectId: "project-default" }, async (calls) => {
    const overview = await fetchProjectsOverview(API);
    assert.equal(overview.defaultProjectId, "project-default");
    assert.equal(calls[0]!.url, `${API}`);

    await fetchProjectsOverview(API, { includeArchived: true });
    assert.equal(calls[1]!.url, `${API}?includeArchived=1`);
  });
});

test("project rename/archive/unarchive/delete hit the expected action paths", async () => {
  await withFetch({ project: { id: "p1", name: "Beta" }, ok: true }, async (calls) => {
    await renameProject(API, "p1", "Beta");
    await archiveProject(API, "p1");
    await unarchiveProject(API, "p1");
    await deleteProject(API, "p1");

    assert.deepEqual(
      calls.map((c) => [c.method, c.url]),
      [
        ["POST", `${API}/p1/rename`],
        ["POST", `${API}/p1/archive`],
        ["POST", `${API}/p1/unarchive`],
        ["POST", `${API}/p1/delete`],
      ],
    );
    // A body-bearing hop declares JSON; a body-less action does not (Fastify
    // rejects an empty JSON body).
    assert.equal(calls[0]!.contentType, "application/json");
    assert.equal(calls[0]!.body, JSON.stringify({ name: "Beta" }));
    assert.equal(calls[1]!.contentType, undefined);
    assert.equal(calls[1]!.body, undefined);
  });
});

test("session rename/archive/unarchive/delete hit the expected action paths", async () => {
  await withFetch({ session: { id: "s1" }, ok: true }, async (calls) => {
    await renameSession(API, "p1", "s1", "Renamed");
    await archiveSession(API, "p1", "s1");
    await unarchiveSession(API, "p1", "s1");
    await deleteSession(API, "p1", "s1");

    assert.deepEqual(
      calls.map((c) => [c.method, c.url]),
      [
        ["POST", `${API}/p1/sessions/s1/rename`],
        ["POST", `${API}/p1/sessions/s1/archive`],
        ["POST", `${API}/p1/sessions/s1/unarchive`],
        ["POST", `${API}/p1/sessions/s1/delete`],
      ],
    );
    assert.equal(calls[0]!.body, JSON.stringify({ title: "Renamed" }));
  });
});

test("fetchProjectSessions can include archived Sessions", async () => {
  await withFetch({ sessions: [] }, async (calls) => {
    await fetchProjectSessions(API, "p1");
    await fetchProjectSessions(API, "p1", { includeArchived: true });
    assert.equal(calls[0]!.url, `${API}/p1/sessions`);
    assert.equal(calls[1]!.url, `${API}/p1/sessions?includeArchived=1`);
  });
});
