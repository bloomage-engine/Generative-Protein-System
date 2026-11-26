/**
 * Conformance suite for a runtime adapter's RUN LIFECYCLE.
 *
 * It is driven ONLY through the `RuntimeAdapter` + `RecordStoreLike` contract —
 * never the kit (`SessionRuntime` is implementation, not a seam; docs/adr/0005).
 * The runtime package supplies a scripted-runtime driver so the suite can drive
 * one turn without a network connection or a spawned process, exactly like
 * `testRuntimeFactory` drives the factory surface.
 *
 * This is what makes the run lifecycle a SEAM guarantee rather than a per-
 * adapter convention: the OSS adapters self-test here, and any third-party
 * runtime runs the same suite in its own CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  RecordStoreLike,
  RuntimeAdapter,
  SessionState,
  StateDelta,
} from "@gps/transport/seams";
import { sessionState } from "./session-state.js";

type PersistedRun = Parameters<RecordStoreLike["addRun"]>[0];

export interface AdapterLifecycleCase {
  /** The initialized adapter under test. */
  adapter: RuntimeAdapter;
  /** Runs the case's capturing record store collected (assertions read this). */
  runs: PersistedRun[];
  /**
   * A clean SessionState to drive. Optional: the suite falls back to the
   * published `sessionState()` fixture, so an implementer never hand-writes one
   * (docs/design/implementation-plan.md §5).
   */
  session?(): SessionState;
  /** Drive ONE research turn to completion against the scripted runtime. */
  runTurn(text: string): Promise<StateDelta[]>;
}

async function collect(iter: AsyncIterable<StateDelta>): Promise<StateDelta[]> {
  const out: StateDelta[] = [];
  for await (const delta of iter) out.push(delta);
  return out;
}

function isAddMessage(delta: StateDelta): delta is Extract<StateDelta, { type: "add-message" }> {
  return delta.type === "add-message";
}

export function testAdapterLifecycle(
  name: string,
  make: () => AdapterLifecycleCase | Promise<AdapterLifecycleCase>,
): void {
  test(`${name}: a mount probe reconciles first and terminates`, async () => {
    const lifecycle = await make();
    const deltas = await collect(lifecycle.adapter.run((lifecycle.session ?? sessionState)(), []));
    assert.ok(deltas.length >= 1, "a probe must yield at least the reconcile snapshot");
    assert.equal(deltas[0]!.type, "reconcile", "every run starts with a reconcile delta");
  });

  test(`${name}: a research turn echoes the user, flips running, and persists a Run`, async () => {
    const lifecycle = await make();
    const deltas = await lifecycle.runTurn("lifecycle probe");
    assert.equal(deltas[0]!.type, "reconcile", "the driving run also reconciles first");
    const user = deltas.filter(isAddMessage).find((delta) => delta.message.role === "user");
    assert.ok(user, "the driving user row must be echoed to the client");
    assert.ok(
      deltas.some((delta) => delta.type === "session-status" && delta.status === "running"),
      "the run must flip the session running",
    );
    assert.equal(lifecycle.runs.length, 1, "one research turn persists exactly one Run");
    const run = lifecycle.runs[0]!;
    assert.equal(run.status, "completed");
    assert.ok(run.input.length > 0, "the Run carries its driving input");
  });

  test(`${name}: abort does not throw`, async () => {
    const { adapter } = await make();
    assert.doesNotThrow(() => adapter.abort("conformance"));
  });
}
