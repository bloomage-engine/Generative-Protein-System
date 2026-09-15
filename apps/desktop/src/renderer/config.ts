import type { ScienceStudioDesktopApi } from "../preload/index.mjs";
import { runtimeStatus } from "../shared/runtime-status.js";

declare global {
  interface Window {
    scienceStudioDesktop?: ScienceStudioDesktopApi;
  }
}

const bridge = window.scienceStudioDesktop;
const app = document.getElementById("app")!;

function field(label: string, name: string, value: string, hint = ""): string {
  return `<label>${label}<input name="${name}" value="${value.replace(/"/g, "&quot;")}" />${
    hint ? `<small>${hint}</small>` : ""
  }</label>`;
}

async function render(): Promise<void> {
  if (!bridge) {
    app.textContent = "This window must be opened by the Science Studio desktop app.";
    return;
  }
  const [config, dshPath] = await Promise.all([bridge.getConfig(), bridge.detectDsh()]);
  const status = runtimeStatus({ dshPath, config });
  const vars = Object.entries(config.vars ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  app.innerHTML = `
    <h1>Science Studio Settings</h1>
    <p>${
      status.dshPath
        ? `dsh: <code>${status.dshPath}</code>`
        : "dsh: missing — install the <code>dsh</code> CLI before running the agent."
    }</p>
    <p>${
      status.ready
        ? `runtime: ready · <code>${status.provider}</code> / <code>${status.model}</code>`
        : "runtime: setup incomplete — set the provider and model below."
    }</p>
    <p><button type="button" id="openWorkbench">Open workbench anyway</button></p>
    <form id="form">
      ${field("Provider", "provider", config.provider ?? "", "e.g. ollama-local — must exist in ~/.dsh/settings.yaml")}
      ${field("Model", "model", config.model ?? "", "e.g. qwen3.8:latest")}
      <label>Credentials / extra env<textarea name="vars" rows="6" placeholder="OLLAMA_LOCAL_API_KEY=...">${vars}</textarea></label>
      <button type="submit">Save</button>
    </form>
    <p id="status"></p>
  `;
  document.getElementById("openWorkbench")!.addEventListener("click", () => {
    void bridge.openWorkbench();
  });
  document.getElementById("form")!.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
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
    await bridge.setConfig(nextConfig);
    document.getElementById("status")!.textContent = "Saved. Use Restart Service from the menu to apply.";
  });
}

void render();
