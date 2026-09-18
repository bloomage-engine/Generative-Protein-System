import { createPluginUI } from "molstar/lib/mol-plugin-ui";
import type { PluginUIContext } from "molstar/lib/mol-plugin-ui/context";
import { DefaultPluginUISpec } from "molstar/lib/mol-plugin-ui/spec";
import { PluginCommands } from "molstar/lib/mol-plugin/commands";
import type { BuiltInTrajectoryFormat } from "molstar/lib/mol-plugin-state/formats/trajectory";
import type { PluginStateObject as SO } from "molstar/lib/mol-plugin-state/objects";
import type { StateObjectRef } from "molstar/lib/mol-state";
import type { Loci as ModelLoci } from "molstar/lib/mol-model/loci.js";
import {
  Bond,
  Structure,
  StructureElement,
  StructureProperties,
  type Unit,
} from "molstar/lib/mol-model/structure";
import { Asset } from "molstar/lib/mol-util/assets";
import { Color } from "molstar/lib/mol-util/color";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MolqlError } from "./directive.js";
import type { AtomSelection, MolqlTarget, ResidueSelection } from "./selection.js";
import type { MolqlSelectionTarget } from "./target.js";

/** Default ceiling for `whenReady` before it gives up as NOT_READY. */
const READY_TIMEOUT_MS = 15000;

/** Read the residue identity off a location, or `undefined` for coarse models. */
function readResidue(loc: StructureElement.Location): ResidueSelection | undefined {
  try {
    const chain = StructureProperties.chain.auth_asym_id(loc);
    const resno = StructureProperties.residue.auth_seq_id(loc);
    const resname = StructureProperties.residue.auth_comp_id(loc);
    if (!chain || !resname || typeof resno !== "number") return undefined;
    return { chain, resno, resname };
  } catch {
    return undefined;
  }
}

/** Read one atom (residue identity plus its name) off a unit element. */
function readAtom(
  structure: Structure,
  unit: Unit,
  unitIndex: StructureElement.UnitIndex,
): AtomSelection | undefined {
  const loc = StructureElement.Location.create(structure, unit, unit.elements[unitIndex]);
  const residue = readResidue(loc);
  if (!residue) return undefined;
  try {
    const atomName = StructureProperties.atom.auth_atom_id(loc);
    if (!atomName) return undefined;
    return { ...residue, atomName };
  } catch {
    return undefined;
  }
}

/** Resolve a click's loci into a residue or a bond (its two endpoint atoms). */
function describeMolqlTarget(loci: ModelLoci): MolqlTarget | undefined {
  if (StructureElement.Loci.is(loci)) {
    const loc = StructureElement.Loci.getFirstLocation(loci);
    const residue = loc ? readResidue(loc) : undefined;
    return residue ? { kind: "residue", residue } : undefined;
  }
  if (Bond.isLoci(loci)) {
    const bond = loci.bonds[0];
    if (!bond) return undefined;
    const a = readAtom(loci.structure, bond.aUnit, bond.aIndex);
    const b = readAtom(loci.structure, bond.bUnit, bond.bIndex);
    return a && b ? { kind: "bond", a, b } : undefined;
  }
  return undefined;
}

/**
 * A standalone Mol* viewer wrapped for the science-studio preview pane.
 *
 * Owns the plugin lifecycle (init/load/dispose) and implements
 * `MolqlSelectionTarget` so `applyMolqlSelection` can drive it. React is
 * mounted through `createPluginUI`'s `render` callback into a dedicated host
 * div, so it never fights the host app's React tree.
 */
export interface MolqlLoadUrl {
  url: string;
  format?: BuiltInTrajectoryFormat;
  isBinary?: boolean;
  assemblyId?: string;
}

export class MolqlViewer implements MolqlSelectionTarget {
  plugin: PluginUIContext | undefined;
  /**
   * Called when the user clicks a residue or bond WHILE Mol*'s selection mode
   * is on (the mode's own click behavior does the visible selecting). Assign
   * before or after `init` — the click subscription reads it on every click.
   */
  onResidueClick: ((target: MolqlTarget) => void) | undefined;
  private initialized = false;
  private disposed = false;
  private host: HTMLElement | undefined;
  private root: Root | undefined;
  private clickSub: { unsubscribe(): void } | undefined;

  /** True from the start of a load until its preset has been applied. */
  private loadInFlight = false;
  /** Pending `whenReady` resolvers, flushed when a load settles (or on dispose). */
  private readyWaiters: Array<() => void> = [];

  async init(target: HTMLElement): Promise<void> {
    if (this.initialized || this.disposed) return;

    const host = document.createElement("div");
    host.style.position = "relative";
    host.style.height = "100%";
    host.style.width = "100%";
    target.appendChild(host);
    this.host = host;

    const self = this;
    const render = (element: ReactElement, container: Element): { mounted: boolean } => {
      // `init` is async, so a StrictMode effect can dispose this viewer before
      // `createPluginUI` resolves. Never create a React root for a dead viewer.
      if (self.disposed) return { mounted: false };
      if (self.root) return { mounted: true };
      self.root = createRoot(container as HTMLElement);
      self.root.render(element);
      return { mounted: true };
    };

    const plugin = await createPluginUI({
      target: host,
      render,
      spec: {
        ...DefaultPluginUISpec(),
        layout: {
          initial: {
            isExpanded: false,
            showControls: false,
            controlsDisplay: "reactive",
            regionState: {
              left: "hidden",
              bottom: "hidden",
              right: "full",
              top: "full",
            },
          },
        },
        components: {
          remoteState: "none",
        },
      },
    });

    if (this.disposed) {
      try {
        plugin.dispose();
      } finally {
        host.remove();
      }
      return;
    }

    this.plugin = plugin;
    this.initialized = true;
    this.clickSub = plugin.behaviors.interaction.click.subscribe((event) => {
      this.handleClick(event.current);
    });
  }

