import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttachmentRef } from "../src/index.js";
import {
  attachmentsFromMentions,
  parseWorkspaceMentions,
  promptWithAttachments,
  renderAttachments,
  userMessageParts,
} from "../src/index.js";

const WORKSPACE_FILE: AttachmentRef[] = [
  { kind: "workspace", path: "analysis/plot.png", name: "plot.png", mime: "image/png", size: 12 },
];

test("renderAttachments maps workspace paths through toAgentPath", () => {
  assert.equal(renderAttachments(undefined), "", "nothing to render");
  assert.equal(renderAttachments([]), "", "nothing to render");
  assert.equal(
    renderAttachments(WORKSPACE_FILE, {
      toAgentPath: (relPath) => `/home/node/.openclaw/workspace/${relPath}`,
    }),
    "Attached files:\n- /home/node/.openclaw/workspace/analysis/plot.png (plot.png)",
  );
  assert.equal(
    renderAttachments(WORKSPACE_FILE),
    "Attached files:\n- analysis/plot.png (plot.png)",
  );
});

test("renderAttachments omits the name suffix when it matches the path", () => {
  const same = [{ kind: "workspace", path: "plot.png", name: "plot.png" }] as const;
  assert.equal(renderAttachments(same), "Attached files:\n- plot.png");
});

test("renderAttachments marks an upload as not yet in the workspace", () => {
  assert.equal(
    renderAttachments([{ kind: "upload", name: "notes.md", data: "bm90ZXM=" }]),
    "Attached files:\n- notes.md (not yet in the workspace)",
  );
});

test("promptWithAttachments appends the block only when there is one", () => {
  assert.equal(promptWithAttachments("hi"), "hi");
  assert.equal(promptWithAttachments("hi", []), "hi");
  assert.equal(
    promptWithAttachments("hi", WORKSPACE_FILE),
    "hi\n\nAttached files:\n- analysis/plot.png (plot.png)",
  );
});

test("userMessageParts adds a file part per workspace attachment", () => {
  assert.deepEqual(userMessageParts("hi"), [{ type: "text", text: "hi" }]);
  assert.deepEqual(userMessageParts("hi", WORKSPACE_FILE), [
    { type: "text", text: "hi" },
    {
      type: "file",
      path: "analysis/plot.png",
      name: "plot.png",
      mime: "image/png",
      size: 12,
      source: "workspace",
    },
  ]);
});

test("userMessageParts ignores uploads (nothing to reference yet)", () => {
  assert.deepEqual(
    userMessageParts("hi", [{ kind: "upload", name: "notes.md", data: "bm90ZXM=" }]),
    [{ type: "text", text: "hi" }],
  );
});

test("parseWorkspaceMentions lifts file and directory directives and cleans the text", () => {
  const parsed = parseWorkspaceMentions(
    "look at :file[plot.png]{name=analysis/plot.png} please",
  );
  assert.deepEqual(parsed.mentions, [
    { type: "file", label: "plot.png", id: "analysis/plot.png" },
  ]);
  assert.equal(parsed.text, "look at please", "the directive must not reach the agent as syntax");

  const directory = parseWorkspaceMentions(":directory[analysis]{name=analysis}");
  assert.deepEqual(directory.mentions, [
    { type: "directory", label: "analysis", id: "analysis" },
  ]);
  assert.equal(directory.text, "");
});

test("parseWorkspaceMentions uses the label when the name attribute is omitted", () => {
  assert.deepEqual(parseWorkspaceMentions(":file[plot.png]").mentions, [
    { type: "file", label: "plot.png", id: "plot.png" },
  ]);
});

test("parseWorkspaceMentions leaves other directives and plain text untouched", () => {
  const other = parseWorkspaceMentions(":tool[grep]{name=x}");
  assert.deepEqual(other.mentions, [], "an unknown directive type is not a workspace mention");
  assert.equal(other.text, ":tool[grep]{name=x}", "and is left in the text");

  // No mentions at all: the message must be byte-identical (no trim/collapse).
  assert.equal(parseWorkspaceMentions("  two  spaces  ").text, "  two  spaces  ");
});

test("attachmentsFromMentions maps mention types to workspace references", () => {
  assert.deepEqual(
    attachmentsFromMentions([
      { type: "file", label: "plot.png", id: "analysis/plot.png" },
      { type: "directory", label: "analysis", id: "analysis" },
    ]),
    [
      { kind: "workspace", path: "analysis/plot.png", name: "plot.png", entryKind: "file" },
      { kind: "workspace", path: "analysis", name: "analysis", entryKind: "dir" },
    ],
  );
});

test("a directory attachment is annotated and gets no preview chip", () => {
  const directory: AttachmentRef[] = [
    { kind: "workspace", path: "analysis", name: "analysis", entryKind: "dir" },
  ];
  assert.equal(renderAttachments(directory), "Attached files:\n- analysis (directory)");
  assert.deepEqual(userMessageParts("go", directory), [{ type: "text", text: "go" }]);
});
