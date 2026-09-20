import type { MolqlSelectionTarget } from "./target.js";

/**
 * The active viewer registry.
 *
 * A page mounts at most one structure viewer at a time (the workbench's center
 * preview pane), so a module-level slot is enough for the free
 * `applyMolqlSelection(molql)` / the tool-result bridge to reach the mounted
 * instance without threading React context through the chat subtree.
 */
let active: MolqlSelectionTarget | null = null;

/** Register (or clear) the viewer that free-standing apply calls target. */
export function setActiveMolqlViewer(viewer: MolqlSelectionTarget | null): void {
  active = viewer;
}

/** The viewer registered by the most recently mounted `MolqlViewerPanel`. */
export function getActiveMolqlViewer(): MolqlSelectionTarget | null {
  return active;
}
