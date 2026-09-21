/**
 * Studio store thread windowing: visibleMessageCount state, loadMoreHistory,
 * and resetVisibleMessageCount actions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useStudioStore } from "../store/studio-store.js";

test("has default visibleMessageCount of 20", () => {
  useStudioStore.setState({ visibleMessageCount: 20 });
  const state = useStudioStore.getState();
  assert.equal(state.visibleMessageCount, 20);
});

test("loadMoreHistory increases visibleMessageCount by 20", () => {
  useStudioStore.setState({ visibleMessageCount: 20 });
  const { loadMoreHistory } = useStudioStore.getState();
  loadMoreHistory();
  assert.equal(useStudioStore.getState().visibleMessageCount, 40);
});

test("loadMoreHistory can be called multiple times", () => {
  useStudioStore.setState({ visibleMessageCount: 20 });
  const { loadMoreHistory } = useStudioStore.getState();
  loadMoreHistory();
  loadMoreHistory();
  assert.equal(useStudioStore.getState().visibleMessageCount, 60);
});

test("resetVisibleMessageCount resets to default 20", () => {
  useStudioStore.setState({ visibleMessageCount: 60 });
  const { resetVisibleMessageCount } = useStudioStore.getState();
  resetVisibleMessageCount();
  assert.equal(useStudioStore.getState().visibleMessageCount, 20);
});
