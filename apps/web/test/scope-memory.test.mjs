/**
 * The remembered-scope resolution table (docs/adr/0009): which
 * Project/Worktree/Session a load opens, and what an id the record does not
 * list does to the memory.
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
  resolveWorktree,
  scopePath,
} from "../lib/scope-memory.ts";

const project = (id) => ({ id, name: id, createdAt: "2026-01-01T00:00:00.000Z" });
const session = (id) => ({ id, projectId: "p1", agentId: "main" });

/** The separator a session key uses, and its JSON-escaped form in stored text. */
const SEP = "\u0000";
const SEP_JSON = "\\u0000";
const wt = (projectId, worktreeId) => `${projectId}${SEP}${worktreeId}`;

const PROJECTS = [project("p1"), project("p2")];
const memory = (overrides = {}) => ({
  version: 1,
  lastProjectId: null,
  worktrees: {},
  sessions: {},
  ...overrides,
});

test("parseScopeMemory reads only the shape it knows", () => {
  assert.deepEqual(parseScopeMemory(null), memory());
  assert.deepEqual(parseScopeMemory("not json"), memory());
  assert.deepEqual(parseScopeMemory('"a string"'), memory());
  assert.deepEqual(parseScopeMemory('{"version":2,"lastProjectId":"p1"}'), memory());
  assert.deepEqual(parseScopeMemory('{"version":1,"lastProjectId":"p1","sessions":{"p1":"s1"}}'), memory({ lastProjectId: "p1", sessions: { p1: "s1" } }));
  assert.deepEqual(
    parseScopeMemory(
      `{"version":1,"lastProjectId":"p1","worktrees":{"p1":"exp-a","p2":7,"p3":""},"sessions":{"p1${SEP_JSON}exp-a":"s1","p2":7,"p3":""}}`,
    ),
    memory({
      lastProjectId: "p1",
      worktrees: { p1: "exp-a" },
      sessions: { [wt("p1", "exp-a")]: "s1" },
    }),
  );
});

test("pruneScopeMemory drops what the record no longer lists", () => {
  const pruned = pruneScopeMemory(
    memory({
      lastProjectId: "p9",
      worktrees: { p9: "exp-a", p1: "exp-a" },
      sessions: { [wt("p1", "main")]: "s1", [wt("p9", "main")]: "s9" },
    }),
    PROJECTS,
  );
  assert.deepEqual(
    pruned,
    memory({
      lastProjectId: null,
      worktrees: { p1: "exp-a" },
      sessions: { [wt("p1", "main")]: "s1" },
    }),
  );

  // A surviving Project keeps its remembered worktree.
  const kept = pruneScopeMemory(
    memory({
      lastProjectId: "p1",
      worktrees: { p1: "exp-a" },
      sessions: { [wt("p1", "exp-a")]: "s1" },
    }),
    PROJECTS,
  );
  assert.equal(kept.worktrees.p1, "exp-a");
});

test("resolveProject prefers the URL's Project, then the remembered one, then the first", () => {
  const claimed = resolveProject({
    claimedProjectId: "p2",
    claimedSessionId: null,
    memory: memory({
      lastProjectId: "p1",
      sessions: { [wt("p1", "main")]: "s1", [wt("p2", "main")]: "s2" },
    }),
    projects: PROJECTS,
  });
  assert.equal(claimed.projectId, "p2");
  assert.equal(claimed.sessionHint, "s2", "the URL's Project falls back to its own remembered Session");

  const remembered = resolveProject({
    claimedProjectId: null,
    claimedSessionId: null,
    memory: memory({ lastProjectId: "p2", sessions: { [wt("p2", "main")]: "s2" } }),
    projects: PROJECTS,
  });
  assert.equal(remembered.projectId, "p2");
  assert.equal(remembered.sessionHint, "s2");

  const first = resolveProject({
    claimedProjectId: null,
    claimedSessionId: null,
    memory: memory({ lastProjectId: "p9", sessions: { [wt("p9", "main")]: "s9" } }),
    projects: PROJECTS,
  });
  assert.equal(first.projectId, "p1", "a remembered Project the record does not list is not opened");
  assert.equal(first.sessionHint, null);
  assert.equal(first.memory.lastProjectId, "p1");
  assert.deepEqual(first.memory.sessions, {}, "and its dead entry is dropped");
});

