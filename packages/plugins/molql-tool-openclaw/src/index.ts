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
  values: unknown;
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
    values?: unknown;
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
          Type.String({ description: "The Project id; read from the first mention when omitted." }),
        ),
        path: Type.Optional(
          Type.String({
            description:
              "The workspace-relative structure file path; read from the first mention when omitted.",
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
