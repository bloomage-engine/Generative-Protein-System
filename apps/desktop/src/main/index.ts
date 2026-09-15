import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { resolveDesktopPaths, type DesktopPaths } from "../shared/paths.js";
import { buildChildEnv, parseConfigEnv, serializeConfigEnv, type DesktopConfig } from "../shared/config.js";
import { detectDsh } from "../shared/dsh.js";
import { forkHost, hostEntryPath, type HostPorts } from "./host-child.js";
import { createConfigWindow, createWorkbenchWindow } from "./windows.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..");

let workbench: BrowserWindow | null = null;
let settings: BrowserWindow | null = null;
let host: ChildProcess | null = null;

function paths(): DesktopPaths {
  return resolveDesktopPaths({ userDataDir: app.getPath("userData"), homeDir: homedir() });
}

async function readConfig(): Promise<DesktopConfig> {
  try {
    return parseConfigEnv(await readFile(paths().configPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeConfig(config: DesktopConfig): Promise<void> {
  const p = paths();
  await mkdir(p.userDataDir, { recursive: true });
  await writeFile(p.configPath, serializeConfigEnv(config), "utf8");
}

function nextDir(): string {
  if (process.env.DESKTOP_NEXT_DIR) return process.env.DESKTOP_NEXT_DIR;
  if (app.isPackaged) return join(process.resourcesPath, "next", "apps", "web");
  return join(appRoot, "..", "web", ".next", "standalone", "apps", "web");
}

async function boot(): Promise<HostPorts> {
  const p = paths();
  await mkdir(p.userDataDir, { recursive: true });
  const env = buildChildEnv({ base: process.env, config: await readConfig(), paths: p });
  const { ports, child } = await forkHost({
    hostEntry: hostEntryPath(appRoot),
    nextDir: nextDir(),
    cwd: p.userDataDir,
    env,
    onLine: (line) => process.stderr.write(`[desktop-host] ${line}`),
  });
  host = child;
  child.on("exit", () => {
    host = null;
  });
  return ports;
}

async function openWorkbench(): Promise<void> {
  const ports = await boot();
  workbench = createWorkbenchWindow(`http://127.0.0.1:${ports.webPort}/`);
  workbench.on("closed", () => {
    workbench = null;
  });
}

function openSettings(): void {
  if (settings) {
    settings.focus();
    return;
  }
  settings = createConfigWindow(appRoot);
  settings.on("closed", () => {
    settings = null;
  });
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      {
        label: "Science Studio",
        submenu: [
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openSettings() },
          {
            label: "Open Projects Folder",
            click: () => {
              void shell.openPath(paths().projectRoot);
            },
          },
          {
            label: "Restart Service",
            click: async () => {
              host?.kill("SIGTERM");
              host = null;
              await workbench?.loadURL("about:blank");
              await openWorkbench();
            },
          },
        ],
      },
    ]),
  );
}

function registerIpc(): void {
  ipcMain.handle("desktop:getConfig", () => readConfig());
  ipcMain.handle("desktop:setConfig", async (_event, config: DesktopConfig) => {
    await writeConfig(config);
    return readConfig();
  });
  ipcMain.handle("desktop:detectDsh", () => detectDsh());
  ipcMain.handle("desktop:openPath", async (_event, path: string) => {
    await shell.openPath(path);
  });
  ipcMain.handle("desktop:restartHost", async () => {
    host?.kill("SIGTERM");
    host = null;
    return boot();
  });
}

void app.whenReady().then(async () => {
  registerIpc();
  installMenu();
  const missingConfig = (await readFile(paths().configPath, "utf8").catch(() => "")).length === 0;
  if (missingConfig || !detectDsh()) {
    openSettings();
  } else {
    await openWorkbench();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void openWorkbench();
  });
});

app.on("window-all-closed", () => {
  host?.kill("SIGTERM");
  host = null;
  if (process.platform !== "darwin") app.quit();
});
