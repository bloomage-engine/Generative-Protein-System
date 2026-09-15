/**
 * The remembered-scope resolution table (docs/adr/0009): which Project/Session a
 * load opens, and what an id the record does not list does to the memory.
 *
 * Pure — no DOM, no Chromium, no web server. The only browser-shaped behaviours
 * (the seeding effect, the URL mirror) are covered by
 * `test/scope-restore.test.mjs` in a real browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseScopeMemory,
  pruneScopeMemory,
  resolveProject,
  resolveSession,
  scopePath,
} from "../lib/scope-memory.ts";

const project = (id) => ({ id, name: id, createdAt: "2026-01-01T00:00:00.000Z" });
const session = (id) => ({ id, projectId: "p1", agentId: "main" });

const PROJECTS = [project("p1"), project("p2")];
const memory = (overrides = {}) => ({
  version: 1,
  lastProjectId: null,
  sessions: {},
  ...overrides,
});

test("parseScopeMemory reads only the shape it knows", () => {
  assert.deepEqual(parseScopeMemory(null), memory());
  assert.deepEqual(parseScopeMemory("not json"), memory());
  assert.deepEqual(parseScopeMemory('"a string"'), memory());
  assert.deepEqual(parseScopeMemory('{"version":2,"lastProjectId":"p1"}'), memory());
  assert.deepEqual(
    parseScopeMemory('{"version":1,"lastProjectId":"p1","sessions":{"p1":"s1","p2":7,"p3":""}}'),
    memory({ lastProjectId: "p1", sessions: { p1: "s1" } }),
  );
});

test("pruneScopeMemory drops what the record no longer lists", () => {
  const pruned = pruneScopeMemory(
    memory({ lastProjectId: "p9", sessions: { p1: "s1", p9: "s9" } }),
    PROJECTS,
  );
  assert.deepEqual(pruned, memory({ lastProjectId: null, sessions: { p1: "s1" } }));
});

test("resolveProject prefers the URL's Project, then the remembered one, then the first", () => {
  const claimed = resolveProject({
    claimedProjectId: "p2",
    claimedSessionId: null,
    memory: memory({ lastProjectId: "p1", sessions: { p1: "s1", p2: "s2" } }),
    projects: PROJECTS,
  });
  assert.equal(claimed.projectId, "p2");
  assert.equal(claimed.sessionHint, "s2", "the URL's Project falls back to its own remembered Session");

  const remembered = resolveProject({
    claimedProjectId: null,
    claimedSessionId: null,
    memory: memory({ lastProjectId: "p2", sessions: { p2: "s2" } }),
    projects: PROJECTS,
  });
  assert.equal(remembered.projectId, "p2");
  assert.equal(remembered.sessionHint, "s2");

  const first = resolveProject({
    claimedProjectId: null,
    claimedSessionId: null,
    memory: memory({ lastProjectId: "p9", sessions: { p9: "s9" } }),
    projects: PROJECTS,
  });
  assert.equal(first.projectId, "p1", "a remembered Project the record does not list is not opened");
  assert.equal(first.sessionHint, null);
  assert.equal(first.memory.lastProjectId, "p1");
  assert.deepEqual(first.memory.sessions, {}, "and its dead entry is dropped");
});

test("resolveProject takes the URL's Session for the URL's Project only", () => {
  const choice = resolveProject({
    claimedProjectId: "p1",
    claimedSessionId: "s-claimed",
    memory: memory({ lastProjectId: "p2", sessions: { p1: "s1", p2: "s2" } }),
    projects: PROJECTS,
  });
  assert.equal(choice.projectId, "p1");
  assert.equal(choice.sessionHint, "s-claimed", "the URL's own claim wins over the memory");

  const foreign = resolveProject({
    // A Session claimed for a Project the URL did not name must not leak across.
    claimedProjectId: null,
    claimedSessionId: "s-claimed",
    memory: memory({ lastProjectId: "p2", sessions: { p2: "s2" } }),
    projects: PROJECTS,
  });
  assert.equal(foreign.projectId, "p2");
  assert.equal(foreign.sessionHint, "s2");
});

test("resolveProject answers an empty install with nothing to open", () => {
  const choice = resolveProject({
    claimedProjectId: "p1",
    claimedSessionId: "s1",
    memory: memory({ lastProjectId: "p1", sessions: { p1: "s1" } }),
    projects: [],
  });
  assert.equal(choice.projectId, null);
  assert.equal(choice.sessionHint, null);
  assert.deepEqual(choice.memory, memory());
});

test("resolveSession opens the hint, else the Project's newest Session", () => {
  const listed = resolveSession({
    projectId: "p1",
    hint: "s1",
    sessions: [session("s1"), session("s2")],
    memory: memory({ lastProjectId: "p1", sessions: { p1: "s1" } }),
  });
  assert.equal(listed.sessionId, "s1");

  const gone = resolveSession({
    projectId: "p1",
    hint: "s-gone",
    sessions: [session("s1"), session("s2")],
    memory: memory({ lastProjectId: "p1", sessions: { p1: "s-gone" } }),
  });
  assert.equal(gone.sessionId, "s2", "an unlisted hint is not opened");
  assert.deepEqual(
    gone.memory,
    memory({ lastProjectId: "p1", sessions: { p1: "s2" } }),
    "and it is not remembered again",
  );

  const empty = resolveSession({
    projectId: "p1",
    hint: "s1",
    sessions: [],
    memory: memory({ lastProjectId: "p1", sessions: { p1: "s1" } }),
  });
  assert.equal(empty.sessionId, null);
  assert.deepEqual(empty.memory, memory({ lastProjectId: "p1" }));
});

test("resolveSession leaves a Project-less scope alone", () => {
  const untouched = memory({ lastProjectId: "p1", sessions: { p1: "s1" } });
  const choice = resolveSession({
    projectId: null,
    hint: "s1",
    sessions: [session("s1")],
    memory: untouched,
  });
  assert.equal(choice.sessionId, null);
  assert.equal(choice.memory, untouched);
});

test("scopePath is the deep-link route only when both halves are known", () => {
  assert.equal(scopePath({ projectId: "p1", sessionId: "s1" }), "/projects/p1/sessions/s1");
  assert.equal(scopePath({ projectId: "p1", sessionId: null }), "/");
  assert.equal(scopePath({ projectId: null, sessionId: "s1" }), "/");
  assert.equal(scopePath({ projectId: null, sessionId: null }), "/");
});
