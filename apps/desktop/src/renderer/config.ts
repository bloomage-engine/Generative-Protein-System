import type { ScienceStudioDesktopApi } from "../preload/index.mjs";
import type { DesktopConfig } from "../shared/config.js";
import { runtimeStatus } from "../shared/runtime-status.js";

declare global {
  interface Window {
    scienceStudioDesktop?: ScienceStudioDesktopApi;
  }
}

const bridge = window.scienceStudioDesktop;
const app = document.getElementById("app")!;

function code(text: string): HTMLElement {
  const el = document.createElement("code");
  el.textContent = text;
  return el;
}

function field(labelText: string, name: string, value: string, hint = ""): HTMLLabelElement {
  const label = document.createElement("label");
  label.append(labelText);
  const input = document.createElement("input");
  input.name = name;
  input.value = value;
  label.append(input);
  if (hint) {
    const small = document.createElement("small");
    small.textContent = hint;
    label.append(small);
  }
  return label;
}

function textarea(labelText: string, name: string, value: string, placeholder: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.append(labelText);
  const area = document.createElement("textarea");
  area.name = name;
  area.rows = 6;
  area.placeholder = placeholder;
  area.value = value;
  label.append(area);
  return label;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderFatal(message: string): void {
  app.replaceChildren();
  const heading = document.createElement("h1");
  heading.textContent = "Science Studio Settings";
  const line = document.createElement("p");
  line.textContent = `Could not load settings: ${message}`;
  app.append(heading, line);
}

async function render(): Promise<void> {
  if (!bridge) {
    app.textContent = "This window must be opened by the Science Studio desktop app.";
    return;
  }
  app.textContent = "Loading…";
  let config: DesktopConfig;
  let dshPath: string | null;
  try {
    [config, dshPath] = await Promise.all([bridge.getConfig(), bridge.detectDsh()]);
  } catch (error) {
    renderFatal(errorText(error));
    return;
  }
  const status = runtimeStatus({ dshPath, config });
  const vars = Object.entries(config.vars ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  app.replaceChildren();

  const heading = document.createElement("h1");
  heading.textContent = "Science Studio Settings";
  app.append(heading);

  const dshLine = document.createElement("p");
  if (status.dshPath) {
    dshLine.append("dsh: ", code(status.dshPath));
  } else {
    dshLine.append("dsh: missing — install the ", code("dsh"), " CLI before running the agent.");
  }
  app.append(dshLine);

  const runtimeLine = document.createElement("p");
  if (status.ready) {
    runtimeLine.append("runtime: ready · ", code(status.provider ?? ""), " / ", code(status.model ?? ""));
  } else {
    runtimeLine.append("runtime: setup incomplete — set the provider and model below.");
  }
  app.append(runtimeLine);

  const openLine = document.createElement("p");
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.id = "openWorkbench";
  openButton.textContent = "Open workbench anyway";
  openLine.append(openButton);
  app.append(openLine);

  const form = document.createElement("form");
  form.id = "form";
  form.append(
    field("Provider", "provider", config.provider ?? "", "e.g. ollama-local — must exist in ~/.dsh/settings.yaml"),
    field("Model", "model", config.model ?? "", "e.g. qwen3.8:latest"),
    textarea("Credentials / extra env", "vars", vars, "OLLAMA_LOCAL_API_KEY=..."),
  );
  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.textContent = "Save";
  form.append(saveButton);
  app.append(form);

  const statusLine = document.createElement("p");
  statusLine.id = "status";
  app.append(statusLine);

  openButton.addEventListener("click", () => {
    void bridge.openWorkbench();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    statusLine.textContent = "";
    const data = new FormData(form);
    const parsedVars: Record<string, string> = {};
    for (const line of String(data.get("vars") ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      parsedVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    const nextConfig = {
      ...(String(data.get("provider") ?? "").trim() ? { provider: String(data.get("provider")).trim() } : {}),
      ...(String(data.get("model") ?? "").trim() ? { model: String(data.get("model")).trim() } : {}),
      ...(Object.keys(parsedVars).length > 0 ? { vars: parsedVars } : {}),
    };
    try {
      await bridge.setConfig(nextConfig);
      statusLine.textContent = "Saved. Use Restart Service from the menu to apply.";
    } catch (error) {
      statusLine.textContent = `Could not save: ${errorText(error)}`;
    }
  });
}

void render();
