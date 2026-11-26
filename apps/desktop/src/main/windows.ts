import { BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function createWorkbenchWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Generative Protein System",
    backgroundColor: "#0b0b0b",
    webPreferences: {
      preload: join(here, "..", "preload", "workbench.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}
