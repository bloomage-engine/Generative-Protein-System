import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  TOOL_DESCRIPTION,
  INTERACTION_TOOL_NAME,
  INTERACTION_DESCRIPTION,
  MEASUREMENTS_TOOL_NAME,
  MEASUREMENTS_DESCRIPTION,
  executeMolqlTool,
  fetchInteractions,
  fetchMeasurements,
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
    "Science Studio structure tools: translate a query into a Mol* mol-script selection for the viewer to apply, compute the non-covalent interactions of a selection, and measure distances/angles/dihedrals/orientation/plane for a set of selections.",

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
      }),
      execute: (args) => executeMolqlTool(args),
    }),

    tool({
      name: INTERACTION_TOOL_NAME,
      description: INTERACTION_DESCRIPTION,
      parameters: Type.Object({
        project: Type.Optional(
          Type.String({
            description:
              'Optional. The Project id from a mention, e.g. "project-default". Omit when the user named no file: the service targets the file the user has open.',
          }),
        ),
        path: Type.Optional(
          Type.String({
            description:
              'Optional. The workspace-relative structure file path, e.g. "boltz_holo.pdb". Omit when the user named no file.',
          }),
        ),
        molql: Type.String({
          description: "The MolQL (mol-script) selection expression from the mention.",
        }),
      }),
      execute: fetchInteractions,
    }),

    tool({
      name: MEASUREMENTS_TOOL_NAME,
      description: MEASUREMENTS_DESCRIPTION,
      parameters: Type.Object({
        kind: Type.Union(
          [
            Type.Literal("label"),
            Type.Literal("distance"),
            Type.Literal("angle"),
            Type.Literal("dihedral"),
            Type.Literal("orientation"),
            Type.Literal("plane"),
          ],
          { description: "Which measurement to compute and draw." },
        ),
        selections: Type.Array(Type.String(), {
          description:
            "Ordered selection items (A, B, C, D): a bare MolQL expression or a full @project/path/molql mention.",
        }),
        project: Type.Optional(
          Type.String({
            description:
              "Optional Project id; read from the first mention when omitted. Omit when the user named no file.",
          }),
        ),
        path: Type.Optional(
          Type.String({
            description:
              "Optional workspace-relative structure file path; read from the first mention when omitted. Omit when the user named no file.",
          }),
        ),
        description: Type.Optional(
          Type.String({
            description: "Short human-readable explanation of what is being measured.",
          }),
        ),
      }),
      execute: fetchMeasurements,
    }),
  ],
});
