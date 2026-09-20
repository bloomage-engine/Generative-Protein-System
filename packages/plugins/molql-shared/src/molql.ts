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

Symbols are bare; element symbols take a leading underscore (_Fe). Load the "molql" skill for the complete syntax reference.`;

/** The interaction tool asks the Science Studio service, which owns file access. */
export const INTERACTION_TOOL_NAME = "computeInteraction";

export const INTERACTION_DESCRIPTION = `Compute the non-covalent interactions (hydrogen bonds, pi-stacking, cation-pi, halogen bonds, metal coordination) that involve a selection in a workspace structure file, using Mol*'s interaction module.

Call this when the user asks about the interactions of a residue, chemical bond or ligand that appears in the conversation as a mention of the form \`@<project>/<path>/<molql>\`. Split that mention into the three arguments:
- project: the first segment, e.g. "project-default"
- path: the workspace-relative file path, e.g. "boltz_holo.pdb"
- molql: the parenthesized MolQL selection expression

Returns a Markdown table: interaction type, the two atom/residue endpoints, and the distance in Å.`;

export const SERVICE_URL = process.env.SCIENCE_STUDIO_SERVICE_URL ?? "http://127.0.0.1:3001";

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
    molql: args.molql.trim(),
    ...(args.description ? { description: args.description } : {}),
    focus: args.focus ?? true,
    mode,
  };
}

/**
 * Fetch non-covalent interaction data from the Science Studio service.
 *
 * Called by the `computeInteraction` tool — the only tool that needs server-side
 * file access and a headless Mol* computation.
 */
export async function fetchInteractions(args: {
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
