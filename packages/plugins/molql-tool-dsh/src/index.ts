import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

/** The optional `skills` service shape (see the skill registration below). */
interface SkillRegistry {
  register(skill: { name: string; description: string; source: string; content: string }): void;
}

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

/** The interaction tool asks the Science Studio service, which owns file access. */
const INTERACTION_TOOL_NAME = "computeInteraction";

const INTERACTION_DESCRIPTION = `Compute the non-covalent interactions (hydrogen bonds, pi-stacking, cation-pi, halogen bonds, metal coordination) that involve a selection in a workspace structure file, using Mol*'s interaction module.

Call this when the user asks about the interactions of a residue, chemical bond or ligand that appears in the conversation as a mention of the form \`@<project>/<path>/<molql>\`. Split that mention into the three arguments:
- project: the first segment, e.g. "project-default"
- path: the workspace-relative file path, e.g. "boltz_holo.pdb"
- molql: the parenthesized MolQL selection expression

Returns a Markdown table: interaction type, the two atom/residue endpoints, and the distance in Å.`;

/** The measurement tool; the service computes the numbers and the viewer draws them. */
const MEASUREMENTS_TOOL_NAME = "measurements";

const MEASUREMENTS_DESCRIPTION = `Measure a molecular structure in the Science Studio viewer: return the numeric result and draw the same measurement in the 3D view.

Provide the ordered selection items as MolQL (mol-script) expressions, or as full \`@<project>/<path>/<molql>\` mentions produced by clicking in the viewer. Order matters (A, B, C, D). Kinds and how many selections each needs:
- label: 1 selection
- distance: 2 selections (A—B), the distance in Å
- angle: 3 selections (A—B—C), the angle in degrees at B
- dihedral: 4 selections (A—B—C—D), the dihedral in degrees
- orientation: 1 or more selections — principal axes / oriented box
- plane: 1 or more selections — best-fit plane

For a verbal request (e.g. "residue 42"), translate it to MolQL first, e.g. \`(sel.atom.res (= atom.resno 42))\`, or a specific atom with \`(sel.atom.atoms (and (= atom.resno 42) (= atom.name CA)))\`. When the items are mentions, project/path are read from the first one; otherwise pass project and path explicitly.

Returns the value plus a one-line summary.`;

const SERVICE_URL = process.env.SCIENCE_STUDIO_SERVICE_URL ?? "http://127.0.0.1:3001";

/**
 * Normalize one measurement selection item: a full
 * `@<project>/<path>/<molql>` mention yields project/path/molql; anything else
 * is a bare MolQL expression (the model translated a verbal description).
 */
function parseSelectionItem(item: string): { project?: string; path?: string; molql: string } {
  const trimmed = item.trim();
  if (!trimmed.startsWith("@")) return { molql: trimmed };
  const body = trimmed.slice(1);
  const paren = body.indexOf("(");
  if (paren === -1) return { molql: trimmed };
  const molql = body.slice(paren).trim();
  const prefix = body.slice(0, paren).replace(/\/+$/, "");
  const slash = prefix.indexOf("/");
  if (slash === -1) return { path: prefix, molql };
  return { project: prefix.slice(0, slash), path: prefix.slice(slash + 1), molql };
}

async function fetchMeasurements(args: {
  kind: string;
  selections: string[];
  project?: string;
  path?: string;
}): Promise<{
  type: string;
  kind: string;
  project: string;
  path: string;
  selections: string[];
  values: JsonValue;
  text: string;
}> {
  const parsed = args.selections.map(parseSelectionItem);
  const selections = parsed.map((p) => p.molql).filter((s) => s.length > 0);
  const project = args.project ?? parsed.find((p) => p.project)?.project;
  const path = args.path ?? parsed.find((p) => p.path)?.path;
  if (!project || !path) {
    throw new Error(
      "could not determine project/path: pass them explicitly or use a full @project/path/molql mention",
    );
  }
  const response = await fetch(`${SERVICE_URL}/api/workspace/measurements`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, path, kind: args.kind, selections }),
  });
  const body = (await response.json().catch(() => null)) as {
    values?: JsonValue;
    text?: string;
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `measurement service answered ${response.status}`);
  }
  return {
    type: "molql-measurements",
    kind: args.kind,
    project,
    path,
    selections,
    values: body?.values ?? {},
    text: body?.text ?? "",
  };
}

async function fetchInteractions(args: {
  project: string;
  path: string;
  molql: string;
}): Promise<{ table: string }> {
  const url = `${SERVICE_URL}/api/workspace/interactions?project=${encodeURIComponent(
    args.project,
  )}&path=${encodeURIComponent(args.path)}&molql=${encodeURIComponent(args.molql)}`;
  const response = await fetch(url);
  const body = (await response.json().catch(() => null)) as { table?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `interaction service answered ${response.status}`);
  }
  return { table: body?.table ?? "" };
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
          description: "The Project id; read from the first mention when omitted.",
        },
        path: {
          type: "string",
          description: "The workspace-relative structure file path; read from the first mention when omitted.",
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
