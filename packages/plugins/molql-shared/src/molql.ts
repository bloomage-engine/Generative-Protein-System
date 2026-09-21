/**
 * Shared MolQL tool execution logic, consumed by both the dsh and openclaw
 * plugins.  Pure functions only — no framework coupling.
 */

export { MOLQL_TOOL_RESULT_TYPE, MOLQL_TOOL_NAME } from "@science-studio/molql-viewer/directive";
import type { MolqlDirective } from "@science-studio/molql-viewer/directive";

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

A viewer mention of the form \`@<project>/<path>/<molql>\` may end with a \` #<interaction type>\` label (e.g. \` #Hydrogen Bond\`); pass only the parenthesized expression.

Symbols are bare; element symbols take a leading underscore (_Fe). Load the "molql" skill for the complete syntax reference.`;

/** The interaction tool asks the Science Studio service, which owns file access. */
export const INTERACTION_TOOL_NAME = "computeInteraction";

export const INTERACTION_DESCRIPTION = `Compute the non-covalent interactions (hydrogen bonds, pi-stacking, cation-pi, halogen bonds, metal coordination) that involve a selection in a workspace structure file, using Mol*'s interaction module.

Call this when the user asks about the interactions of a residue, chemical bond or ligand that appears in the conversation as a mention of the form \`@<project>/<path>/<molql>\`. Split that mention into the three arguments:
- project: the first segment, e.g. "project-default"
- path: the workspace-relative file path, e.g. "boltz_holo.pdb"
- molql: the parenthesized MolQL selection expression (drop a trailing \` #<interaction type>\` label if the mention carries one)

Returns a Markdown table: interaction type, the two atom/residue endpoints, and the distance in Å.`;

/** The measurement tool; the service computes the numbers and the viewer draws them. */
export const MEASUREMENTS_TOOL_NAME = "measurements";

export const MEASUREMENTS_DESCRIPTION = `Measure a molecular structure in the Science Studio viewer: return the numeric result and draw the same measurement in the 3D view.

Provide the ordered selection items as MolQL (mol-script) expressions, or as full \`@<project>/<path>/<molql>\` mentions produced by clicking in the viewer. Order matters (A, B, C, D). Kinds and how many selections each needs:
- label: 1 selection
- distance: 2 selections (A—B), the distance in Å
- angle: 3 selections (A—B—C), the angle in degrees at B
- dihedral: 4 selections (A—B—C—D), the dihedral in degrees
- orientation: 1 or more selections — principal axes / oriented box
- plane: 1 or more selections — best-fit plane

For a verbal request (e.g. "residue 42"), translate it to MolQL first, e.g. \`(sel.atom.res (= atom.resno 42))\`, or a specific atom with \`(sel.atom.atoms (and (= atom.resno 42) (= atom.name CA)))\`. When the items are mentions, project/path are read from the first one; otherwise pass project and path explicitly. A mention may end with a \` #<interaction type>\` label; it is ignored.

Returns the value plus a one-line summary.`;

export const SERVICE_URL = process.env.SCIENCE_STUDIO_SERVICE_URL ?? "http://127.0.0.1:3001";

/** Drop a trailing ` #<interaction type>` label from a mention's molql. */
export function stripMentionLabel(molql: string): string {
  return molql.replace(/\s+#[^#]*$/, "").trim();
}

/**
 * Build the structured MolQL tool result from raw arguments.
 *
 * This is the core execute logic shared by both runtime plugins.  The output
 * conforms to the `MolqlDirective` wire contract parsed by
 * `@science-studio/molql-viewer`'s `parseMolqlToolResult`.
 */
export function createMolqlResult(args: {
  molql: string;
  description?: string;
  focus?: boolean;
  mode?: string;
}): MolqlDirective & { type: string } {
  const mode = args.mode === "highlight" ? "highlight" : "select";
  return {
    type: "molql-selection",
    molql: stripMentionLabel(args.molql),
    ...(args.description ? { description: args.description } : {}),
    focus: args.focus ?? true,
    mode,
  };
}

/**
 * Normalize one measurement selection item: a full
 * `@<project>/<path>/<molql>` mention yields project/path/molql; anything else
 * is a bare MolQL expression (the model translated a verbal description).
 */
export function parseSelectionItem(item: string): { project?: string; path?: string; molql: string } {
  const trimmed = item.trim();
  if (!trimmed.startsWith("@")) return { molql: stripMentionLabel(trimmed) };
  const body = trimmed.slice(1);
  const paren = body.indexOf("(");
  if (paren === -1) return { molql: stripMentionLabel(trimmed) };
  const molql = stripMentionLabel(body.slice(paren));
  const prefix = body.slice(0, paren).replace(/\/+$/, "");
  const slash = prefix.indexOf("/");
  if (slash === -1) return { path: prefix, molql };
  return { project: prefix.slice(0, slash), path: prefix.slice(slash + 1), molql };
}

/**
 * Fetch computed measurement values from the Science Studio service.
 *
 * Called by the `measurements` tool — the service owns file access and runs the
 * headless Mol* computation (the same formulas the viewer draws with).
 */
export async function fetchMeasurements(args: {
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

/**
 * Fetch non-covalent interaction data from the Science Studio service.
 *
 * Called by the `computeInteraction` tool — the tool that needs server-side
 * file access and a headless Mol* computation.
 */
export async function fetchInteractions(args: {
  project: string;
  path: string;
  molql: string;
}): Promise<{ table: string }> {
  const url = `${SERVICE_URL}/api/workspace/interactions?project=${encodeURIComponent(
    args.project,
  )}&path=${encodeURIComponent(args.path)}&molql=${encodeURIComponent(
    stripMentionLabel(args.molql),
  )}`;
  const response = await fetch(url);
  const body = (await response.json().catch(() => null)) as { table?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `interaction service answered ${response.status}`);
  }
  return { table: body?.table ?? "" };
}
