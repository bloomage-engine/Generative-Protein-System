import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeStatus } from "../shared/runtime-status.js";

const api = {
  runtimeStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke("desktop:runtimeStatus"),
  restartHost: (): Promise<{ webPort: number; apiPort: number } | null> =>
    ipcRenderer.invoke("desktop:restartHost"),
};

contextBridge.exposeInMainWorld("gpsDesktop", api);
