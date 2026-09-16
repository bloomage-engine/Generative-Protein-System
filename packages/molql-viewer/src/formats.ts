import type { BuiltInTrajectoryFormat } from "molstar/lib/mol-plugin-state/formats/trajectory";

/**
 * Structure-file format detection.
 *
 * Pure and molstar-runtime-free on purpose: the type import above is erased at
 * compile time, so this module can be unit-tested in Node even though molstar
 * itself cannot be imported there (molstar ships no `"type": "module"` and its
 * `lib/*.js` are ESM, which Node/tsx would misparse as CJS).
 *
 * BCIF is not a `BuiltInTrajectoryFormat`; it is the binary encoding of mmCIF,
 * so it maps to `{ format: "mmcif", isBinary: true }`.
 */
export interface StructureFormat {
  format: BuiltInTrajectoryFormat;
  isBinary: boolean;
}

/** Extension (after stripping a trailing `.gz`) → structure format. */
const BY_EXTENSION: Record<string, StructureFormat> = {
  pdb: { format: "pdb", isBinary: false },
  ent: { format: "pdb", isBinary: false },
  cif: { format: "mmcif", isBinary: false },
  mmcif: { format: "mmcif", isBinary: false },
  bcif: { format: "mmcif", isBinary: true },
  mol: { format: "mol", isBinary: false },
  mol2: { format: "mol2", isBinary: false },
  sdf: { format: "sdf", isBinary: false },
  xyz: { format: "xyz", isBinary: false },
  gro: { format: "gro", isBinary: false },
  pqr: { format: "pqr", isBinary: false },
  pdbqt: { format: "pdbqt", isBinary: false },
};

function extensionOf(fileName: string): string {
  const lower = fileName.toLowerCase();
  const withoutGz = lower.endsWith(".gz") ? lower.slice(0, -3) : lower;
  const dot = withoutGz.lastIndexOf(".");
  return dot === -1 ? "" : withoutGz.slice(dot + 1);
}

/**
 * The molstar format + binary flag for a structure file, or `null` when the
 * name is not a recognized structure format. Case-insensitive; a trailing
 * `.gz` is tolerated (`1abc.pdb.gz`, `1abc.bcif.gz`).
 */
export function structureFormat(fileName: string): StructureFormat | null {
  return BY_EXTENSION[extensionOf(fileName)] ?? null;
}

/** True when the file name looks like a molecular structure file. */
export function isStructureFile(fileName: string): boolean {
  return structureFormat(fileName) !== null;
}
