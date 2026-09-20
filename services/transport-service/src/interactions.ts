/**
 * Non-covalent interaction computation for an agent selection.
 *
 * Mol* computes interactions in pure JS (no WebGL), so the service can answer
 * the `computeInteraction` tool without the browser: parse the workspace file,
 * compile the MolQL selection, run molstar's `computeInteractions`, and return
 * the contacts that touch the selection.
 *
 * molstar ships ESM `lib/*.js` without `"type": "module"`, so a Node ESM service
 * cannot `import` it; this module loads its CommonJS build through
 * `createRequire` lazily (molstar is heavy — never pay for it until a tool call
 * asks).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Cap on the structure file parsed for one computation. */
export const INTERACTIONS_MAX_BYTES = 50 * 1024 * 1024;

/** Upper bound on returned rows; the table notes when it clips. */
const MAX_ROWS = 500;

/** Thrown when the file name is not a structure format this route can parse. */
export class UnsupportedStructureFormatError extends Error {
  constructor(fileName: string) {
    super(`not a supported structure file: ${fileName}`);
    this.name = "UnsupportedStructureFormatError";
  }
}

/** Thrown when the MolQL expression does not compile against the structure. */
export class MolqlCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MolqlCompileError";
  }
}

export interface InteractionRow {
  type: string;
  /** `chain/resname resno:atom` of the first feature's representative atom. */
  from: string;
  /** The same for the second feature. */
  to: string;
  /** Distance between the two features' representative atoms, in Angstrom. */
  distance: number;
}

export interface InteractionResult {
  /** The MolQL expression the computation was scoped to. */
  target: string;
  counts: Record<string, number>;
  rows: InteractionRow[];
  /** True when more interactions existed than `MAX_ROWS`. */
  truncated: boolean;
  /** Human/agent-readable Markdown table. */
  table: string;
}

type StructureKind = "pdb" | "mmcif" | "bcif";

