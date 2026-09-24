"use client";

import { MOLQL_MEASUREMENTS_TOOL_NAME } from "@science-studio/molstar-viewer/measurement";
import { registerAction } from "./registry";

/**
 * The `measurements` tool handler: parse the tool's JSON result and draw the
 * measurement (label/distance/angle/dihedral/orientation/plane) on the active
 * Mol* viewer.
 *
 * The numbers were computed by the service where the agent's tool runs;
 * this only redraws the same measurement. `@science-studio/molstar-viewer` (and
 * molstar with it) is imported DYNAMICALLY so the viewer stays out of the chat
 * bundle until a `measurements` result actually arrives.
 */
registerAction(MOLQL_MEASUREMENTS_TOOL_NAME, async (payload) => {
  const { applyMeasurementToolResult } = await import("@science-studio/molstar-viewer");
  const directive = await applyMeasurementToolResult(payload);
  if (!directive) {
    console.warn("[frontend-actions] measurements result carried no usable directive", payload);
  }
});
