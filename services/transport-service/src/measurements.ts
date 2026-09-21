/**
 * Mol* measurement computation for an agent selection.
 *
 * The agent's `measurements` tool must receive the actual numbers (there is no
 * browser → agent result channel), so the service computes them where the tool
 * runs: parse the workspace structure, compile each ordered MolQL selection,
 * and apply the same formulas Mol* uses to draw the measurement. The viewer
 * separately redraws the corresponding `StructureMeasurementManager` object.
 *
 * The values match the on-screen labels exactly: both center a selection with
 * molstar's bounding-sphere center and use `Vec3.distance`/`angle`/
 * `dihedralAngle` (or the principal axes, for orientation/plane).
 */
import {
  compileLoci,
  loadMolstar,
  lociSize,
  parseStructure,
  structureKind,
  UnsupportedStructureFormatError,
  type Molstar,
} from "./structure.js";

/** The measurement kinds, mirroring Mol*'s manager. */
export type MeasurementKind =
  | "label"
  | "distance"
  | "angle"
  | "dihedral"
  | "orientation"
  | "plane";

const KINDS: ReadonlySet<string> = new Set<MeasurementKind>([
  "label",
  "distance",
  "angle",
  "dihedral",
  "orientation",
  "plane",
]);

/** Minimum selection count per kind (orientation/plane accept any set). */
const REQUIRED: Record<MeasurementKind, number> = {
  label: 1,
  distance: 2,
  angle: 3,
  dihedral: 4,
  orientation: 1,
  plane: 1,
};

/** Thrown when the request is a valid structure but an invalid measurement. */
export class MeasurementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeasurementError";
  }
}

export interface MeasurementResult {
  kind: MeasurementKind;
  /** The ordered expressions the computation was scoped to. */
  selections: string[];
  /** Per-kind numeric result (distance/angle/axes/…). */
  values: Record<string, unknown>;
  /** Human/agent-readable one-line summary. */
  text: string;
}