  /**
   * Selection-mode click → `onResidueClick`. Gated on `plugin.selectionMode`
   * so a normal click (rotate/focus) never types into the composer; the mode's
   * own behavior is what highlights the clicked element.
   */
  private handleClick(reprLoci: { loci: ModelLoci }): void {
    if (!this.plugin?.selectionMode) return;
    const handler = this.onResidueClick;
    if (!handler) return;
    const target = describeMolqlTarget(reprLoci.loci);
    if (target) handler(target);
  }

  get structure(): Structure | undefined {
    return this.plugin?.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data;
  }

  /** True while a load is in flight (`whenReady` callers should wait). */
  get loading(): boolean {
    return this.loadInFlight;
  }

  /**
   * Resolve once a structure is loaded and no load is in flight.
   *
   * An apply that arrives while the viewer is still parsing/`applyPreset`-ing
   * would otherwise query a transitional structure and crash inside Mol*
   * (`reading 'kind'`). Rejects `MolqlError("NOT_READY")` on timeout.
   */
  whenReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        reject(new MolqlError("Timed out waiting for the structure to load.", "NOT_READY"));
      }, timeoutMs);
      this.readyWaiters.push(waiter);
    });
  }

  private isReady(): boolean {
    return !this.loadInFlight && !!this.structure && this.structure.units.length > 0;
  }

  private flushReadyWaiters(): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter();
  }

  // -- MolqlSelectionTarget ---------------------------------------------------

  select(loci: StructureElement.Loci): void {
    this.plugin?.managers.interactivity.lociSelects.selectOnly({ loci });
  }

  highlight(loci: StructureElement.Loci): void {
    this.plugin?.managers.interactivity.lociHighlights.highlightOnly({ loci });
  }

  focus(loci: StructureElement.Loci): void {
    this.plugin?.managers.camera.focusLoci(loci, { durationMs: 300 });
  }

  // -- Loading ----------------------------------------------------------------

  async loadString(
    data: string,
    format: BuiltInTrajectoryFormat = "mmcif",
    assemblyId = "",
  ): Promise<void> {
    if (!this.plugin) return;
    this.loadInFlight = true;
    try {
      await this.plugin.clear();
      const raw = await this.plugin.builders.data.rawData({ data });
      await this.applyTrajectory(raw, format, assemblyId);
    } finally {
      this.loadInFlight = false;
      this.flushReadyWaiters();
    }
  }

  async loadUrl({
    url,
    format = "mmcif",
    isBinary = false,
    assemblyId = "",
  }: MolqlLoadUrl): Promise<void> {
    if (!this.plugin) return;
    this.loadInFlight = true;
    try {
      await this.plugin.clear();
      const data = await this.plugin.builders.data.download(
        { url: Asset.Url(url), isBinary },
        { state: { isGhost: true } },
      );
      await this.applyTrajectory(data, format, assemblyId);
    } finally {
      this.loadInFlight = false;
      this.flushReadyWaiters();
    }
  }

  private async applyTrajectory(
    data: StateObjectRef<SO.Data.String | SO.Data.Binary>,
    format: BuiltInTrajectoryFormat,
    assemblyId: string,
  ): Promise<void> {
    const plugin = this.plugin;
    if (!plugin) return;
    const trajectory = await plugin.builders.structure.parseTrajectory(data, format);
    await plugin.builders.structure.hierarchy.applyPreset(trajectory, "default", {
      structure: assemblyId
        ? { name: "assembly", params: { id: assemblyId } }
        : { name: "model", params: {} },
      showUnitcell: false,
      representationPreset: "auto",
    });
  }

  // -- Misc -------------------------------------------------------------------

  reset(): void {
    if (this.plugin) PluginCommands.Camera.Reset(this.plugin, {});
  }

  setBackground(color: number): void {
    if (!this.plugin) return;
    PluginCommands.Canvas3D.SetSettings(this.plugin, {
      settings: (props) => {
        props.renderer.backgroundColor = Color(color);
      },
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.loadInFlight = false;
    this.flushReadyWaiters();
    this.clickSub?.unsubscribe();
    this.clickSub = undefined;
    const plugin = this.plugin;
    const root = this.root;
    const host = this.host;
    this.plugin = undefined;
    this.root = undefined;
    this.host = undefined;
    this.initialized = false;

    // Unmount on a macrotask, never synchronously: React 19 refuses to unmount
    // one root while another is rendering/committing, which is exactly what an
    // effect cleanup (or StrictMode's double-invoke) would do here.
    setTimeout(() => {
      try {
        root?.unmount();
      } catch {
        // The root may already be gone; nothing left to clean up.
      } finally {
        host?.remove();
        plugin?.dispose();
      }
    }, 0);
  }
}
