/**
 * The wire contract between the agent's `measurements` tool and the viewer.
 *
 * The tool returns JSON (as a string on the wire) carrying both the computed
 * measurement (for the model) and the ordered selections that produced it (for
 * the viewer to redraw). This module owns parsing that directive back out and is
 * deliberately molstar-runtime-free so it can be unit-tested in Node.
 *
 * The model translates natural language into MolQL; the tool forwards the
 * ordered expressions and the service computes the numbers. Anything
 * unrecognized parses to `null` — the caller decides whether that is an error.
 */
import { extractJsonObject } from "./directive.js";

/**
 * The measurement kinds Mol*'s `StructureMeasurementManager` supports, with the
 * number of selection items each needs.
 *
 * `label` — 1 item; `distance` — 2; `angle` — 3; `dihedral` — 4;
 * `orientation`/`plane` — one or more (a set of loci).
 */
export type MeasurementKind =
  | "label"
  | "distance"
  | "angle"
  | "dihedral"
  | "orientation"
  | "plane";

/** The tool name both runtime plugins register. */
export const MOLQL_MEASUREMENTS_TOOL_NAME = "measurements";

/** The `type` discriminator the tool stamps on its JSON result. */
export const MOLQL_MEASUREMENTS_RESULT_TYPE = "molql-measurements";

/** A parsed `measurements` tool result, ready to apply to a structure. */
export interface MolqlMeasurementDirective {
  /** Which measurement to draw. */
  kind: MeasurementKind;
  /** The ordered MolQL expressions: A, B, C, D (order matters). */
  selections: string[];
  /** Human-readable explanation the agent attached, if any. */
  description?: string;
}

const KINDS: ReadonlySet<string> = new Set<MeasurementKind>([
  "label",
  "distance",
  "angle",
  "dihedral",
  "orientation",
  "plane",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is a kind the viewer can draw. */
export function isMeasurementKind(value: unknown): value is MeasurementKind {
  return typeof value === "string" && KINDS.has(value);
}

/**
 * Parse a `measurements` tool result into a directive.
 *
 * Accepts the raw wire string (JSON, possibly embedded in prose) or an already
 * parsed object. Returns `null` when there is no usable kind + selection list.
 */
export function parseMeasurementToolResult(input: unknown): MolqlMeasurementDirective | null {
  let value: unknown = input;

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      value = extractJsonObject(trimmed);
    }
  }

  if (!isObject(value)) return null;

  // Tolerate a `{ result: { ... } }` / `{ details: { ... } }` wrapper.
  const nested = isObject(value.result) ? value.result : value;
  const kind = nested.kind ?? value.kind;
  if (!isMeasurementKind(kind)) return null;

  const rawSelections = nested.selections ?? value.selections;
  if (!Array.isArray(rawSelections)) return null;
  const selections = rawSelections
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
  if (selections.length === 0) return null;

  const description =
    typeof nested.description === "string" && nested.description.trim()
      ? nested.description
      : undefined;

  return {
    kind,
    selections,
    ...(description ? { description } : {}),
  };
}
