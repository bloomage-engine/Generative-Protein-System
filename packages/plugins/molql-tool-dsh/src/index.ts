import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
// Type-only: brings in the `ctx.skills` module augmentation.
import type {} from "@deepseek-ai/dsh-skill";

/**
 * The `molql` tool for the DeepSeek Harness.
 *
 * The model translates a natural-language request into a Mol* `mol-script`
 * selection; this tool forwards it as structured JSON that the Science Studio
 * web viewer compiles and highlights. The tool itself never touches a structure
 * — semantic validation (does the selection match anything) happens in the
 * browser, where the structure lives.
 *
 * The full syntax manual ships under `skill/` and is registered as an embedded
 * skill, so the model can load it on demand.
 */

/** Compact cheat-sheet for the common cases; the skill carries the full manual. */
export const TOOL_DESCRIPTION = `Select and highlight atoms in the molecular structure currently open in the Science Studio viewer.

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

export const SKILL_DESCRIPTION =
  "Translate natural-language molecular structure queries into MolQL (Mol* mol-script) selections for the Science Studio structure viewer.";

const SKILL_NAME = "molql";

export const name = "molql-tool";

/** The tool registry; the skill registry is optional (registered via inject). */
export const inject = ["tools"];

function loadSkillContent(): string | null {
  try {
    const body = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
    const reference = readFileSync(
      new URL("../skill/references/molql-syntax.md", import.meta.url),
      "utf8",
    );
    return `${body}\n\n---\n\n# Full MolQL syntax reference\n\n${reference}`;
  } catch {
    return null;
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: SKILL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: {
        molql: {
          type: "string",
          required: true,
          description: "The MolQL (mol-script) selection expression.",
        },
        description: {
          type: "string",
          description: "Short human-readable explanation of what the selection is.",
        },
        focus: {
          type: "boolean",
          description: "Move the camera to the selection. Defaults to true.",
        },
        mode: {
          type: "string",
          description:
            'How to show the selection: "select" (persistent, default) or "highlight" (transient).',
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", required: true },
            molql: { type: "string", required: true },
            description: { type: "string" },
            focus: { type: "boolean" },
            mode: { type: "string" },
          },
        },
        render: (_args, value): ContentBlock[] => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args) {
        const mode = args.mode === "highlight" ? "highlight" : "select";
        return {
          type: "molql-selection",
          molql: args.molql.trim(),
          ...(args.description ? { description: args.description } : {}),
          focus: args.focus ?? true,
          mode,
        };
      },
    }),
  );

  // Optional: publish the full manual as an embedded skill when the skill
  // registry is mounted. The tool works without it (the description is the
  // cheat-sheet), so `skills` is injected lazily rather than required.
  ctx.inject(["skills"], (sk) => {
    const content = loadSkillContent();
    if (!content) return;
    sk.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      source: "runtime",
      content,
    });
  });
}
