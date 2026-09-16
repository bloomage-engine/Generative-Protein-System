import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

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

const TOOL_DESCRIPTION = `Select and highlight atoms in the molecular structure currently open in the Science Studio viewer.

Provide a MolQL (Mol* mol-script) expression. The viewer compiles it and highlights/focuses the matching atoms. Common forms:
- chain: (sel.atom.chains (= atom.chain A))
- residue range: (sel.atom.res (in-range atom.resno 10 20))
- residue name: (sel.atom.res (= atom.resname ALA))
- atom name: (sel.atom.atoms (= atom.name CA))
- element: (sel.atom.atoms (= atom.el _Fe))
- B-factor: (sel.atom.pick (sel.atom.res (= atom.entity-type polymer)) :test (> atom.bfactor 50))
- within distance: (sel.atom.include-surroundings (sel.atom.atoms (= atom.el _Fe)) :radius 5 :as-whole-residues true)
- union: (sel.atom.merge (sel.atom.chains (= atom.chain A)) (sel.atom.chains (= atom.chain B)))
- exclude: (sel.atom.except-by (sel.atom.all) :by (sel.atom.chains (= atom.chain A)))

Symbols are bare; element symbols take a leading underscore (_Fe). Load the "molql" skill for the complete syntax reference.`;

export default defineToolPlugin({
  id: "molql-tool",
  name: "MolQL",
  description:
    "Translate a natural-language molecular structure query into a Mol* mol-script selection and return it as structured JSON for the Science Studio viewer to apply.",

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
      execute: ({ molql, description, focus, mode }) => ({
        type: "molql-selection",
        molql: molql.trim(),
        ...(description ? { description } : {}),
        focus: focus ?? true,
        mode: mode ?? "select",
      }),
    }),
  ],
});
