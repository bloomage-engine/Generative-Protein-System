/**
 * Non-covalent interaction computation for an agent selection.
 *
 * Mol* computes interactions in pure JS (no WebGL), so the service can answer
 * the `computeInteraction` tool without the browser: parse the workspace file,
 * compile the MolQL selection, run molstar's `computeInteractions`, and return
 * the contacts that touch the selection. The headless molstar loading lives in
 * `structure.ts`, shared with the measurements route.
 */
import {
  compileLoci,
  loadMolstar,
  parseStructure,
  structureKind,
  UnsupportedStructureFormatError,
  type Molstar,
} from "./structure.js";

export {
  MolqlCompileError,
  UnsupportedStructureFormatError,
  STRUCTURE_MAX_BYTES as INTERACTIONS_MAX_BYTES,
} from "./structure.js";

/** Upper bound on returned rows; the table notes when it clips. */
const MAX_ROWS = 500;

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
  const loci = compileLoci(m, structure, target);

  const props = m.ParamDefinition.getDefaultValues(m.InteractionsProvider.defaultParams);
  const context = { runtime: m.RuntimeContext.Synchronous, assetManager: {} };
  const interactions = await m.computeInteractions(context, structure, props);

  const { rows, truncated } = collectRows(m, structure, interactions, loci);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1;
  return { target, counts, rows, truncated, table: renderTable(target, rows, truncated) };
}
