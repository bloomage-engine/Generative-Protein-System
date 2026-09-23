"use client";

import { toast } from "sonner";
import { MolqlError } from "@science-studio/molql-viewer/directive";
import { MOLQL_MEASUREMENTS_TOOL_NAME } from "@science-studio/molql-viewer/measurement";
import { activeStructurePath, useStudioStore } from "@/store/studio-store";
import { registerAction } from "./registry";

/**
 * The `measurements` tool handler.
 *
 * The service computed the numbers for a SPECIFIC file, and the wire carries its
 * path. We draw the measurement on that file's viewer — bringing its tab to the
 * front so the drawing is visible — never on whatever tab happens to be active,
 * which would draw file A's numbers onto file B.
 *
 * `@science-studio/molql-viewer` (and molstar with it) is imported DYNAMICALLY
 * so the viewer stays out of the chat bundle until a `measurements` result
 * arrives.
 */
registerAction(MOLQL_MEASUREMENTS_TOOL_NAME, async (payload) => {
  const { applyMeasurementToolResult, getMolqlViewer, parseMeasurementToolResult } = await import(
    "@science-studio/molql-viewer"
  );
  const parsed = parseMeasurementToolResult(payload);
  if (!parsed) {
    console.warn("[frontend-actions] measurements result carried no usable directive", payload);
    return;
  }

  const path = parsed.path ?? activeStructurePath(useStudioStore.getState());
  if (!path) {
    toast.error("Open the measured structure file to see this measurement", {
      description: "No structure file is currently open.",
    });
    throw new MolqlError("No structure file is currently open.", "NO_VIEWER");
  }
  const target = getMolqlViewer(path);
  if (!target) {
    toast.error("Open the measured structure file to see this measurement", {
      description: `“${path}” is not open in the viewer.`,
    });
    throw new MolqlError(`"${path}" is not open in the viewer.`, "NO_VIEWER");
  }

  // Reveal the file the numbers belong to (it may be a hidden, background tab)
  // before drawing, so the measurement is actually visible.
  if (path !== useStudioStore.getState().activeTabPath) {
    useStudioStore.getState().setActiveTab(path);
  }

  const directive = await applyMeasurementToolResult(payload, { target });
  if (!directive) {
    console.warn("[frontend-actions] measurements result carried no usable directive", payload);
  }
});
