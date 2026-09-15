import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DSH_COMMAND_DESCRIPTORS,
  DSH_HARNESS_FALLBACK_DESCRIPTORS,
  executeDshCommand,
  mergeCommandDescriptors,
  parseCommandLine,
  type DshCommandFacts,
} from "../src/commands.js";

function facts(over: Partial<DshCommandFacts> = {}): DshCommandFacts {
  return {
    sessionKey: "sess-1",
    profile: "sdk",
    provider: "ollama-local",
    model: "qwen3.8:latest",
    cwd: "/projects/p1",
    harnessSessionId: "sess-1-mf3k-1",
    ...over,
  };
}

test("the catalog is the menu's list: every row's invocation text parses back to its own id", () => {
  assert.deepEqual(
    DSH_COMMAND_DESCRIPTORS.map((d) => d.id),
    ["status", "new"],
  );
  for (const descriptor of DSH_COMMAND_DESCRIPTORS) {
    assert.equal(descriptor.invocationText, `/${descriptor.id}`);
    assert.ok(descriptor.description.length > 0, "a menu row needs a description");
    // The exact text the menu sends must parse back to this row with no
    // argument — otherwise picking the row would answer a usage error.
    assert.deepEqual(parseCommandLine(descriptor.invocationText), { name: descriptor.id, args: "" });
  }
});

test("the cold harness fallback mirrors the pinned profile's own commands", () => {
  assert.deepEqual(
    DSH_HARNESS_FALLBACK_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.invocationText]),
    [
      ["compact", "/compact"],
      ["feedback", "/feedback"],
      ["goal", "/goal"],
      ["permission", "/permission"],
      ["plan", "/plan"],
    ],
  );
  for (const descriptor of DSH_HARNESS_FALLBACK_DESCRIPTORS) {
    assert.equal(descriptor.label, `/${descriptor.id}`);
    assert.ok(descriptor.description.length > 0, "a menu row needs a description");
  }
});

test("the menu is the local pair first, then the harness layer without its names", () => {
  assert.deepEqual(
    mergeCommandDescriptors(DSH_HARNESS_FALLBACK_DESCRIPTORS, DSH_COMMAND_DESCRIPTORS).map((d) => d.id),
    ["status", "new", "compact", "feedback", "goal", "permission", "plan"],
  );
  // A harness command claiming a local name is dropped, never duplicated: the
  // local one is what must work with no harness at all.
  assert.deepEqual(
    mergeCommandDescriptors(
      [{ id: "status", label: "/status", description: "the harness's own", invocationText: "/status" }],
      DSH_COMMAND_DESCRIPTORS,
    ).map((d) => d.id),
    ["status", "new"],
  );
});

test("/status reports the runtime's route, workspace and agent conversation", () => {
  const { reply, resetConversation } = executeDshCommand("/status", facts());
  assert.match(reply, /ollama-local\/qwen3\.8:latest/);
  assert.match(reply, /\/projects\/p1/);
  assert.match(reply, /sess-1-mf3k-1/);
  assert.match(reply, /sdk/, "the harness profile is part of the route");
  assert.equal(resetConversation, undefined, "a status report changes nothing");
});

test("/status says so when no harness conversation exists yet", () => {
  const { reply } = executeDshCommand("/status", facts({ harnessSessionId: null }));
  assert.match(reply, /not started yet/);
});

test("/new drops the agent's conversation and says where the earlier turns stay", () => {
  const { reply, resetConversation } = executeDshCommand("/new", facts());
  assert.equal(resetConversation, true);
  assert.match(reply, /fresh agent conversation/);
});

test("an unknown name at the LOCAL layer is answered there, never left to the model", () => {
  const { reply, resetConversation } = executeDshCommand("/compact", facts());
  assert.match(reply, /Unknown command `\/compact`/);
  assert.match(reply, /`\/status`, `\/new`/, "the local layer names its own two commands");
  assert.equal(resetConversation, undefined);
});

test("a malformed command line gets a syntax reply instead of becoming a prompt", () => {
  for (const line of ["/Status", "//", "/", "/new/today"]) {
    const { reply } = executeDshCommand(line, facts());
    assert.match(reply, /Not a command line/, `${line} is not a command line`);
    assert.doesNotMatch(reply, /Unknown command/, `${line} never parses far enough to be an unknown name`);
  }
});

test("v1 commands take no arguments: extra words answer with usage", () => {
  for (const line of ["/status now", "/new 2"]) {
    const { reply, resetConversation } = executeDshCommand(line, facts());
    assert.match(reply, /Usage: `\/\w+` \(no arguments\)/);
    assert.equal(resetConversation, undefined, "a usage error must not reset anything");
  }
});
