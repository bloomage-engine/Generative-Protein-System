"use client";

import { toast } from "sonner";
import { MolqlError, MOLQL_TOOL_NAME } from "@science-studio/molql-viewer/directive";
import { activeStructurePath, useStudioStore } from "@/store/studio-store";
import { registerAction } from "./registry";

/**
 * The `molql` tool handler: parse the tool's JSON result and apply it to the
 * viewer for the structure file the user is CURRENTLY VIEWING.
 *
 * The agent's `molql` carries no file path — it means "the structure currently
 * open" — so the frontend is the authority on which file that is:
 * `activeStructurePath`. When no structure file is being viewed the selection
 * cannot be applied, so we surface a toast instead of silently doing nothing
 * (or drawing on a hidden tab).
 *
 * `@science-studio/molql-viewer` (and molstar with it) is imported DYNAMICALLY
 * so the multi-megabyte viewer only loads when a `molql` result actually
 * arrives — never as part of the chat bundle.
 */
registerAction(MOLQL_TOOL_NAME, async (payload) => {
  const { applyMolqlToolResult, getMolqlViewer } = await import("@science-studio/molql-viewer");
  const path = activeStructurePath(useStudioStore.getState());
  const target = path ? getMolqlViewer(path) : null;
  if (!target) {
    toast.error("Open a structure file to apply this selection", {
      description: path
        ? `The viewer for “${path}” is not ready yet.`
        : "Open the structure file you want to operate on (e.g. a .pdb or .cif).",
    });
    // A MolqlError with an expected code: the bridge treats it as a normal
    // "not applied" (no console.error / Next dev overlay), while the toast above
    // still tells the user what to do.
    throw new MolqlError("Open a structure file to apply this selection.", "NO_VIEWER");
  }
  const directive = await applyMolqlToolResult(payload, { target });
  if (!directive) {
    console.warn("[frontend-actions] molql result carried no MolQL expression", payload);
  }
});