test("resolveProject remembers the worktree's Session", () => {
  const linked = resolveProject({
    claimedProjectId: null,
    claimedSessionId: null,
    memory: memory({
      lastProjectId: "p1",
      worktrees: { p1: "exp-a" },
      sessions: { [wt("p1", "exp-a")]: "s-exp" },
    }),
    projects: PROJECTS,
  });
  assert.equal(linked.projectId, "p1");
  assert.equal(linked.sessionHint, "s-exp", "the remembered worktree's Session is the hint");
});

test("resolveProject takes the URL's Session for the URL's Project only", () => {
  const choice = resolveProject({
    claimedProjectId: "p1",
    claimedSessionId: "s-claimed",
    memory: memory({
      lastProjectId: "p2",
      sessions: { [wt("p1", "main")]: "s1", [wt("p2", "main")]: "s2" },
    }),
    projects: PROJECTS,
  });
  assert.equal(choice.projectId, "p1");
  assert.equal(choice.sessionHint, "s-claimed", "the URL's own claim wins over the memory");

  const foreign = resolveProject({
    // A Session claimed for a Project the URL did not name must not leak across.
    claimedProjectId: null,
    claimedSessionId: "s-claimed",
    memory: memory({ lastProjectId: "p2", sessions: { [wt("p2", "main")]: "s2" } }),
    projects: PROJECTS,
  });
  assert.equal(foreign.projectId, "p2");
  assert.equal(foreign.sessionHint, "s2");
});

test("resolveProject answers an empty install with nothing to open", () => {
  const choice = resolveProject({
    claimedProjectId: "p1",
    claimedSessionId: "s1",
    memory: memory({ lastProjectId: "p1", sessions: { [wt("p1", "main")]: "s1" } }),
    projects: [],
  });
  assert.equal(choice.projectId, null);
  assert.equal(choice.sessionHint, null);
  assert.deepEqual(choice.memory, memory());
});

test("resolveWorktree claims the URL's worktree when listed, else main", () => {
  const worktrees = [{ id: "main" }, { id: "exp-a" }];
  const empty = parseScopeMemory(null);
  assert.equal(resolveWorktree({ projectId: "p1", claimedWorktreeId: "exp-a", memory: empty, worktrees }).worktreeId, "exp-a");
  assert.equal(resolveWorktree({ projectId: "p1", claimedWorktreeId: "nope", memory: empty, worktrees }).worktreeId, "main");
});

test("resolveWorktree falls back to the remembered worktree, else main", () => {
  const worktrees = [{ id: "main" }, { id: "exp-a" }];
  const remembered = resolveWorktree({
    projectId: "p1",
    claimedWorktreeId: null,
    memory: memory({ lastProjectId: "p1", worktrees: { p1: "exp-a" } }),
    worktrees,
  });
  assert.equal(remembered.worktreeId, "exp-a");
  assert.equal(remembered.memory.worktrees.p1, "exp-a");

  const gone = resolveWorktree({
    projectId: "p1",
    claimedWorktreeId: null,
    memory: memory({ lastProjectId: "p1", worktrees: { p1: "gone" } }),
    worktrees,
  });
  assert.equal(gone.worktreeId, "main", "a remembered worktree the record does not list is not opened");
  assert.equal(gone.memory.worktrees.p1, "main");

  // A claim the record does not list also loses to the remembered one.
  const rememberedWins = resolveWorktree({
    projectId: "p1",
    claimedWorktreeId: "nope",
    memory: memory({ lastProjectId: "p1", worktrees: { p1: "exp-a" } }),
    worktrees,
  });
  assert.equal(rememberedWins.worktreeId, "exp-a");
});

