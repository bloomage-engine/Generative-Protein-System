import type { Structure, StructureElement } from "molstar/lib/mol-model/structure";
import type { MeasurementKind } from "./measurement.js";

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
  /**
   * Draw a Mol* measurement over the ordered loci (optional: only viewers that
   * expose `plugin.managers.structure.measurement` can). `label`/`distance`/
   * `angle`/`dihedral` use the first 1/2/3/4 loci; `orientation`/`plane` use all.
   */
  measure?(kind: MeasurementKind, locis: StructureElement.Loci[]): void | Promise<void>;
}
