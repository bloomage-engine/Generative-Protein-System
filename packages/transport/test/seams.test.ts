import { test } from "node:test";
import assert from "node:assert/strict";
import * as seams from "../src/seams.js";
import * as root from "../src/index.js";

/**
 * The seam split is a boundary, not a convention: `./seams` carries the contract
 * (interfaces + their error classes + limit constants) while the package root
 * additionally carries the shared kit and the pure single-user defaults.
 * These tests pin both directions so the boundary cannot silently rot.
 */
const CONTRACT_VALUES = [
  "DEFAULT_MAX_UPLOAD_BYTES",
  "DEFAULT_QUOTA_BYTES",
  "WorkspaceNotFoundError",
  "WorkspacePathError",
  "WorkspaceEscapeError",
  "WorkspaceUnavailableError",
  "FileTooLargeError",
  "RuntimeBindingError",
] as const;

const NON_CONTRACT_NAMES = [
  // Kit
  "RunFlow",
  "SessionRuntime",
  "foldState",
  "sameMessages",
  "sameConversation",
  "textOutput",
  "mergeToolResult",
  "renderAttachments",
  "promptWithAttachments",
  "userMessageParts",
  "parseWorkspaceMentions",
  "attachmentsFromMentions",
  "bindingString",
  "bindingOptionalString",
  // Pure single-user defaults
  "LocalPrincipalResolver",
  "LocalEnvironmentProvider",
  "NullWorkspace",
  "NoopQuotaPolicy",
] as const;

test("the seams entry exposes the contract surface", () => {
  for (const name of CONTRACT_VALUES) {
    assert.ok(name in seams, `seams should export ${name}`);
  }
});

test("the seams entry exposes no kit and no defaults", () => {
  for (const name of NON_CONTRACT_NAMES) {
    assert.ok(!(name in seams), `seams must not export ${name}`);
  }
});

test("the package root still carries kit and defaults on top of the contract", () => {
  for (const name of [...CONTRACT_VALUES, ...NON_CONTRACT_NAMES]) {
    assert.ok(name in root, `root should export ${name}`);
  }
});
