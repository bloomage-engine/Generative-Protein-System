/**
 * The wire contract between the agent's `molql` tool and the viewer.
 *
 * The tool returns JSON (as a string on the wire); this module owns parsing it
 * back into a directive and is deliberately molstar-runtime-free so it can be
 * unit-tested in Node. Anything unrecognized parses to `null` — the caller
 * decides whether that is an error.
 */
export type MolqlSelectionMode = "select" | "highlight";

/** A parsed `molql` tool result, ready to apply to a structure. */
export interface MolqlDirective {
  /** The Mol* mol-script expression, e.g. `(sel.atom.chains (= atom.chain A))`. */
  molql: string;
  /** Human-readable explanation the agent attached, if any. */
  description?: string;
  /** Whether to move the camera to the selection. Defaults to true when unset. */
  focus?: boolean;
  /** Selection semantics. Defaults to "select" when unset. */
  mode?: MolqlSelectionMode;
}

/** The `type` discriminator the tool stamps on its JSON result. */
export const MOLQL_TOOL_RESULT_TYPE = "molql-selection";

/** The tool name both runtime plugins register. */
export const MOLQL_TOOL_NAME = "molql";

/**
 * Why a MolQL application failed.
 *
 * `NO_VIEWER`/`NO_STRUCTURE`/`NOT_READY` are EXPECTED when a selection arrives
 * before the user has a structure open (e.g. a tool call replayed from history);
 * the UI shows a status but does not treat them as errors. `COMPILE` is an
 * actual invalid expression / molstar failure.
 */
export type MolqlErrorCode = "NO_VIEWER" | "NO_STRUCTURE" | "NOT_READY" | "COMPILE";

/**
 * A MolQL compile/apply failure. Defined in this molstar-runtime-free module so
 * the frontend bridge can `instanceof`-check it (and read `code`) without
 * importing molstar into the chat bundle.
 */
export class MolqlError extends Error {
  constructor(
    message: string,
    readonly code: MolqlErrorCode = "COMPILE",
  ) {
    super(message);
    this.name = "MolqlError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Find and parse the first balanced JSON object inside arbitrary text. Used as
 * a fallback when a tool result embeds JSON in prose or a fenced block. Shared
 * with the measurement contract parser.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function normalizeMode(value: unknown): MolqlSelectionMode | undefined {
  if (value === "select" || value === "highlight") return value;
  return undefined;
}

/**
 * Parse a `molql` tool result into a directive.
 *
 * Accepts the raw wire string (JSON, possibly embedded in prose) or an already
 * parsed object. Returns `null` when there is no usable MolQL expression.
 */
export function parseMolqlToolResult(input: unknown): MolqlDirective | null {
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
  const molqlValue = nested.molql ?? value.molql;
  if (typeof molqlValue !== "string" || !molqlValue.trim()) return null;

  const description =
    typeof nested.description === "string" && nested.description.trim()
      ? nested.description
      : undefined;
  const focus = typeof nested.focus === "boolean" ? nested.focus : undefined;
  const mode = normalizeMode(nested.mode);

  return {
    molql: molqlValue,
    ...(description ? { description } : {}),
    ...(focus !== undefined ? { focus } : {}),
    ...(mode ? { mode } : {}),
  };
}
