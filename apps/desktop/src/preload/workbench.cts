import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeStatus } from "../shared/runtime-status.js";

const api = {
  runtimeStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke("desktop:runtimeStatus"),
};

contextBridge.exposeInMainWorld("scienceStudioDesktop", api);
