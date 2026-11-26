import { createPluginUI } from "molstar/lib/mol-plugin-ui";
import type { PluginUIContext } from "molstar/lib/mol-plugin-ui/context";
import { DefaultPluginUISpec } from "molstar/lib/mol-plugin-ui/spec";
import { PluginCommands } from "molstar/lib/mol-plugin/commands";
import type { BuiltInTrajectoryFormat } from "molstar/lib/mol-plugin-state/formats/trajectory";
import type { PluginStateObject as SO } from "molstar/lib/mol-plugin-state/objects";
import type { StateObjectRef } from "molstar/lib/mol-state";
import type { Loci as ModelLoci } from "molstar/lib/mol-model/loci.js";
import { Structure, StructureElement } from "molstar/lib/mol-model/structure";
import { Asset } from "molstar/lib/mol-util/assets";
import { Color } from "molstar/lib/mol-util/color";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MolqlError } from "./directive.js";
import type { MeasurementKind } from "./measurement.js";
import { describeMolqlTarget } from "./resolve.js";
import type { MolqlTarget } from "./selection.js";
import type { MolqlSelectionTarget } from "./target.js";

/** Default ceiling for `whenReady` before it gives up as NOT_READY. */
const READY_TIMEOUT_MS = 15000;

/**
 * A standalone Mol* viewer wrapped for the gps preview pane.
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
   * is on (the mode's own click behavior does the visible selecting). `null`
   * means the click hit empty space, which Mol* answers by clearing the whole
   * selection. Assign before or after `init` — the click subscription reads it
   * on every click.
   */
  onResidueClick: ((target: MolqlTarget | null) => void) | undefined;
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

    // The canvas clears to transparent, so the preview pane's own background
    // shows through: the structure view follows light/dark AND every color theme
    // with no per-theme code. `ViewportCanvas` turns Mol*'s checkerboard on while
    // it mounts (`mountAsync(..., { checkeredCanvasBackground: true })`), and
    // this runs after `createPluginUI` resolves — i.e. after that mount — so the
    // checker has to be cleared here too.
    plugin.canvas3d?.setProps({
      transparentBackground: true,
      checkeredTransparentBackground: false,
    });

    this.clickSub = plugin.behaviors.interaction.click.subscribe((event) => {
      this.handleClick(event.current);
    });
  }

  /**
   * Selection-mode click → `onResidueClick`. Gated on `plugin.selectionMode`
   * so a normal click (rotate/focus) never types into the composer; the mode's
   * own behavior is what highlights the clicked element. An empty click reports
   * `null` (Mol* has just cleared the selection).
   *
   * The picking level (`plugin.managers.interactivity.props.granularity`)
   * decides whether an element click becomes an atom (Atom/Coarse Element) or a
   * residue.
   */
  private handleClick(reprLoci: { loci: ModelLoci }): void {
    const plugin = this.plugin;
    if (!plugin?.selectionMode) return;
    const handler = this.onResidueClick;
    if (!handler) return;
    if (reprLoci.loci.kind === "empty-loci") {
      handler(null);
      return;
    }
    const target = describeMolqlTarget(
      reprLoci.loci,
      plugin.managers.interactivity.props.granularity,
    );
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

  /**
   * Draw a Mol* measurement. Delegates to `plugin.managers.structure.
   * measurement`, which builds the selection + representation state transforms
   * and renders the value as a 3D label. `label`/`distance`/`angle`/`dihedral`
   * consume the first 1/2/3/4 loci; `orientation`/`plane` take the whole set.
   */
  async measure(kind: MeasurementKind, locis: StructureElement.Loci[]): Promise<void> {
    const manager = this.plugin?.managers.structure.measurement;
    if (!manager) return;
    switch (kind) {
      case "label":
        if (locis[0]) await manager.addLabel(locis[0]);
        return;
      case "distance":
        if (locis.length >= 2) await manager.addDistance(locis[0]!, locis[1]!);
        return;
      case "angle":
        if (locis.length >= 3) await manager.addAngle(locis[0]!, locis[1]!, locis[2]!);
        return;
      case "dihedral":
        if (locis.length >= 4) {
          await manager.addDihedral(locis[0]!, locis[1]!, locis[2]!, locis[3]!);
        }
        return;
      case "orientation":
        if (locis.length >= 1) await manager.addOrientation(locis);
        return;
      case "plane":
        if (locis.length >= 1) await manager.addPlane(locis);
        return;
    }
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