function structureKind(fileName: string): StructureKind | null {
  const lower = fileName.toLowerCase().replace(/\.gz$/, "");
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  if (ext === "pdb" || ext === "ent") return "pdb";
  if (ext === "cif" || ext === "mmcif") return "mmcif";
  if (ext === "bcif") return "bcif";
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Molstar = {
  parsePDB: any;
  trajectoryFromPDB: any;
  parseCifText: any;
  parseCifBinary: any;
  trajectoryFromMmCIF: any;
  Structure: any;
  Unit: any;
  OrderedSet: any;
  Vec3: any;
  Script: any;
  RuntimeContext: any;
  ParamDefinition: any;
  InteractionsProvider: any;
  computeInteractions: any;
  interactionTypeLabel: any;
  InteractionFlag: any;
  StructureElement: any;
  StructureProperties: any;
};

let cachedMolstar: Molstar | undefined;

/** Load molstar's CommonJS build once, on the first computation. */
function loadMolstar(): Molstar {
  if (cachedMolstar) return cachedMolstar;
  const m = (path: string): any => require(`molstar/lib/commonjs/${path}`);
  cachedMolstar = {
    parsePDB: m("mol-io/reader/pdb/parser.js").parsePDB,
    trajectoryFromPDB: m("mol-model-formats/structure/pdb.js").trajectoryFromPDB,
    parseCifText: m("mol-io/reader/cif/text/parser.js").parseCifText,
    parseCifBinary: m("mol-io/reader/cif/binary/parser.js").parseCifBinary,
    trajectoryFromMmCIF: m("mol-model-formats/structure/mmcif.js").trajectoryFromMmCIF,
    Structure: m("mol-model/structure.js").Structure,
    Unit: m("mol-model/structure.js").Unit,
    StructureElement: m("mol-model/structure.js").StructureElement,
    StructureProperties: m("mol-model/structure.js").StructureProperties,
    OrderedSet: m("mol-data/int.js").OrderedSet,
    Vec3: m("mol-math/linear-algebra.js").Vec3,
    Script: m("mol-script/script.js").Script,
    RuntimeContext: m("mol-task/index.js").RuntimeContext,
    ParamDefinition: m("mol-util/param-definition.js").ParamDefinition,
    InteractionsProvider: m("mol-model-props/computed/interactions.js").InteractionsProvider,
    computeInteractions: m("mol-model-props/computed/interactions/interactions.js")
      .computeInteractions,
    interactionTypeLabel: m("mol-model-props/computed/interactions/common.js")
      .interactionTypeLabel,
    InteractionFlag: m("mol-model-props/computed/interactions/common.js").InteractionFlag,
  };
  return cachedMolstar;
}

async function parseStructure(
  m: Molstar,
  kind: StructureKind,
  data: Uint8Array,
): Promise<any> {
  if (kind === "pdb") {
    const parsed = await m.parsePDB(new TextDecoder().decode(data)).run();
    const trajectory = await m.trajectoryFromPDB(parsed.result).run();
    return m.Structure.ofModel(trajectory.representative);
  }
  if (kind === "mmcif") {
    const parsed = await m.parseCifText(new TextDecoder().decode(data)).run();
    const trajectory = await m.trajectoryFromMmCIF(parsed.result).run();
    return m.Structure.ofModel(trajectory.representative);
  }
  const parsed = await m.parseCifBinary(data).run();
  const trajectory = await m.trajectoryFromMmCIF(parsed.result).run();
  return m.Structure.ofModel(trajectory.representative);
}

interface FeatureLabel {
  label: string;
  position: unknown;
}

/** Resolve a feature's representative atom into `chain/resname resno:atom` + its position. */
function featureLabel(
  m: Molstar,
  structure: any,
  unit: any,
  features: any,
  featureIndex: number,
): FeatureLabel {
  const unitIndex = features.members[features.offsets[featureIndex]];
  const element = unit.elements[unitIndex];
  const loc = m.StructureElement.Location.create(structure, unit, element);
  const chain = m.StructureProperties.chain.auth_asym_id(loc);
  const resname = m.StructureProperties.residue.auth_comp_id(loc);
  const resno = m.StructureProperties.residue.auth_seq_id(loc);
  const atom = m.StructureProperties.atom.auth_atom_id(loc);
  const position = m.Vec3();
  unit.conformation.position(element, position);
  return { label: `${chain}/${resname} ${resno}:${atom}`, position };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function collectRows(
  m: Molstar,
  structure: any,
  interactions: any,
  loci: any,
): { rows: InteractionRow[]; truncated: boolean } {
  const { contacts, unitsContacts, unitsFeatures } = interactions;
  const rows: InteractionRow[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const push = (type: number, a: FeatureLabel, b: FeatureLabel): void => {
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      return;
    }
    const [first, second] = [a.label, b.label].sort();
    const key = `${type}|${first}|${second}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      type: m.interactionTypeLabel(type),
      from: a.label,
      to: b.label,
      distance: round(m.Vec3.distance(a.position, b.position)),
    });
  };

  for (const e of loci.elements) {
    if (!m.Unit.isAtomic(e.unit)) continue;
    const unit = e.unit;
    const features = unitsFeatures.get(unit.id);
    if (!features) continue;

    // Inter-unit contacts: ask the contact graph for the edges touching each
    // selected atom.
    m.OrderedSet.forEach(e.indices, (unitIndex: number) => {
      for (const edgeIndex of contacts.getContactIndicesForElement(unitIndex, unit)) {
        const edge = contacts.edges[edgeIndex];
        if (edge.props.flag === m.InteractionFlag.Filtered) continue;
        const unitA = structure.unitMap.get(edge.unitA);
        const unitB = structure.unitMap.get(edge.unitB);
        const featuresA = unitsFeatures.get(edge.unitA);
        const featuresB = unitsFeatures.get(edge.unitB);
        if (!unitA || !unitB || !featuresA || !featuresB) continue;
        push(
          edge.props.type,
          featureLabel(m, structure, unitA, featuresA, edge.indexA),
          featureLabel(m, structure, unitB, featuresB, edge.indexB),
        );
      }
    });

    // Intra-unit contacts (same chain/unit): the graph has no per-element lookup,
    // so go element -> features -> contact offsets.
    const intra = unitsContacts.get(unit.id);
    if (!intra) continue;
    const { offsets: featureOffsets, indices: featureIndices } = features.elementsIndex;
    const touched = new Set<number>();
    m.OrderedSet.forEach(e.indices, (unitIndex: number) => {
      for (let i = featureOffsets[unitIndex]; i < featureOffsets[unitIndex + 1]; i++) {
        const feature = featureIndices[i];
        for (let j = intra.offset[feature]; j < intra.offset[feature + 1]; j++) touched.add(j);
      }
    });
    const { type, flag } = intra.edgeProps;
    for (const edgeIndex of touched) {
      if (flag[edgeIndex] === m.InteractionFlag.Filtered) continue;
      push(
        type[edgeIndex],
        featureLabel(m, structure, unit, features, intra.a[edgeIndex]),
        featureLabel(m, structure, unit, features, intra.b[edgeIndex]),
      );
    }
  }

  return { rows, truncated };
}

function renderTable(target: string, rows: InteractionRow[], truncated: boolean): string {
  const lines = [
    `Selected: ${target}`,
    "",
    "| Interaction | From | To | Distance (Å) |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row.type} | ${row.from} | ${row.to} | ${row.distance.toFixed(2)} |`),
  ];
  if (truncated) lines.push("", `_Showing the first ${rows.length} interactions._`);
  return lines.join("\n");
}

/**
 * Compute the non-covalent interactions that touch `molql`'s selection in
 * `data` (a PDB/mmCIF/BCIF structure). Throws `UnsupportedStructureFormatError`
 * or `MolqlCompileError` for caller mistakes.
 */
export async function computeInteractionsForSelection(input: {
  fileName: string;
  data: Uint8Array;
  molql: string;
}): Promise<InteractionResult> {
  const kind = structureKind(input.fileName);
  if (!kind) throw new UnsupportedStructureFormatError(input.fileName);

  const m = loadMolstar();
  const structure = await parseStructure(m, kind, input.data);

  const target = input.molql.trim();
  let loci: any;
  try {
    loci = m.Script.toLoci({ expression: target, language: "mol-script" }, structure);
  } catch (err) {
    throw new MolqlCompileError(
      err instanceof Error ? err.message : `invalid MolQL: ${String(err)}`,
    );
  }

  const props = m.ParamDefinition.getDefaultValues(m.InteractionsProvider.defaultParams);
  const context = { runtime: m.RuntimeContext.Synchronous, assetManager: {} };
  const interactions = await m.computeInteractions(context, structure, props);

  const { rows, truncated } = collectRows(m, structure, interactions, loci);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1;
  return { target, counts, rows, truncated, table: renderTable(target, rows, truncated) };
}
