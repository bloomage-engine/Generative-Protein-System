import { contextBridge, ipcRenderer } from "electron";
import type { DesktopConfig } from "../shared/config.js";

const api = {
  getConfig: (): Promise<DesktopConfig> => ipcRenderer.invoke("desktop:getConfig"),
  setConfig: (config: DesktopConfig): Promise<DesktopConfig> => ipcRenderer.invoke("desktop:setConfig", config),
  detectDsh: (): Promise<string | null> => ipcRenderer.invoke("desktop:detectDsh"),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke("desktop:openPath", path),
  restartHost: (): Promise<{ webPort: number; apiPort: number } | null> => ipcRenderer.invoke("desktop:restartHost"),
};

contextBridge.exposeInMainWorld("scienceStudioDesktop", api);

export type ScienceStudioDesktopApi = typeof api;