test("resolveWorktree remembers the worktree per Project, never across", () => {
  const p1Worktrees = [{ id: "main" }, { id: "exp-a" }];
  const p2Worktrees = [{ id: "main" }, { id: "exp-a" }];
  // p1 remembers exp-a; p2 has a same-named checkout but remembers nothing.
  const choice = resolveWorktree({
    projectId: "p2",
    claimedWorktreeId: null,
    memory: memory({ lastProjectId: "p1", worktrees: { p1: "exp-a" } }),
    worktrees: p2Worktrees,
  });
  assert.equal(choice.worktreeId, "main", "another Project's same-named worktree is not adopted");
  assert.deepEqual(choice.memory.worktrees, { p1: "exp-a", p2: "main" });
  assert.equal(
    resolveWorktree({
      projectId: "p1",
      claimedWorktreeId: null,
      memory: memory({ lastProjectId: "p1", worktrees: { p1: "exp-a" } }),
      worktrees: p1Worktrees,
    }).worktreeId,
    "exp-a",
    "and each Project keeps its own",
  );
});

test("resolveSession opens the hint, else the Project's newest Session", () => {
  const listed = resolveSession({
    projectId: "p1",
    worktreeId: "main",
    hint: "s1",
    sessions: [session("s1"), session("s2")],
    memory: memory({ lastProjectId: "p1", sessions: { [wt("p1", "main")]: "s1" } }),
  });
  assert.equal(listed.sessionId, "s1");

  const gone = resolveSession({
    projectId: "p1",
    worktreeId: "main",
    hint: "s-gone",
    sessions: [session("s1"), session("s2")],
    memory: memory({ lastProjectId: "p1", sessions: { [wt("p1", "main")]: "s-gone" } }),
  });
  assert.equal(gone.sessionId, "s2", "an unlisted hint is not opened");
  assert.deepEqual(
    gone.memory,
    memory({ lastProjectId: "p1", sessions: { [wt("p1", "main")]: "s2" } }),
    "and it is not remembered again",
  );

  const empty = resolveSession({
    projectId: "p1",
    worktreeId: "main",
    hint: "s1",
    sessions: [],
    memory: memory({ lastProjectId: "p1", sessions: { [wt("p1", "main")]: "s1" } }),
  });
  assert.equal(empty.sessionId, null);
  assert.deepEqual(empty.memory, memory({ lastProjectId: "p1" }));
});

test("resolveSession keeps one Session per (Project, Worktree)", () => {
  const choice = resolveSession({
    projectId: "p1",
    worktreeId: "exp-a",
    hint: "s-exp",
    sessions: [session("s-exp")],
    memory: memory({
      lastProjectId: "p1",
      worktrees: { p1: "exp-a" },
      sessions: { [wt("p1", "main")]: "s-main" },
    }),
  });
  assert.equal(choice.sessionId, "s-exp");
  assert.deepEqual(
    choice.memory.sessions,
    { [wt("p1", "main")]: "s-main", [wt("p1", "exp-a")]: "s-exp" },
    "a worktree switch does not overwrite main's remembered Session",
  );
});

test("resolveSession leaves a Project-less or Worktree-less scope alone", () => {
  const untouched = memory({ lastProjectId: "p1", sessions: { [wt("p1", "main")]: "s1" } });

  const noProject = resolveSession({
    projectId: null,
    worktreeId: "main",
    hint: "s1",
    sessions: [session("s1")],
    memory: untouched,
  });
  assert.equal(noProject.sessionId, null);
  assert.equal(noProject.memory, untouched);

  const noWorktree = resolveSession({
    projectId: "p1",
    worktreeId: null,
    hint: "s1",
    sessions: [session("s1")],
    memory: untouched,
  });
  assert.equal(noWorktree.sessionId, null);
  assert.equal(noWorktree.memory, untouched);
});

test("scopePath is the deep-link route only when all three parts are known", () => {
  assert.equal(
    scopePath({ projectId: "p1", worktreeId: "exp-a", sessionId: "s1" }),
    "/projects/p1/worktrees/exp-a/sessions/s1",
  );
  assert.equal(scopePath({ projectId: "p1", worktreeId: "main", sessionId: null }), "/");
  assert.equal(scopePath({ projectId: "p1", worktreeId: null, sessionId: "s1" }), "/");
  assert.equal(scopePath({ projectId: null, worktreeId: "main", sessionId: "s1" }), "/");
  assert.equal(scopePath({ projectId: null, worktreeId: null, sessionId: null }), "/");
});

test("scopePath nests the worktree segment", () => {
  assert.equal(
    scopePath({ projectId: "p1", worktreeId: "exp-a", sessionId: "s1" }),
    "/projects/p1/worktrees/exp-a/sessions/s1",
  );
});
