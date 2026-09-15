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
let hostPorts: HostPorts | null = null;

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
  if (app.isPackaged) {
    env.NODE_PATH = join(app.getAppPath(), "node_modules");
  }
  const { ports, child } = await forkHost({
    hostEntry: hostEntryPath(appRoot),
    nextDir: nextDir(),
    cwd: p.userDataDir,
    env,
    onLine: (line) => process.stderr.write(`[desktop-host] ${line}`),
  });
  host = child;
  hostPorts = ports;
  child.on("exit", () => {
    if (host === child) {
      host = null;
      hostPorts = null;
    }
  });
  return ports;
}

async function stopHost(): Promise<void> {
  const child = host;
  host = null;
  hostPorts = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let killTimer: NodeJS.Timeout | undefined;
    const onExit = () => {
      if (killTimer) clearTimeout(killTimer);
      resolve();
    };
    child.once("exit", onExit);
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    child.kill("SIGTERM");
  });
}

function devUrl(): string | undefined {
  return process.env.DESKTOP_DEV_URL;
}

function localUrl(ports: HostPorts): string {
  return `http://127.0.0.1:${ports.webPort}/`;
}

function showWorkbench(url: string): void {
  if (workbench && !workbench.isDestroyed()) {
    void workbench.loadURL(url);
    workbench.focus();
    return;
  }
  const win = createWorkbenchWindow(url);
  workbench = win;
  win.on("closed", () => {
    if (workbench === win) workbench = null;
  });
}

async function restart(): Promise<HostPorts | null> {
  const dev = devUrl();
  if (dev) {
    showWorkbench(dev);
    return null;
  }
  await stopHost();
  const ports = await boot();
  showWorkbench(localUrl(ports));
  return ports;
}

async function openWorkbench(): Promise<void> {
  const dev = devUrl();
  if (dev) {
    showWorkbench(dev);
    return;
  }
  const ports = await boot();
  showWorkbench(localUrl(ports));
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
            click: () => {
              void restart();
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
  ipcMain.handle("desktop:restartHost", () => restart());
}

void app
  .whenReady()
  .then(async () => {
    registerIpc();
    installMenu();
    const missingConfig = (await readFile(paths().configPath, "utf8").catch(() => "")).length === 0;
    if (!devUrl() && (missingConfig || !detectDsh())) {
      openSettings();
    } else {
      await openWorkbench();
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      if (host && hostPorts) {
        showWorkbench(localUrl(hostPorts));
        return;
      }
      void openWorkbench();
    });
  })
  .catch((err) => {
    process.stderr.write(`[desktop] startup failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void stopHost().finally(() => app.quit());
});
