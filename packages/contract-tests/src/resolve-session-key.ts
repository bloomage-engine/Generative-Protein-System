/**
 * Conformance suite for `RuntimeAdapter.resolveSessionKey` — the seam member
 * that decides WHICH conversation a client's request lands in.
 *
 * The shipped runtimes namespace sessions differently (openclaw passes
 * `agent:…` through and collapses everything else; dsh takes any non-local id
 * verbatim), so this suite asserts only what the SEAM requires of every runtime,
 * not any one runtime's mapping:
 *
 * - a claim of no session (the mount probe) and assistant-ui's per-page local
 *   `__LOCALID_*` id must converge on the SAME canonical key;
 * - that key must be non-empty and stable, and the local id must never become
 *   the canonical session.
 *
 * Convergence is the whole point: the mount probe reconciles one transcript and
 * a send drives another, so a runtime that resolved those two differently would
 * reconcile the reply against a transcript the user never sent. What a runtime
 * does with a REAL client id (pass it through? namespace it?) is that runtime's
 * own policy and belongs in its own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeAdapter } from "@gps/transport/seams";

/** assistant-ui's local-mint prefix, as both shipped runtimes recognize it. */
const DEFAULT_LOCAL_IDS = ["__LOCALID_abc123", "__LOCALID_zzz"];

export interface ResolveSessionKeyCase {
  /** The adapter under test (already constructed the way its runtime needs). */
  adapter: RuntimeAdapter;
  /** Override the local-mint samples when a runtime recognizes other ids. */
  localIds?: readonly string[];
}

/**
 * The seam makes `resolveSessionKey` optional, so the suite narrows it here
 * (called as a method, since an implementation reads its own config).
 */
function resolveKey(adapter: RuntimeAdapter, threadId: string | null): string {
  const resolve = adapter.resolveSessionKey;
  assert.equal(
    typeof resolve,
    "function",
    "the runtime must implement resolveSessionKey (omit it only when raw client ids ARE canonical)",
  );
  return resolve!.call(adapter, threadId);
}

export function testResolveSessionKey(
  name: string,
  make: () => ResolveSessionKeyCase | Promise<ResolveSessionKeyCase>,
): void {
  test(`${name}: an unclaimed session and a local-mint id converge on one key`, async () => {
    const { adapter, localIds = DEFAULT_LOCAL_IDS } = await make();

    const unclaimed = resolveKey(adapter, null);
    assert.ok(unclaimed.length > 0, "an unclaimed session must resolve to a non-empty canonical key");

    for (const localId of localIds) {
      const resolved = resolveKey(adapter, localId);
      assert.equal(
        resolved,
        unclaimed,
        `the local-mint id "${localId}" must converge on the same key as an unclaimed session — otherwise a mount probe and a send reconcile different transcripts`,
      );
      assert.notEqual(resolved, localId, "assistant-ui's per-page local id must never become the canonical session");
    }
  });

  test(`${name}: the canonical key is stable across calls`, async () => {
    const { adapter } = await make();
    assert.equal(
      resolveKey(adapter, null),
      resolveKey(adapter, null),
      "the same claim must resolve to the same key on every call (probe and send must agree)",
    );
  });
}
