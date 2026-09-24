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
  | { kind: "atom"; atom: AtomSelection }
  | { kind: "bond"; a: AtomSelection; b: AtomSelection }
  | {
      kind: "interaction";
      a: AtomSelection;
      b: AtomSelection;
      /** Mol*'s interaction label, e.g. "Hydrogen Bond" (see `interactionTypeLabel`). */
      interactionType: string;
    };

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
 * Select one atom: `(sel.atom.atoms (and … (= atom.name CA)))`. This is the
 * form Mol*'s element picking level ("Atom/Coarse Element") reports.
 */
export function formatAtomMolql(atom: AtomSelection): string {
  return `(sel.atom.atoms ${atomPredicate(atom)})`;
}

/**
 * Select the two endpoint atoms of a pair — the same identity Mol* prints in
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
 * Select the two endpoint atoms of a non-covalent interaction (a Mol* dashed
 * line). MolQL cannot name the interaction type, so the type is carried in the
 * mention label (see `formatStructureMention`) rather than in the expression —
 * the compilable form is the same endpoint union as a bond.
 */
export function formatInteractionMolql(a: AtomSelection, b: AtomSelection): string {
  return formatBondMolql(a, b);
}

/**
 * The composer mention for a structure file plus a MolQL target:
 * `@project-default/boltz_holo.pdb/(sel.atom.res (and …))`. `path` is the
 * workspace-relative path the file tree lists; `project` is the Project id it
 * belongs to (omitted only when the deployment scopes no Project).
 *
 * `label` appends a ` #<label>` suffix (non-covalent interaction types, e.g.
 * ` #Hydrogen Bond`). It is metadata the agent-side tools strip; `#` is not a
 * MolQL symbol, so the expression itself stays intact.
 */
export function formatStructureMention(
  project: string | null | undefined,
  path: string,
  molql: string,
  label?: string,
): string {
  return `@${project ? `${project}/` : ""}${path}/${molql}${label ? ` #${label}` : ""}`;
}

/**
 * A stable identity for a click target, used by the host to decide whether a
 * click is toggling the same item back off. The forms carry exactly the fields
 * the expressions use.
 */
export function molqlTargetKey(target: MolqlTarget): string {
  if (target.kind === "residue") {
    const { chain, resno, resname } = target.residue;
    return `residue:${chain}:${resno}:${resname}`;
  }
  if (target.kind === "atom") {
    const { chain, resno, resname, atomName } = target.atom;
    return `atom:${chain}:${resno}:${resname}:${atomName}`;
  }
  const { chain: ac, resno: ar, resname: an, atomName: aa } = target.a;
  const { chain: bc, resno: br, resname: bn, atomName: ba } = target.b;
  const prefix = target.kind === "interaction" ? `interaction:${target.interactionType}` : "bond";
  return `${prefix}:${ac}:${ar}:${an}:${aa}:${bc}:${br}:${bn}:${ba}`;
}
