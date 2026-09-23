/**
 * The scope → tab-strip contract (docs/adr/0025), pure and browserless.
 *
 * An open file belongs to the checkout it was opened under, so `setScope` must
 * drop the tabs when the (Project, Worktree) pair changes and keep them when only
 * the Session moves inside one checkout. `tab-state.test.mjs` drives the same
 * invariant through the real UI; this is the decision itself, so it runs without
 * a Chromium.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useStudioStore } from "../store/studio-store.ts";

const openFile = () => ({ id: "notes.txt", path: "notes.txt", name: "notes.txt" });

test("a worktree switch clears the tabs; a same-worktree Session switch keeps them", () => {
  useStudioStore.setState({
    projectId: "p1",
    activeWorktreeId: "exp-a",
    activeSessionId: "s-exp",
    tabs: [openFile()],
    activeTabPath: "notes.txt",
  });
  const { setScope } = useStudioStore.getState();

  // Same Project, same Worktree: only the conversation moves.
  setScope({ projectId: "p1", worktreeId: "exp-a", sessionId: "s-exp-2" });
  assert.equal(
    useStudioStore.getState().tabs.length,
    1,
    "a same-worktree Session switch must keep the open files",
  );

  // Same Project, another Worktree: the checkout under the tabs changes, so the
  // tabs go.
  setScope({ projectId: "p1", worktreeId: "main", sessionId: null });
  assert.deepEqual(useStudioStore.getState().tabs, [], "a worktree switch must clear the tabs");
  assert.equal(useStudioStore.getState().activeTabPath, null);
});

test("a Project switch clears the tabs", () => {
  useStudioStore.setState({
    projectId: "p1",
    activeWorktreeId: "main",
    activeSessionId: "s1",
    tabs: [openFile()],
    activeTabPath: "notes.txt",
  });
  useStudioStore.getState().setScope({ projectId: "p2", worktreeId: "main", sessionId: "s9" });
  assert.deepEqual(useStudioStore.getState().tabs, [], "a Project switch must clear the tabs");
});
