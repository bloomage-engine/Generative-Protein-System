import type { MolqlSelectionTarget } from "./target.js";

/**
 * The viewer registry, keyed by the workspace path of the structure file each
 * viewer shows.
 *
 * The preview pane keeps EVERY open tab mounted (hidden tabs stay alive so their
 * scroll/selection state survives a switch), so a pathless single slot would let
 * whichever viewer initialized last win — and the agent's selection would land
 * on a hidden tab. Keying by path lets the app target the file the user is
 * actually viewing: `getMolqlViewer(activeStructurePath)`.
 */
const viewers = new Map<string, MolqlSelectionTarget>();

/** Register the viewer that shows the structure file at `path`. */
export function setMolqlViewer(path: string, viewer: MolqlSelectionTarget): void {
  viewers.set(path, viewer);
}

/** The viewer for `path`, or `null` when that file has no open viewer. */
export function getMolqlViewer(path: string): MolqlSelectionTarget | null {
  return viewers.get(path) ?? null;
}

/** Remove `viewer` only if it is still the one registered for `path`. */
export function removeMolqlViewer(path: string, viewer: MolqlSelectionTarget): void {
  if (viewers.get(path) === viewer) viewers.delete(path);
}
