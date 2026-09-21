/**
 * Resolve a click's loci into a domain target (residue / atom / bond /
 * non-covalent interaction).
 *
 * Depends on molstar's model layer only (no plugin UI, no DOM), so the click
 * grammar is unit-testable in Node. The browser-only `viewer.ts` subscribes to
 * the click and hands the loci here.
 */

import { Loci } from "molstar/lib/mol-model/loci.js";
import {
  Bond,
  StructureElement,
  StructureProperties,
  type Structure,
  type Unit,
} from "molstar/lib/mol-model/structure.js";
import { Interactions } from "molstar/lib/mol-model-props/computed/interactions/interactions.js";
import type { Features } from "molstar/lib/mol-model-props/computed/interactions/features.js";
import type { AtomSelection, MolqlTarget, ResidueSelection } from "./selection.js";

/** Read the residue identity off a location, or `undefined` for coarse models. */
function readResidue(loc: StructureElement.Location): ResidueSelection | undefined {
  try {
    const chain = StructureProperties.chain.auth_asym_id(loc);
    const resno = StructureProperties.residue.auth_seq_id(loc);
    const resname = StructureProperties.residue.auth_comp_id(loc);
    if (!chain || !resname || typeof resno !== "number") return undefined;
    return { chain, resno, resname };
  } catch {
    return undefined;
  }
}

/** Read one atom (residue identity plus its name) off a location. */
function readAtom(loc: StructureElement.Location): AtomSelection | undefined {
  const residue = readResidue(loc);
  if (!residue) return undefined;
  try {
    const atomName = StructureProperties.atom.auth_atom_id(loc);
    if (!atomName) return undefined;
    return { ...residue, atomName };
  } catch {
    return undefined;
  }
}

/** Read an atom from a unit element index. */
function readUnitAtom(
  structure: Structure,
  unit: Unit,
  unitIndex: StructureElement.UnitIndex,
): AtomSelection | undefined {
  return readAtom(StructureElement.Location.create(structure, unit, unit.elements[unitIndex]));
}

/**
 * Read an interaction endpoint. The element stores a *feature* index, whose
 * representative atom is `members[offsets[index]]` (the same mapping Mol* uses
 * for its interaction label).
 */
function readInteractionAtom(
  loci: Interactions.Loci,
  unit: Unit,
  featureIndex: Features.FeatureIndex,
): AtomSelection | undefined {
  const features = loci.data.interactions.unitsFeatures.get(unit.id);
  if (!features) return undefined;
  const offset = features.offsets[featureIndex];
  if (offset === undefined) return undefined;
  const elementIndex = features.members[offset];
  if (elementIndex === undefined) return undefined;
  return readUnitAtom(loci.data.structure, unit, elementIndex);
}

/** Mol*'s interaction type label, falling back to a generic name. */
function interactionType(loci: Interactions.Loci, element: Interactions.Element): string {
  try {
    return Interactions.locationLabel(
      Interactions.Location(
        loci.data.interactions,
        loci.data.structure,
        element.unitA,
        element.indexA,
        element.unitB,
        element.indexB,
      ),
    );
  } catch {
    return "Interaction";
  }
}

/**
 * Resolve a click's loci into a target. `granularity` is Mol*'s picking level
 * (`plugin.managers.interactivity.props.granularity`): the element level
 * ("Atom/Coarse Element") yields a single atom, everything else a residue. A
 * bond or interaction always yields its two endpoints regardless of level.
 */
export function describeMolqlTarget(
  loci: Loci,
  granularity: Loci.Granularity,
): MolqlTarget | undefined {
  if (Bond.isLoci(loci)) {
    const bond = loci.bonds[0];
    if (!bond) return undefined;
    const a = readUnitAtom(loci.structure, bond.aUnit, bond.aIndex);
    const b = readUnitAtom(loci.structure, bond.bUnit, bond.bIndex);
    return a && b ? { kind: "bond", a, b } : undefined;
  }

  // Non-covalent interaction (a dashed line): a DataLoci, not a bond/element.
  if (Interactions.isLoci(loci)) {
    const element = loci.elements[0];
    if (!element) return undefined;
    const a = readInteractionAtom(loci, element.unitA, element.indexA);
    const b = readInteractionAtom(loci, element.unitB, element.indexB);
    if (!a || !b) return undefined;
    return { kind: "interaction", a, b, interactionType: interactionType(loci, element) };
  }

  if (StructureElement.Loci.is(loci)) {
    const loc = StructureElement.Loci.getFirstLocation(loci);
    if (!loc) return undefined;
    if (Loci.simpleGranularity(granularity) === "element") {
      const atom = readAtom(loc);
      return atom ? { kind: "atom", atom } : undefined;
    }
    const residue = readResidue(loc);
    return residue ? { kind: "residue", residue } : undefined;
  }

  return undefined;
}
