"use client";

/**
 * The ONE `window.gpsDesktop` declaration. Two components (the status
 * bar's runtime chip and the settings dialog) read it, and two global
 * augmentations of the same `Window` property with different shapes is a TS
 * error — so the shape and the cast live here.
 */
export interface DesktopBridge {
  runtimeStatus?: () => Promise<{ dshPath: string | null; ready: boolean }>;
  restartHost?: () => Promise<{ webPort: number; apiPort: number } | null>;
}

declare global {
  interface Window {
    gpsDesktop?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.gpsDesktop;
}
