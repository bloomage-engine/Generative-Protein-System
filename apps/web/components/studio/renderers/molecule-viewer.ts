"use client";

import "molstar/lib/mol-plugin-ui/skin/light.scss";

import { PluginCommands } from "molstar/lib/mol-plugin/commands";
import type { BuiltInTrajectoryFormat } from "molstar/lib/mol-plugin-state/formats/trajectory";
import type { PluginStateObject as SO } from "molstar/lib/mol-plugin-state/objects";
import { createPluginUI } from "molstar/lib/mol-plugin-ui";
import type { PluginUIContext } from "molstar/lib/mol-plugin-ui/context";
import { DefaultPluginUISpec } from "molstar/lib/mol-plugin-ui/spec";
import type { StateObjectRef } from "molstar/lib/mol-state";
import { Asset } from "molstar/lib/mol-util/assets";
import { Color } from "molstar/lib/mol-util/color";
import { createRoot } from "react-dom/client";

/**
 * Mol* owns a WebGL canvas, so this module is browser-only — its consumer
 * (`MoleculeRenderer`) is a `next/dynamic(... ssr:false)` import.
 */

/** Map a file name to the trajectory format Mol* should parse it as. */
export function getFileFormat(fileName: string): "pdb" | "mmcif" | "mol" {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".bcif.gz") || lower.endsWith(".cif.gz")) return "mmcif";
  if (lower.endsWith(".pdb.gz")) return "pdb";

  const ext = lower.split(".").pop() ?? "";
  switch (ext) {
    case "bcif":
    case "cif":
    case "mmcif":
      return "mmcif";
    case "mol":
    case "mol2":
      return "mol";
    default:
      return "pdb";
  }
}

/** Binary structure formats are fetched as bytes rather than text. */
export function isBinaryMoleculeFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith(".bcif") ||
    lower.endsWith(".bcif.gz") ||
    lower.endsWith(".mol") ||
    lower.endsWith(".mol2")
  );
}

export interface LoadUrlParams {
  url: string;
  format?: BuiltInTrajectoryFormat;
  isBinary?: boolean;
  assemblyId?: string;
}

/**
 * A thin imperative wrapper around a Mol* plugin instance: init into a
 * container, load one structure, and dispose. The chrome (tabs, header) is the
 * host's; this class only owns the canvas.
 */
export class MolstarViewer {
  plugin?: PluginUIContext;
  private mount?: HTMLElement;
  private isInitialized = false;
  private unmount?: () => void;
  /**
   * `init` is async (it awaits the WebGL canvas), while React may unmount the
   * component during that await — dev StrictMode double-invokes effects, and a
   * tab close does too. Without this flag the dispose runs before the plugin
   * exists, the orphaned init finishes anyway, and its canvas is left stacked
   * in the container: the visible one is empty and the loaded structure sits
   * off-screen (the "plugin loads but the structure is blank" symptom).
   */
  private disposed = false;

  async init(target: HTMLElement): Promise<void> {
    if (this.isInitialized || this.disposed) return;

    // Mount into our OWN child of the caller's container. Replacing the
    // container (as some Mol* examples do) detaches the node React owns and
    // makes React's later `removeChild` throw when the tab closes.
    const mount = document.createElement("div");
    mount.style.position = "relative";
    mount.style.height = "100%";
    target.appendChild(mount);
    // Recorded BEFORE the await, so a dispose racing the init can still tear
    // this mount out of the DOM.
    this.mount = mount;

    let rootInstance: ReturnType<typeof createRoot> | undefined;
    let mounted = false;
    const renderWithUnmount = (element: React.ReactElement): { mounted: boolean } => {
      if (mounted) return { mounted: true };
      if (this.disposed || !mount.isConnected) return { mounted: false };
      rootInstance = createRoot(mount);
      rootInstance.render(element);
      mounted = true;
      return { mounted: true };
    };

    const plugin = await createPluginUI({
      target: mount,
      render: renderWithUnmount,
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

    // Disposed while the plugin was being built: destroy it immediately so it
    // never becomes a stale canvas. `dispose` may not have seen it.
    if (this.disposed) {
      rootInstance?.unmount();
      mount.remove();
      await plugin.dispose();
      return;
    }

    this.plugin = plugin;

    // Illustrative style: soft occlusion + outline, matching the reference.
    const pp = plugin.canvas3d?.props.postprocessing;
    if (pp !== undefined) {
      await plugin.managers.structure.component.setOptions({
        ...plugin.managers.structure.component.state.options,
        ignoreLight: true,
      });
      plugin.canvas3d?.setProps({
        postprocessing: {
          outline: {
            name: "on",
            params:
              pp.outline.name === "on"
                ? pp.outline.params
                : { scale: 1, color: Color(0x000000), threshold: 0.33, includeTransparent: true },
          },
          occlusion: {
            name: "on",
            params:
              pp.occlusion.name === "on"
                ? pp.occlusion.params
                : {
                    multiScale: { name: "off", params: {} },
                    radius: 5,
                    bias: 0.8,
                    blurKernelSize: 15,
                    blurDepthBias: 0.5,
                    samples: 32,
                    resolutionScale: 1,
                    color: Color(0x000000),
                    transparentThreshold: 0.4,
                  },
          },
          shadow: { name: "off", params: {} },
        },
      });
    }

    this.unmount = () => {
      rootInstance?.unmount();
      rootInstance = undefined;
      mounted = false;
    };
    this.isInitialized = true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const plugin = this.plugin;
    const unmountFn = this.unmount;
    const mount = this.mount;
    this.unmount = undefined;
    this.mount = undefined;
    this.plugin = undefined;
    this.isInitialized = false;
    unmountFn?.();
    mount?.remove();
    if (plugin) await plugin.dispose();
  }

  private async load(
    data: StateObjectRef<SO.Data.Binary | SO.Data.String>,
    format: BuiltInTrajectoryFormat,
  ): Promise<void> {
    if (!this.plugin) return;
    const trajectory = await this.plugin.builders.structure.parseTrajectory(data, format);
    await this.plugin.builders.structure.hierarchy.applyPreset(trajectory, "default", {
      structure: { name: "model", params: {} },
      showUnitcell: false,
      representationPreset: "auto",
    });
  }

  async loadString(content: string, format: BuiltInTrajectoryFormat = "mmcif"): Promise<void> {
    if (!this.plugin) return;
    await this.plugin.clear();
    const data = await this.plugin.builders.data.rawData({ data: content });
    await this.load(data, format);
  }

  async loadUrl({ url, format = "mmcif", isBinary = false }: LoadUrlParams): Promise<void> {
    if (!this.plugin) return;
    await this.plugin.clear();
    const data = await this.plugin.builders.data.download(
      { url: Asset.Url(url), isBinary },
      { state: { isGhost: true } },
    );
    await this.load(data, format);
  }

  reset(): void {
    if (!this.plugin) return;
    PluginCommands.Camera.Reset(this.plugin, {});
  }
}
