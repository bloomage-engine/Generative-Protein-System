import type { Structure, StructureElement } from "molstar/lib/mol-model/structure";

/**
 * The minimal viewer surface `applyMolqlSelection` needs.
 *
 * `MolqlViewer` implements it, but keeping it structural lets tests (and future
 * embeddings) supply a stub without touching molstar. The molstar imports above
 * are type-only, so this module stays Node-testable.
 */
export interface MolqlSelectionTarget {
  /** The currently loaded structure, or `undefined` when nothing is loaded. */
  readonly structure: Structure | undefined;
  /** True while a structure load is in flight (optional; stubs may omit). */
  readonly loading?: boolean;
  /**
   * Resolve once a structure is loaded and no load is in flight (optional).
   * Lets an apply that arrives mid-load wait instead of querying a
   * transitional structure. Rejects with `MolqlError("NOT_READY")` on timeout.
   */
  whenReady?(timeoutMs?: number): Promise<void>;
  /** Persistent selection (`lociSelects.selectOnly`). */
  select(loci: StructureElement.Loci): void;
  /** Transient emphasis (`lociHighlights.highlightOnly`). */
  highlight(loci: StructureElement.Loci): void;
  /** Move the camera to frame the loci. */
  focus(loci: StructureElement.Loci): void;
}
