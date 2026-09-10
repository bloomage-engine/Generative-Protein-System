import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttachmentRef } from "../src/index.js";
import { promptWithAttachments, renderAttachments, userMessageParts } from "../src/index.js";

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
