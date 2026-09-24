import { MolqlError } from "./directive.js";
import {
  parseMeasurementToolResult,
  type MolqlMeasurementDirective,
} from "./measurement.js";
import { compileMolql } from "./molql.js";
import { getActiveMolqlViewer } from "./registry.js";
import type { MolqlSelectionTarget } from "./target.js";

export interface ApplyMeasurementOptions {
  /** Defaults to the active viewer registered by `MolqlViewerPanel`. */
  target?: MolqlSelectionTarget;
}

/**
 * Parse a `measurements` tool result and draw it on the viewer.
 *
 * The service computed the numbers; here each ordered MolQL expression is
 * compiled against the viewer's loaded structure and handed to
 * `target.measure`. Returns the parsed directive, or `null` when the payload
 * carried no usable measurement.
 */
export async function applyMeasurementToolResult(
  input: unknown,
  options: ApplyMeasurementOptions = {},
): Promise<MolqlMeasurementDirective | null> {
  const directive = parseMeasurementToolResult(input);
  if (!directive) return null;

  const target = options.target ?? getActiveMolqlViewer();
  if (!target) throw new MolqlError("No structure viewer is open.", "NO_VIEWER");

  if (target.whenReady) await target.whenReady();
  if (!target.structure) throw new MolqlError("No structure is loaded.", "NO_STRUCTURE");
  if (!target.measure) {
    throw new MolqlError("The viewer does not support measurements.", "COMPILE");
  }

  const locis = directive.selections.map((molql) => compileMolql(molql, target.structure!));
  await target.measure(directive.kind, locis);
  return directive;
}
