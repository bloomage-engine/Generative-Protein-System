"use client";

import * as React from "react";
import { ImageOff, Loader2 } from "lucide-react";

/**
 * An image file: the browser decodes it. The `<img>` fetches its own bytes
 * from the workspace inline URL (the same "viewers fetch their own" rule as
 * the PDF and structure viewers — the text hook would only download the same
 * bytes twice and cannot read a byte stream anyway). There is no source view:
 * `isTextEditable` excludes image kinds, so the pane never offers one.
 */
export function ImageRenderer({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = React.useState(false);
  const [done, setDone] = React.useState(false);

  if (failed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <ImageOff className="size-6 opacity-40" />
        <div>Could not decode this image.</div>
        <div className="text-xs opacity-70">Use download to open it locally.</div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-auto p-4">
      {/*
       * The pre-load indicator is an OVERLAY, toggled on top — the `<img>`
       * itself must never assert its own visibility/display state (e.g. no
       * `visibility:visible` on load, no `display` swap): a child asserting
       * visibility OVERRIDES the ancestor's `visibility:hidden` (CSS), which
       * is what hides inactive tabs while keeping them mounted, and a loaded
       * image would resurrect inside the hidden pane and cover the active tab.
       */}
      {!done && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      )}
      <img
        src={url}
        alt={alt}
        draggable={false}
        className="max-h-full max-w-full object-contain"
        onLoad={() => setDone(true)}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
