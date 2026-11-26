import { Script } from "molstar/lib/mol-script/script.js";
import type { Structure, StructureElement } from "molstar/lib/mol-model/structure";
import {
  MolqlError,
  parseMolqlToolResult,
  type MolqlDirective,
  type MolqlSelectionMode,
} from "./directive.js";
import { registerMissingMolstarCombinators } from "./molstar-combinators.js";
import type { MolqlSelectionTarget } from "./target.js";

registerMissingMolstarCombinators();

/**
 * Compile/apply boundary for Mol*.
 *
 * The "MolQL" the agent emits is Mol*'s `mol-script` S-expression language
 * (`(sel.atom.chains (= atom.chain A))`, `(sel.atom.res (in-range atom.resno 10 20))`,
 * …) — see `docs` in the skill reference. `Script.toLoci` compiles it against a
 * loaded structure into loci the plugin can select/highlight/focus.
 *
 * This module imports molstar at RUNTIME, so it must never be imported from a
 * Node unit test (molstar's `lib/*.js` are ESM with no `"type": "module"`).
 */
export { MolqlError } from "./directive.js";

/** True when a structure is loaded well enough for `Script.toLoci` to run. */
function isReady(structure: Structure | undefined): structure is Structure {
  return !!structure && structure.units.length > 0;
}

/** Compile a MolQL expression against a structure; throws `MolqlError` on bad syntax. */
export function compileMolql(molql: string, structure: Structure): StructureElement.Loci {
  const expression = molql.trim();
  if (!expression) throw new MolqlError("Empty MolQL expression.", "COMPILE");
  if (!isReady(structure)) throw new MolqlError("Structure is still loading.", "NOT_READY");
  try {
    return Script.toLoci({ expression, language: "mol-script" }, structure);
  } catch (err) {
    throw new MolqlError(
      err instanceof Error ? err.message : `Invalid MolQL: ${String(err)}`,
      "COMPILE",
    );
  }
}

export interface ApplyMolqlOptions {
  /** The viewer to apply to (the file the user is viewing). Required: the
   *  registry is path-keyed, so the caller resolves the target explicitly. */
  target?: MolqlSelectionTarget;
  /** `"select"` (persistent, default) or `"highlight"` (transient). */
  mode?: MolqlSelectionMode;
  /** Move the camera to the selection. Defaults to `true`. */
  focus?: boolean;
}

/**
 * molstar-internal failures that mean "the structure was not ready", NOT "the
 * expression is invalid". `Unit.isAtomic(location.unit)` reads `unit.kind`, so
 * querying a transitional structure throws `reading 'kind'`.
 */
function isInternalStructureError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("reading 'kind'") ||
    message.includes("unitMap") ||
    message.includes("Cannot read properties of undefined")
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const raf = (globalThis as { requestAnimationFrame?: (callback: () => void) => unknown })
      .requestAnimationFrame;
    if (typeof raf === "function") raf.call(globalThis, () => resolve());
    else setTimeout(resolve, 16);
  });
}

/** Snapshot for the diagnostics log when a retry also fails. */
function structureStats(target: MolqlSelectionTarget): {
  units: number;
  models: number;
  loading: boolean;
} {
  const structure = target.structure as
    | (Structure & { models?: ReadonlyArray<unknown> })
    | undefined;
  return {
    units: structure?.units.length ?? 0,
    models: structure?.models?.length ?? 0,
    loading: target.loading ?? false,
  };
}

function compileAgainstTarget(
  molql: string,
  target: MolqlSelectionTarget,
): StructureElement.Loci {
  if (!target.structure) throw new MolqlError("No structure is loaded.", "NO_STRUCTURE");
  return compileMolql(molql, target.structure);
}

/**
 * Compile a MolQL string and apply it to a viewer: select/highlight the loci and
 * (by default) focus the camera.
 *
 * Waits for an in-flight load (`target.whenReady`) before querying, and retries
 * once across a frame if Mol* still throws an internal structure error — so an
 * apply that races a file open/switch is applied once the structure settles
 * instead of crashing. Throws `MolqlError` (`NO_VIEWER` / `NO_STRUCTURE` /
 * `NOT_READY` / `COMPILE`) on a real failure.
 */
export async function applyMolqlSelection(
  molql: string,
  options: ApplyMolqlOptions = {},
): Promise<StructureElement.Loci> {
  const target = options.target;
  if (!target) throw new MolqlError("No structure viewer is open.", "NO_VIEWER");

  if (target.whenReady) await target.whenReady();
  if (!target.structure) throw new MolqlError("No structure is loaded.", "NO_STRUCTURE");

  let loci: StructureElement.Loci;
  try {
    loci = compileAgainstTarget(molql, target);
  } catch (err) {
    if (!isInternalStructureError(err)) throw err;

    // The structure was still settling. Let any load finish and retry once.
    await nextFrame();
    if (target.whenReady) await target.whenReady();
    try {
      loci = compileAgainstTarget(molql, target);
    } catch (retryErr) {
      if (isInternalStructureError(retryErr)) {
        console.warn("[molql] structure was not ready to apply a selection", {
          expression: molql,
          ...structureStats(target),
        });
        throw new MolqlError(
          "The structure is still loading; the selection was not applied. Try again.",
          "NOT_READY",
        );
      }
      throw retryErr;
    }
  }

  if ((options.mode ?? "select") === "highlight") target.highlight(loci);
  else target.select(loci);

  if (options.focus ?? true) target.focus(loci);

  return loci;
}

/**
 * Parse a `molql` tool result and apply it. Returns the parsed directive, or
 * `null` when the payload carried no usable expression.
 */
export async function applyMolqlToolResult(
  input: unknown,
  options: ApplyMolqlOptions = {},
): Promise<MolqlDirective | null> {
  const directive = parseMolqlToolResult(input);
  if (!directive) return null;
  await applyMolqlSelection(directive.molql, {
    ...options,
    ...(directive.mode ? { mode: directive.mode } : {}),
    ...(directive.focus !== undefined ? { focus: directive.focus } : {}),
  });
  return directive;
}
