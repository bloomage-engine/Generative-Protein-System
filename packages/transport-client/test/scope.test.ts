/**
 * The client scope module is the one home for the wire claim: fixed key order,
 * empty claims omitted, and the `?`-vs-`&` decision made once. These tests pin
 * the bytes, because every scoped route's correctness depends on them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeBody, scopeQuery, scopedUrl, withScope } from "../src/scope.js";

test("scopeQuery emits the claim in one fixed order and omits empties", () => {
  assert.equal(
    scopeQuery({ projectId: "p1", worktreeId: "exp-a", threadId: "s1" }),
    "projectId=p1&worktreeId=exp-a&threadId=s1",
  );
  // The order is the module's, not the caller's: the same three values always
  // serialize the same way.
  assert.equal(
    scopeQuery({ threadId: "s1", worktreeId: "exp-a", projectId: "p1" }),
    "projectId=p1&worktreeId=exp-a&threadId=s1",
  );
  assert.equal(scopeQuery({ projectId: "p1" }), "projectId=p1");
  assert.equal(scopeQuery({ projectId: "p1", worktreeId: null, threadId: "" }), "projectId=p1");
  assert.equal(scopeQuery({ projectId: null }), "", "a scope that names nothing is an empty query");
});

test("scopeQuery encodes values", () => {
  assert.equal(scopeQuery({ projectId: "proj a" }), "projectId=proj+a");
  assert.equal(scopeQuery({ projectId: "p/1" }), "projectId=p%2F1");
});

test("withScope appends with ? or & depending on the URL it is given", () => {
  assert.equal(withScope("/api/workspace/entries", { projectId: "p1" }), "/api/workspace/entries?projectId=p1");
  // The regression the old per-module builders got wrong: a base that already
  // carries a query must be joined with `&`, never a second `?`.
  assert.equal(
    withScope("/api/workspace/file?path=a%2Fb.txt", { projectId: "p1", worktreeId: "exp-a" }),
    "/api/workspace/file?path=a%2Fb.txt&projectId=p1&worktreeId=exp-a",
  );
  assert.equal(withScope("/api/workspace/file?path=a", { projectId: null }), "/api/workspace/file?path=a");
});

test("scopedUrl trims the api base, appends params first, then the scope", () => {
  assert.equal(
    scopedUrl("/api/workspace/", "/file", { projectId: "p1", worktreeId: "exp-a" }, { path: "a/b.txt", download: true }),
    "/api/workspace/file?path=a%2Fb.txt&download=1&projectId=p1&worktreeId=exp-a",
  );
  assert.equal(
    scopedUrl("/api/projects", "/p1/sessions", { projectId: "p1", worktreeId: "exp-a" }),
    "/api/projects/p1/sessions?projectId=p1&worktreeId=exp-a",
  );
  // false/null/"" params are omitted; a scope-less call is just the path.
  assert.equal(
    scopedUrl("/api/worktrees", "", { projectId: "p1" }, { includeArchived: false, cursor: null }),
    "/api/worktrees?projectId=p1",
  );
});

test("scopeBody is the body claim for the routes that carry it in JSON", () => {
  assert.deepEqual(scopeBody({ projectId: "p1", worktreeId: "exp-a", threadId: "s1" }), {
    projectId: "p1",
    worktreeId: "exp-a",
    threadId: "s1",
  });
  assert.deepEqual(scopeBody({ projectId: "p1", worktreeId: null }), { projectId: "p1" });
  assert.deepEqual(scopeBody({ projectId: null }), {});
});
