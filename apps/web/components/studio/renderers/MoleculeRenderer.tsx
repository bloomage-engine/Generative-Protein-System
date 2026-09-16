"use client";

import { useEffect, useRef, useState, type FC } from "react";
import { Loader2 } from "lucide-react";
import { getFileFormat, isBinaryMoleculeFile, MolstarViewer } from "./molecule-viewer";

/**
 * Renders a molecular structure (pdb/cif/mmcif/mol/bcif) with Mol*.
 *
 * Browser-only: Mol* builds a WebGL canvas, so this is loaded through
 * `next/dynamic(... ssr:false)`. The structure is fetched by Mol* itself from
 * the workspace inline URL — the surrounding preview never downloads the bytes.
 */
export const MoleculeRenderer: FC<{ url: string; fileName: string }> = ({ url, fileName }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    const viewer = new MolstarViewer();

    viewer
      .init(container)
      .then(() => {
        if (cancelled) return;
        setReady(true);
        return viewer.loadUrl({
          url,
          format: getFileFormat(fileName),
          isBinary: isBinaryMoleculeFile(fileName),
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      void viewer.dispose();
    };
  }, [url, fileName]);

  return (
    <div className="relative h-full w-full">
      {!ready && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      )}
      {error && (
        <div className="text-destructive absolute inset-x-0 bottom-3 px-4 text-center text-xs">
          {error}
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
};
