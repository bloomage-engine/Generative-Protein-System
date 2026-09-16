"use client";

import { MOLQL_TOOL_NAME } from "@science-studio/molql-viewer/directive";
import { registerAction } from "./registry";

/**
 * The `molql` tool handler: parse the tool's JSON result and apply it to the
 * active Mol* viewer.
 *
 * `@science-studio/molql-viewer` (and molstar with it) is imported DYNAMICALLY
 * so the multi-megabyte viewer only loads when a `molql` result actually
 * arrives — never as part of the chat bundle.
 */
registerAction(MOLQL_TOOL_NAME, async (payload) => {
  const { applyMolqlToolResult } = await import("@science-studio/molql-viewer");
  const directive = await applyMolqlToolResult(payload);
  if (!directive) {
    console.warn("[frontend-actions] molql result carried no MolQL expression", payload);
  }
});
