"use client";

/**
 * `@science-studio/molql-viewer` — consume the agent's `molql` tool result and
 * drive a Mol* structure viewer.
 *
 * Layering (deliberate): `formats` and `directive` are molstar-runtime-free and
 * Node-testable; `molql`/`viewer`/`MolqlViewerPanel` import molstar and must go
 * through a bundler (the host app loads them with `ssr: false`).
 */
export { structureFormat, isStructureFile, type StructureFormat } from "./formats.js";
export {
  MolqlError,
  parseMolqlToolResult,
  MOLQL_TOOL_NAME,
  MOLQL_TOOL_RESULT_TYPE,
  type MolqlDirective,
  type MolqlErrorCode,
  type MolqlSelectionMode,
} from "./directive.js";
export {
  compileMolql,
  applyMolqlSelection,
  applyMolqlToolResult,
  type ApplyMolqlOptions,
} from "./molql.js";
export {
  formatResidueMolql,
  formatAtomMolql,
  formatBondMolql,
  formatInteractionMolql,
  formatStructureMention,
  molqlTargetKey,
  type ResidueSelection,
  type AtomSelection,
  type MolqlTarget,
} from "./selection.js";
export {
  isMeasurementKind,
  parseMeasurementToolResult,
  MOLQL_MEASUREMENTS_TOOL_NAME,
  MOLQL_MEASUREMENTS_RESULT_TYPE,
  type MeasurementKind,
  type MolqlMeasurementDirective,
} from "./measurement.js";
export {
  applyMeasurementToolResult,
  type ApplyMeasurementOptions,
} from "./apply-measurements.js";
export { setMolqlViewer, getMolqlViewer, removeMolqlViewer } from "./registry.js";
export type { MolqlSelectionTarget } from "./target.js";
export { MolqlViewer, type MolqlLoadUrl } from "./viewer.js";
export {
  MolqlViewerPanel,
  type MolqlViewerPanelProps,
} from "./react/MolqlViewerPanel.js";
