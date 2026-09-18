/**
 * Turn a clicked structure element into a MolQL expression and the composer
 * mention text.
 *
 * Deliberately molstar-runtime-free: the click handler in `viewer.ts` reads the
 * chain/residue/atom fields off a Mol* location and hands them here as plain
 * data, so the expression grammar is unit-testable in Node.
 *
 * The forms avoid `sel.atom.pick … :test`, which crashes molstar 5.9 when the
 * test reads a per-atom property without an element context (see the skill's
 * compatibility notes).
 */

/** A residue, identified the way `atom.chain` / `atom.resno` / `atom.resname` read it. */
export interface ResidueSelection {
  /** `atom.chain` (auth asym id). */
  chain: string;
  /** `atom.resno` (auth seq id). */
  resno: number;
  /** `atom.resname` (auth comp id). */
  resname: string;
}

/** One atom, identified by its residue plus `atom.name`. */
export interface AtomSelection extends ResidueSelection {
  /** `atom.name` (auth atom id). */
  atomName: string;
}

/** What a click in selection mode resolved to. */
export type MolqlTarget =
  | { kind: "residue"; residue: ResidueSelection }
  | { kind: "bond"; a: AtomSelection; b: AtomSelection };

/**
 * A Mol* mol-script string literal: bare when it has no characters the reader
 * would split on, backtick-quoted otherwise (mol-script's own "string with
 * spaces" form). Backticks inside the value cannot be escaped, so they are
 * dropped — no real chain/residue/atom name contains one.
 */
function literal(value: string): string {
  return /^[^\s()[\]{}`"]+$/.test(value) ? value : `\`${value.replace(/`/g, "")}\``;
}

/**
 * Select a whole residue:
 * `(sel.atom.res (and (= atom.chain A) (= atom.resno 42) (= atom.resname ALA)))`.
 */
export function formatResidueMolql(residue: ResidueSelection): string {
  return `(sel.atom.res (and (= atom.chain ${literal(residue.chain)}) (= atom.resno ${residue.resno}) (= atom.resname ${literal(residue.resname)})))`;
}

function atomPredicate(atom: AtomSelection): string {
  return `(and (= atom.chain ${literal(atom.chain)}) (= atom.resno ${atom.resno}) (= atom.resname ${literal(atom.resname)}) (= atom.name ${literal(atom.atomName)}))`;
}

/**
 * Select a bond by its two endpoint atoms — the same identity Mol* prints in
 * its bond label (`A | CYS 93 | N ---- ILE 89 | O`):
 * `(sel.atom.atoms (or <atom-a> <atom-b>))`.
 *
 * MolQL has no selector for a single bond, and a bond-type filter
 * (`sel.atom.bonded-pairs :test …`) cannot target one specific pair, so the
 * endpoints are the faithful, compilable form.
 */
export function formatBondMolql(a: AtomSelection, b: AtomSelection): string {
  return `(sel.atom.atoms (or ${atomPredicate(a)} ${atomPredicate(b)}))`;
}

/**
 * The composer mention for a structure file plus a MolQL target:
 * `@boltz_holo.pdb/(sel.atom.res (and …))`. `path` is the workspace-relative
 * path, exactly as the file tree lists it.
 */
export function formatStructureMention(path: string, molql: string): string {
  return `@${path}/${molql}`;
}
