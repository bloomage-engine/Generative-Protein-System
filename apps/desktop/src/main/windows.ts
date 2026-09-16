import { BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function createWorkbenchWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Science Studio",
    backgroundColor: "#0b0b0b",
    webPreferences: {
      preload: join(here, "..", "preload", "workbench.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

export function createConfigWindow(appRoot: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 640,
    title: "Science Studio — Settings",
    webPreferences: {
      preload: join(here, "..", "preload", "index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void win.loadFile(join(appRoot, "dist", "renderer", "config.html"));
  return win;
}