function isKind(value: string): value is MeasurementKind {
  return KINDS.has(value);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function vec3(m: Molstar, value: unknown): [number, number, number] {
  const v = value as ArrayLike<number>;
  return [round(v[0]!), round(v[1]!), round(v[2]!)];
}

/** `chain/resname resno:atom` for a single atom, or `chain/resname resno (n atoms)`. */
function describeLoci(m: Molstar, loci: { structure: unknown; elements: unknown[] }): string {
  const element = loci.elements[0] as
    | { unit: { elements: unknown[] }; indices: unknown }
    | undefined;
  if (!element) return "empty selection";
  const size = m.OrderedSet.size(element.indices);
  if (size === 0) return "empty selection";
  const unitIndex = element.unit.elements[m.OrderedSet.getAt(element.indices, 0)];
  const loc = m.StructureElement.Location.create(loci.structure, element.unit, unitIndex);
  const chain = m.StructureProperties.chain.auth_asym_id(loc);
  const resname = m.StructureProperties.residue.auth_comp_id(loc);
  const resno = m.StructureProperties.residue.auth_seq_id(loc);
  const atom = m.StructureProperties.atom.auth_atom_id(loc);
  const residue = `${chain}/${resname} ${resno}`;
  return size === 1 ? `${residue}:${atom}` : `${residue} (${size} atoms)`;
}

function requireCount(kind: MeasurementKind, selections: string[]): void {
  const required = REQUIRED[kind];
  const flexible = kind === "orientation" || kind === "plane";
  const ok = flexible ? selections.length >= required : selections.length === required;
  if (ok) return;
  const label = `${required} selection${required === 1 ? "" : "s"}`;
  throw new MeasurementError(
    `${kind} needs ${flexible ? "at least " : ""}${label}, got ${selections.length}`,
  );
}

/**
 * Compute a Mol* measurement over the ordered `selections` of a structure file.
 * Throws `UnsupportedStructureFormatError`, `MolqlCompileError` or
 * `MeasurementError` for caller mistakes.
 */
export async function computeMeasurements(input: {
  fileName: string;
  data: Uint8Array;
  kind: string;
  selections: string[];
}): Promise<MeasurementResult> {
  if (!isKind(input.kind)) {
    throw new MeasurementError(
      `unknown measurement "${input.kind}" (expected ${[...KINDS].join(", ")})`,
    );
  }
  const kind = input.kind;
  const selections = input.selections.map((s) => s.trim()).filter((s) => s.length > 0);
  requireCount(kind, selections);

  const fileKind = structureKind(input.fileName);
  if (!fileKind) throw new UnsupportedStructureFormatError(input.fileName);

  const m = loadMolstar();
  const structure = await parseStructure(m, fileKind, input.data);

  const locis = selections.map((molql, i) => {
    const loci = compileLoci(m, structure, molql);
    if (lociSize(m, loci) === 0) {
      throw new MeasurementError(`selection ${i + 1} matched no atoms: ${molql}`);
    }
    return loci;
  });
  const labels = locis.map((loci) => describeLoci(m, loci));

  if (kind === "label") {
    return {
      kind,
      selections,
      values: { labels },
      text: `Label: ${labels.join(", ")}`,
    };
  }

  const centers = locis.map((loci) => m.Loci.getCenter(loci));

  if (kind === "distance") {
    const distance = round(m.Vec3.distance(centers[0], centers[1]));
    return {
      kind,
      selections,
      values: { distance, unit: "Å", a: labels[0], b: labels[1] },
      text: `Distance: ${distance.toFixed(2)} Å — A: ${labels[0]}; B: ${labels[1]}`,
    };
  }

  if (kind === "angle") {
    const vAB = m.Vec3.sub(m.Vec3(), centers[0], centers[1]);
    const vCB = m.Vec3.sub(m.Vec3(), centers[2], centers[1]);
    const angle = round(radToDeg(m.Vec3.angle(vAB, vCB)));
    return {
      kind,
      selections,
      values: { angle, unit: "°", a: labels[0], b: labels[1], c: labels[2] },
      text: `Angle: ${angle.toFixed(2)}° — A: ${labels[0]}; B: ${labels[1]}; C: ${labels[2]}`,
    };
  }

  if (kind === "dihedral") {
    const dihedral = round(
      radToDeg(m.Vec3.dihedralAngle(centers[0], centers[1], centers[2], centers[3])),
    );
    return {
      kind,
      selections,
      values: { dihedral, unit: "°", a: labels[0], b: labels[1], c: labels[2], d: labels[3] },
      text: `Dihedral: ${dihedral.toFixed(2)}° — A: ${labels[0]}; B: ${labels[1]}; C: ${labels[2]}; D: ${labels[3]}`,
    };
  }

  // orientation / plane: the principal axes carry the geometry.
  let axes: { origin: unknown; dirA: unknown; dirB: unknown; dirC: unknown };
  try {
    axes = m.StructureElement.Loci.getPrincipalAxesMany(locis).boxAxes;
  } catch (err) {
    throw new MeasurementError(
      err instanceof Error ? err.message : `could not fit ${kind}: ${String(err)}`,
    );
  }
  const atoms = locis.reduce((sum, loci) => sum + lociSize(m, loci), 0);
  const origin = vec3(m, axes.origin);
  const dirA = vec3(m, axes.dirA);
  const dirB = vec3(m, axes.dirB);
  const dirC = vec3(m, axes.dirC);
  const extents = [round(m.Vec3.magnitude(axes.dirA)), round(m.Vec3.magnitude(axes.dirB)), round(m.Vec3.magnitude(axes.dirC))];

  if (kind === "orientation") {
    return {
      kind,
      selections,
      values: { origin, axes: { a: dirA, b: dirB, c: dirC }, extents, atoms },
      text:
        `Orientation of ${atoms} atoms: origin (${origin.join(", ")}); ` +
        `principal axes A (${dirA.join(", ")}), B (${dirB.join(", ")}), C (${dirC.join(", ")}); ` +
        `extents (${extents.join(", ")}) Å`,
    };
  }

  return {
    kind,
    selections,
    values: { centroid: origin, normal: dirC, extents, atoms },
    text:
      `Best-fit plane of ${atoms} atoms: centroid (${origin.join(", ")}); ` +
      `normal (${dirC.join(", ")})`,
  };
}
