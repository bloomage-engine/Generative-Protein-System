import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapCommandEntries,
  OPENCLAW_COMMAND_ALLOWLIST,
  type GatewayCommandEntry,
} from "../src/commands.js";

function entry(over: Partial<GatewayCommandEntry> & { name: string }): GatewayCommandEntry {
  return {
    description: `description for /${over.name}`,
    source: "native",
    scope: "both",
    acceptsArgs: false,
    ...over,
  };
}

const noArgEntries: GatewayCommandEntry[] = [
  ...["model", "fast", "reasoning", "verbose", "trace", "elevated", "status", "tools", "help", "whoami", "context"].map((name) =>
    entry({ name, category: name === "status" || name === "tools" || name === "help" || name === "whoami" || name === "context" ? "status" : "options" }),
  ),
];

test("mapCommandEntries keeps allowlisted native text commands and maps fields", () => {
  const entries = [
    ...noArgEntries,
    // Allowlisted but requires an argument — v1 menu only runs no-arg commands.
    entry({
      name: "think",
      category: "options",
      acceptsArgs: true,
      args: [
        { name: "level", description: "thinking level", type: "string", required: true },
      ],
    }),
    // Research-tool surfaces / channel-only forms are not app commands.
    entry({ name: "weather", source: "skill", category: "tools" }),
    entry({ name: "debug", source: "plugin", category: "management" }),
    entry({ name: "exec", scope: "native", category: "options" }),
  ];

  const descriptors = mapCommandEntries(entries);
  const ids = descriptors.map((d) => d.id).sort();

  assert.deepEqual(
    ids,
    [...OPENCLAW_COMMAND_ALLOWLIST].filter((id) => id !== "think").sort(),
    "everything allowlisted except required-arg 'think' is kept; others dropped",
  );

  const status = descriptors.find((d) => d.id === "status");
  assert.ok(status);
  assert.equal(status.label, "status");
  assert.equal(status.description, "description for /status");
  assert.equal(status.category, "status");
  assert.equal(status.invocationText, "/status", "invocation text is the canonical gateway form");
});

test("mapCommandEntries is empty for an empty or all-excluded catalog", () => {
  assert.deepEqual(mapCommandEntries([]), []);
  assert.deepEqual(
    mapCommandEntries([
      entry({ name: "new", category: "session" }),
      entry({ name: "reset", category: "session" }),
      entry({ name: "tts", category: "media" }),
      entry({ name: "config", category: "management" }),
    ]),
    [],
  );
});
