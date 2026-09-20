import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  TOOL_DESCRIPTION,
  INTERACTION_TOOL_NAME,
  INTERACTION_DESCRIPTION,
  createMolqlResult,
  fetchInteractions,
} from "@science-studio/molql-shared";

/**
 * The `molql` tool for OpenClaw gateways.
 *
 * The model translates a request into a Mol* `mol-script` selection; this tool
 * returns it as structured JSON. The gateway persists the result as the tool
 * call's output, which reaches the Science Studio web viewer and is applied
 * there (semantic validation lives in the browser, where the structure is).
 *
 * The full syntax manual ships under `skill/`; the tool description carries the
 * common-case cheat-sheet.
 */

export default defineToolPlugin({
  id: "molql-tool",
  name: "MolQL",
  description:
    "Science Studio structure tools: translate a query into a Mol* mol-script selection for the viewer to apply, and compute the non-covalent interactions of a selection.",

  tools: (tool) => [
    tool({
      name: "molql",
      description: TOOL_DESCRIPTION,
      parameters: Type.Object({
        molql: Type.String({
          description: "The MolQL (mol-script) selection expression.",
        }),
        description: Type.Optional(
          Type.String({
            description: "Short human-readable explanation of what the selection is.",
          }),
        ),
        focus: Type.Optional(
          Type.Boolean({
            description: "Move the camera to the selection. Defaults to true.",
          }),
        ),
        mode: Type.Optional(
          Type.Union([Type.Literal("select"), Type.Literal("highlight")], {
            description:
              'How to show the selection: "select" (persistent, default) or "highlight" (transient).',
          }),
        ),
      }),
      execute: (args) => createMolqlResult(args),
    }),

    tool({
      name: INTERACTION_TOOL_NAME,
      description: INTERACTION_DESCRIPTION,
      parameters: Type.Object({
        project: Type.String({
          description: 'The Project id from the mention, e.g. "project-default".',
        }),
        path: Type.String({
          description: 'The workspace-relative structure file path, e.g. "boltz_holo.pdb".',
        }),
        molql: Type.String({
          description: "The MolQL (mol-script) selection expression from the mention.",
        }),
      }),
      execute: fetchInteractions,
    }),
  ],
});
