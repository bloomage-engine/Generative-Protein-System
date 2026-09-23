"use client";

import { useEffect, useRef } from "react";
import { structureFormat } from "../formats.js";
import { removeMolqlViewer, setMolqlViewer } from "../registry.js";
import type { MolqlTarget } from "../selection.js";
import { MolqlViewer } from "../viewer.js";

export interface MolqlViewerPanelProps {
  /** The workspace-relative path of the structure file this viewer shows. It
   *  keys the viewer registry, so an app can target the file the user is
   *  viewing instead of whichever viewer mounted last. */
  path: string;
  /** Inline file content (text formats). Takes precedence over `fileUrl`. */
  fileContent?: string;
  /** URL to load from (any format). */
  fileUrl?: string;
  /** File name, used to infer the molstar format + binary flag. */
  fileName?: string;
  /** Optional mmCIF biological assembly id. */
  assemblyId?: string;
  className?: string;
  /** Called once the plugin is initialized and registered as the active viewer. */
  onReady?: (viewer: MolqlViewer) => void;
  /**
   * Called when the user clicks a residue/bond while Mol*'s selection mode is
   * on (`null` for an empty click, which clears Mol*'s selection). The viewer
   * reports the domain target; the host decides what to do.
   */
  onResidueClick?: (target: MolqlTarget | null) => void;
  /** Called when initialization or loading fails. */
  onError?: (error: Error) => void;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function loadInto(
  viewer: MolqlViewer,
  props: Pick<MolqlViewerPanelProps, "fileContent" | "fileUrl" | "fileName" | "assemblyId">,
): Promise<void> {
  const info = props.fileName ? structureFormat(props.fileName) : null;

  if (props.fileContent !== undefined) {
    await viewer.loadString(props.fileContent, info?.format ?? "mmcif", props.assemblyId ?? "");
    return;
  }
  if (props.fileUrl) {
    await viewer.loadUrl({
      url: props.fileUrl,
      format: info?.format ?? "mmcif",
      isBinary: info?.isBinary ?? false,
      assemblyId: props.assemblyId ?? "",
    });
  }
}

/**
 * Mounts a `MolqlViewer` into a div and registers it as the active viewer.
 *
 * Molstar is browser-only (WebGL + ESM without a `"type": "module"`), so the
 * host app must import this module dynamically with `ssr: false`.
 */
export function MolqlViewerPanel({
  path,
  fileContent,
  fileUrl,
  fileName,
  assemblyId,
  className,
  onReady,
  onResidueClick,
  onError,
}: MolqlViewerPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<MolqlViewer | null>(null);
  const initRef = useRef<Promise<MolqlViewer> | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onResidueClickRef = useRef(onResidueClick);
  onResidueClickRef.current = onResidueClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const viewer = new MolqlViewer();
    viewer.onResidueClick = (target) => onResidueClickRef.current?.(target);
    viewerRef.current = viewer;
    const ready = viewer.init(container).then(() => viewer);
    initRef.current = ready;
    ready
      .then(() => {
        if (viewerRef.current !== viewer) return;
        setMolqlViewer(path, viewer);
        onReady?.(viewer);
      })
      .catch((err: unknown) => onErrorRef.current?.(toError(err)));

    return () => {
      if (viewerRef.current === viewer) {
        viewerRef.current = null;
        initRef.current = null;
        removeMolqlViewer(path, viewer);
      }
      void viewer.dispose();
    };
    // Mount once; file changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ready = initRef.current;
    if (!ready) return;
    let cancelled = false;
    ready
      .then((viewer) => {
        if (cancelled) return;
        return loadInto(viewer, { fileContent, fileUrl, fileName, assemblyId });
      })
      .catch((err: unknown) => {
        if (!cancelled) onErrorRef.current?.(toError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [fileContent, fileUrl, fileName, assemblyId]);

  return <div ref={containerRef} className={className} />;
}
