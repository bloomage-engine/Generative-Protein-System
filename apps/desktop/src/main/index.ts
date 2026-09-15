import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { resolveDesktopPaths, type DesktopPaths } from "../shared/paths.js";
import { buildChildEnv, parseConfigEnv, serializeConfigEnv, type DesktopConfig } from "../shared/config.js";
import { detectDsh } from "../shared/dsh.js";
import { augmentPath } from "../shared/env-path.js";
import { forkHost, type HostPorts } from "./host-child.js";
import { resolveResourcePaths } from "./resource-paths.js";
import { createConfigWindow, createWorkbenchWindow } from "./windows.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..");

let workbench: BrowserWindow | null = null;
let settings: BrowserWindow | null = null;
let host: ChildProcess | null = null;
let hostPorts: HostPorts | null = null;
let quitting = false;
let restartInFlight: Promise<HostPorts | null> | null = null;

function paths(): DesktopPaths {
  return resolveDesktopPaths({ userDataDir: app.getPath("userData"), homeDir: homedir() });
}

function pathEnv(): string {
  return augmentPath(process.env.PATH, homedir());
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

async function boot(): Promise<HostPorts> {
  const p = paths();
  await mkdir(p.userDataDir, { recursive: true });
  const env = buildChildEnv({ base: process.env, config: await readConfig(), paths: p });
  env.PATH = pathEnv();
  if (app.isPackaged) {
    env.NODE_PATH = join(app.getAppPath(), "node_modules");
  }
  const resources = resolveResourcePaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot });
  const { ports, child } = await forkHost({
    hostEntry: resources.hostEntry,
    nextDir: process.env.DESKTOP_NEXT_DIR ?? resources.nextDir,
    cwd: p.userDataDir,
    env,
    onLine: (line) => process.stderr.write(`[desktop-host] ${line}`),
  });
  host = child;
  hostPorts = ports;
  child.on("exit", (code) => {
    if (host === child) {
      host = null;
      hostPorts = null;
    }
    if (!quitting && restartInFlight === null) {
      console.error("[desktop] host exited unexpectedly", code);
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

function connectionHelpPage(url: string, reason: string): string {
  const html =
    `<!doctype html><meta charset="utf-8"><title>Science Studio</title>` +
    `<body style="font-family: system-ui, sans-serif; background: #0b0b0b; color: #e5e5e5; padding: 2rem; line-height: 1.6">` +
    `<h1>Cannot reach ${url}</h1><p>${reason}</p>` +
    `<p>Start the local dev servers (<code>npm run dev</code>) and this window reconnects automatically, or press Ctrl/Cmd+R to retry.</p>` +
    `</body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function loadWorkbench(win: BrowserWindow, url: string, attempts: number, delayMs: number): void {
  const attempt = (remaining: number): void => {
    if (win.isDestroyed()) return;
    const onFail = (
      _event: unknown,
      code: number,
      description: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      win.webContents.off("did-fail-load", onFail);
      if (!isMainFrame || win.isDestroyed()) return;
      console.error(`[desktop] failed to load ${url}: ${description} (${code})`);
      if (remaining > 1) setTimeout(() => attempt(remaining - 1), delayMs);
      else void win.loadURL(connectionHelpPage(url, `${description} (${code})`));
    };
    win.webContents.once("did-fail-load", onFail);
    win.webContents.once("did-finish-load", () => win.webContents.off("did-fail-load", onFail));
    void win.loadURL(url).catch(() => {});
  };
  attempt(attempts);
}

function showWorkbench(url: string, opts: { retry?: boolean } = {}): void {
  let win = workbench && !workbench.isDestroyed() ? workbench : null;
  if (win) {
    win.focus();
  } else {
    win = createWorkbenchWindow();
    const created = win;
    workbench = created;
    created.on("closed", () => {
      if (workbench === created) workbench = null;
    });
  }
  if (opts.retry) loadWorkbench(win, url, 30, 1_000);
  else void win.loadURL(url).catch((err) => console.error(`[desktop] failed to load ${url}`, err));
}

async function doRestart(): Promise<HostPorts | null> {
  const dev = devUrl();
  if (dev) {
    showWorkbench(dev, { retry: true });
    return null;
  }
  await stopHost();
  const ports = await boot();
  showWorkbench(localUrl(ports));
  return ports;
}

function restart(): Promise<HostPorts | null> {
  if (restartInFlight) return restartInFlight;
  const inFlight = doRestart()
    .catch((err) => {
      console.error("[desktop] restart failed", err);
      return null;
    })
    .finally(() => {
      restartInFlight = null;
    });
  restartInFlight = inFlight;
  return inFlight;
}

async function openWorkbench(): Promise<void> {
  const dev = devUrl();
  if (dev) {
    showWorkbench(dev, { retry: true });
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
  ipcMain.handle("desktop:detectDsh", () => detectDsh({ pathEnv: pathEnv() }));
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
    if (!devUrl() && (missingConfig || !detectDsh({ pathEnv: pathEnv() }))) {
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

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void stopHost().finally(() => app.quit());
});
