/**
 * Shared headless molstar loading for the workspace structure routes.
 *
 * Mol* computes structure measures in pure JS (no WebGL), so the service can
 * answer the agent's structure tools without a browser: parse the workspace
 * file, compile MolQL selections, and run molstar's computation modules. Both
 * the interactions and measurements routes sit on this.
 *
 * molstar ships ESM `lib/*.js` without `"type": "module"`, so a Node ESM service
 * cannot `import` it; this module loads its CommonJS build through
 * `createRequire` lazily (molstar is heavy — never pay for it until a tool call
 * asks).
 */
import { createRequire } from "node:module";
import { registerMolstarCombinators } from "./molstar-combinators.js";

const require = createRequire(import.meta.url);

/** Cap on the structure file parsed for one computation. */
export const STRUCTURE_MAX_BYTES = 50 * 1024 * 1024;

/** Thrown when the file name is not a structure format the service can parse. */
export class UnsupportedStructureFormatError extends Error {
  constructor(fileName: string) {
    super(`not a supported structure file: ${fileName}`);
    this.name = "UnsupportedStructureFormatError";
  }
}

/** Thrown when a MolQL expression does not compile against the structure. */
export class MolqlCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MolqlCompileError";
  }
}

export type StructureKind = "pdb" | "mmcif" | "bcif";

/** The molstar parser for a file name, or `null` when it is unsupported. */
export function structureKind(fileName: string): StructureKind | null {
  const lower = fileName.toLowerCase().replace(/\.gz$/, "");
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  if (ext === "pdb" || ext === "ent") return "pdb";
  if (ext === "cif" || ext === "mmcif") return "mmcif";
  if (ext === "bcif") return "bcif";
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Molstar = {
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
  Loci: any;
  StructureElement: any;
  StructureProperties: any;
  StructureSelection: any;
  DefaultQueryRuntimeTable: any;
  QuerySymbolRuntime: any;
  MolScriptSymbolTable: any;
  combinators: any;
  checkStructureMinMaxDistance: any;
  InteractionsProvider: any;
  computeInteractions: any;
  interactionTypeLabel: any;
  InteractionFlag: any;
};

let cachedMolstar: Molstar | undefined;

/** Load molstar's CommonJS build once, on the first computation. */
export function loadMolstar(): Molstar {
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
    StructureSelection: m("mol-model/structure.js").StructureSelection,
    DefaultQueryRuntimeTable: m("mol-script/runtime/query/base.js").DefaultQueryRuntimeTable,
    QuerySymbolRuntime: m("mol-script/runtime/query/base.js").QuerySymbolRuntime,
    MolScriptSymbolTable: m("mol-script/language/symbol-table.js").MolScriptSymbolTable,
    combinators: m("mol-model/structure/query/queries/combinators.js"),
    checkStructureMinMaxDistance: m("mol-model/structure/query/utils/structure-distance.js")
      .checkStructureMinMaxDistance,
    OrderedSet: m("mol-data/int.js").OrderedSet,
    Vec3: m("mol-math/linear-algebra.js").Vec3,
    Script: m("mol-script/script.js").Script,
    RuntimeContext: m("mol-task/index.js").RuntimeContext,
    ParamDefinition: m("mol-util/param-definition.js").ParamDefinition,
    Loci: m("mol-model/loci.js").Loci,
    InteractionsProvider: m("mol-model-props/computed/interactions.js").InteractionsProvider,
    computeInteractions: m("mol-model-props/computed/interactions/interactions.js")
      .computeInteractions,
    interactionTypeLabel: m("mol-model-props/computed/interactions/common.js")
      .interactionTypeLabel,
    InteractionFlag: m("mol-model-props/computed/interactions/common.js").InteractionFlag,
  };
  registerMolstarCombinators(cachedMolstar);
  return cachedMolstar;
}

/** Parse a structure file into a molstar `Structure`. */
export async function parseStructure(
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

/** Compile a MolQL expression against a structure; throws `MolqlCompileError`. */
export function compileLoci(m: Molstar, structure: any, molql: string): any {
  const expression = molql.trim();
  try {
    return m.Script.toLoci({ expression, language: "mol-script" }, structure);
  } catch (err) {
    throw new MolqlCompileError(
      err instanceof Error ? err.message : `invalid MolQL: ${String(err)}`,
    );
  }
}

/** Number of atoms a loci covers (0 means the expression matched nothing). */
export function lociSize(m: Molstar, loci: any): number {
  let count = 0;
  for (const element of loci.elements) count += m.OrderedSet.size(element.indices);
  return count;
}
