import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  TOOL_DESCRIPTION,
  INTERACTION_TOOL_NAME,
  INTERACTION_DESCRIPTION,
  MEASUREMENTS_TOOL_NAME,
  MEASUREMENTS_DESCRIPTION,
  executeMolqlTool,
  fetchInteractions,
  fetchMeasurements,
} from "@gps/molql-shared";

export const SKILL_DESCRIPTION =
  "Translate natural-language molecular structure queries into MolQL (Mol* mol-script) selections for the Generative Protein System structure viewer.";

const SKILL_NAME = "molql";

/** The optional `skills` service shape (see the skill registration below). */
interface SkillRegistry {
  register(skill: { name: string; description: string; source: string; content: string }): void;
}

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
        return executeMolqlTool(args);
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
          description:
            'Optional. The Project id from a mention, e.g. "project-default". Omit when the user named no file: the service targets the file the user has open.',
        },
        path: {
          type: "string",
          description:
            'Optional. The workspace-relative structure file path, e.g. "boltz_holo.pdb". Omit when the user named no file.',
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

  ctx.tools.register(
    defineTool({
      name: MEASUREMENTS_TOOL_NAME,
      description: MEASUREMENTS_DESCRIPTION,
      parameters: {
        kind: {
          type: "string",
          required: true,
          enum: ["label", "distance", "angle", "dihedral", "orientation", "plane"],
          description: "Which measurement to compute and draw.",
        },
        selections: {
          type: "array",
          items: { type: "string" },
          required: true,
          description:
            "Ordered selection items (A, B, C, D): a bare MolQL expression or a full @project/path/molql mention.",
        },
        project: {
          type: "string",
          description:
            "Optional Project id; read from the first mention when omitted. Omit when the user named no file.",
        },
        path: {
          type: "string",
          description:
            "Optional workspace-relative structure file path; read from the first mention when omitted. Omit when the user named no file.",
        },
        description: {
          type: "string",
          description: "Short human-readable explanation of what is being measured.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", required: true },
            kind: { type: "string", required: true },
            project: { type: "string", required: true },
            path: { type: "string", required: true },
            selections: { type: "array", items: { type: "string" }, required: true },
            values: { type: "json", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value): ContentBlock[] => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args) {
        return fetchMeasurements(args);
      },
    }),
  );

  // Optional: publish the full manual as an embedded skill when the skill
  // registry is mounted. The tool works without it (the description is the
  // cheat-sheet), so `skills` is injected lazily rather than required. The
  // service is described structurally: @deepseek-ai/dsh-skill is an OPTIONAL
  // peer, and its module augmentation targets the root cordis copy, which does
  // not merge with the copy this package is built against.
  ctx.inject(["skills"], (sk) => {
    const skills = (sk as unknown as { skills?: SkillRegistry }).skills;
    if (!skills) return;
    const content = loadSkillContent();
    if (!content) return;
    skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      source: "runtime",
      content,
    });
  });
}
