import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
// Type-only: brings in the `ctx.skills` module augmentation.
import type {} from "@deepseek-ai/dsh-skill";
import {
  TOOL_DESCRIPTION,
  INTERACTION_TOOL_NAME,
  INTERACTION_DESCRIPTION,
  createMolqlResult,
  fetchInteractions,
} from "@science-studio/molql-shared";

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
        return createMolqlResult(args);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: INTERACTION_TOOL_NAME,
      description: INTERACTION_DESCRIPTION,
      parameters: {
        project: {
          type: "string",
          required: true,
          description: 'The Project id from the mention, e.g. "project-default".',
        },
        path: {
          type: "string",
          required: true,
          description: 'The workspace-relative structure file path, e.g. "boltz_holo.pdb".',
        },
        molql: {
          type: "string",
          required: true,
          description: "The MolQL (mol-script) selection expression from the mention.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            table: { type: "string", required: true },
          },
        },
        render: (_args, value): ContentBlock[] => [{ type: "text", text: value.table }],
      },
      async execute(args) {
        return fetchInteractions(args);
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
