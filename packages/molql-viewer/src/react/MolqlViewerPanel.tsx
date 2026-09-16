"use client";

import { useEffect, useRef } from "react";
import { structureFormat } from "../formats.js";
import { setActiveMolqlViewer } from "../registry.js";
import { MolqlViewer } from "../viewer.js";

export interface MolqlViewerPanelProps {
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
  fileContent,
  fileUrl,
  fileName,
  assemblyId,
  className,
  onReady,
  onError,
}: MolqlViewerPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<MolqlViewer | null>(null);
  const initRef = useRef<Promise<MolqlViewer> | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const viewer = new MolqlViewer();
    viewerRef.current = viewer;
    const ready = viewer.init(container).then(() => viewer);
    initRef.current = ready;
    ready
      .then(() => {
        if (viewerRef.current !== viewer) return;
        setActiveMolqlViewer(viewer);
        onReady?.(viewer);
      })
      .catch((err: unknown) => onErrorRef.current?.(toError(err)));

    return () => {
      if (viewerRef.current === viewer) {
        viewerRef.current = null;
        initRef.current = null;
        setActiveMolqlViewer(null);
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
