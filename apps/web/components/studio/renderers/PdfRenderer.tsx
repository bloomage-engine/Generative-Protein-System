"use client";

import { PDFViewer, ZoomMode } from "@embedpdf/react-pdf-viewer";

/**
 * Renders a PDF with the EmbedPDF viewer.
 *
 * Browser-only (Canvas + WebAssembly), so this module is loaded through
 * `next/dynamic(... ssr:false)` by `FilePreviewPane`. External webfonts are
 * disabled — this app is self-hosted/desktop, so the viewer must not reach
 * Google Fonts or the jsDelivr font-fallback CDN at view time.
 */
export function PdfRenderer({ url }: { url: string }) {
  return (
    <div className="h-full w-full">
      <PDFViewer
        config={{
          src: url,
          zoom: { defaultZoomLevel: ZoomMode.FitWidth, minZoom: 0.5, maxZoom: 6 },
          fonts: { ui: null, signature: null },
          fontFallback: { fonts: {} },
        }}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
