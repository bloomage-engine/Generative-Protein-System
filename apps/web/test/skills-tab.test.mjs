/**
 * The Settings → Skills tab (docs/adr/0020): it lists the global + project
 * skills the service reports, installs a project skill, removes one (with
 * confirmation), and copies a global skill into the project — all over
 * `/api/skills*`, never the settings file. Opening the dialog must not remount
 * the runtime owner, which the transcript marker check covers.
 *
 * Prereq: `npm run build -w @science-studio/transport-client`. Needs a Chromium
 * (SKIPs without one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MARKER,
  findChromium,
  freePort,
  killTree,
  newWorkbenchPage,
  mockRecordSurface,
  mockWorkbenchSurfaces,
  startWebServer,
  waitForServer,
  warmWorkbench,
} from "./harness.mjs";

const SETTINGS_VIEW = {
  model: { apiKeyConfigured: false },
  plugins: {},
  agent: {},
  subagents: {},
  runtime: "dsh",
  settingsPath: "/tmp/settings.json",
};

function skill(name, scope, description) {
  return {
    name,
    description,
    scope,
    source: scope === "project" ? "project-dsh" : "user-dsh",
    path: scope === "project" ? `.dsh/skills/${name}/SKILL.md` : `/home/.dsh/skills/${name}/SKILL.md`,
    invocation: { modelInvocable: true, userInvocable: true },
  };
}

test(
  "the Skills tab lists, installs, copies and removes skills",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip("no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one");
      return;
    }

    const port = await freePort();
    const server = startWebServer(port);
    let browser;
    try {
      await waitForServer(`http://localhost:${port}`, 120_000);
      await warmWorkbench(`http://localhost:${port}`);

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath });
      const page = await newWorkbenchPage(browser);

      await mockWorkbenchSurfaces(page);
      await mockRecordSurface(page);
      await page.route("**/api/settings", (route) => route.fulfill({ json: SETTINGS_VIEW }));

      let skills = [skill("alpha", "project", "A project skill"), skill("gamma", "global", "A global skill")];
      let available = true;
      let failRequests = false;
      const writes = [];
      await page.route(
        (url) => url.pathname === "/api/skills" || url.pathname.startsWith("/api/skills/"),
        async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (failRequests) {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "boom" }),
          });
        }
        if (request.method() === "GET") {
          return route.fulfill({ json: { available, runtime: "dsh", skills } });
        }
        const body = request.postDataJSON();
        writes.push({ path: url.pathname, body });
        if (url.pathname.endsWith("/install")) {
          const name = body.name ?? body.copyFrom?.name;
          skills = skills.filter((s) => s.name !== name).concat(skill(name, "project", body.description ?? "copied"));
        } else if (url.pathname.endsWith("/remove")) {
          skills = skills.filter((s) => s.name !== body.name);
        }
        return route.fulfill({ json: { skill: skills.find((s) => s.scope === "project") } });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("dialog").waitFor({ timeout: 10_000 });
      await page.getByRole("tab", { name: "Skills" }).click();

      await page.getByText("A project skill").waitFor({ timeout: 10_000 });
      await page.getByText("A global skill").waitFor({ timeout: 10_000 });

      const postResponse = (suffix) =>
        page.waitForResponse(
          (res) => res.url().includes(`/api/skills/${suffix}`) && res.request().method() === "POST",
        );

      // Install a project skill.
      await page.getByRole("button", { name: "Install skill" }).click();
      await page.getByLabel("Name (kebab-case)").fill("beta");
      await page.getByLabel("Description").fill("A new skill");
      await page.getByLabel("Instructions").fill("Do the thing.");
      const installed = postResponse("install");
      await page.getByRole("button", { name: "Create skill" }).click();
      await installed;
      const install = writes.find((w) => w.path.endsWith("/install"));
      assert.ok(install, "install was POSTed");
      assert.equal(install.body.name, "beta");
      assert.equal(install.body.description, "A new skill");

      // Copy a global skill into the project.
      const copied = postResponse("install");
      await page.getByRole("button", { name: "Copy gamma to project" }).click();
      await copied;
      const copy = writes.find((w) => w.path.endsWith("/install") && w.body.copyFrom);
      assert.ok(copy, "copy was POSTed as an install");

      // Remove a project skill (two-step confirmation).
      await page.getByRole("button", { name: "Remove alpha" }).click();
      const removed = postResponse("remove");
      await page.getByRole("button", { name: "Confirm remove alpha" }).click();
      await removed;
      const remove = writes.find((w) => w.path.endsWith("/remove"));
      assert.ok(remove, "remove was POSTed");
      assert.equal(remove.body.name, "alpha");
      assert.equal(remove.body.confirm, true);

      // A long catalog scrolls INSIDE the dialog instead of overflowing the viewport.
      skills = Array.from({ length: 40 }, (_, i) => skill(`s${i}`, "project", `Skill ${i}`));
      await page.getByRole("tab", { name: "Model" }).click();
      await page.getByRole("tab", { name: "Skills" }).click();
      await page.getByText("Skill 39").waitFor({ state: "attached", timeout: 10_000 });
      const layout = await page.evaluate(() => {
        const dialog = document.querySelector('[data-slot="dialog-content"]');
        const contents = [...document.querySelectorAll('[data-slot="tabs-content"]')];
        const content = contents.find((el) => el.getBoundingClientRect().height > 0) ?? contents[0];
        if (!dialog || !content) return null;
        const before = content.scrollTop;
        content.scrollTop = 100_000;
        return {
          dialogFits: dialog.getBoundingClientRect().height <= window.innerHeight,
          overflowY: getComputedStyle(content).overflowY,
          scrolled: content.scrollTop > before,
        };
      });
      assert.ok(layout, "the dialog and its active tab content exist");
      assert.equal(layout.dialogFits, true, "the dialog fits the viewport");
      assert.equal(layout.overflowY, "auto", "the tab content is a scroll container");
      assert.equal(layout.scrolled, true, "the tab content scrolls");

      // A transport failure is an error state with a Retry — NOT the
      // "runtime lacks the surface" copy (docs/adr/0021).
      failRequests = true;
      await page.getByRole("tab", { name: "Model" }).click();
      await page.getByRole("tab", { name: "Skills" }).click();
      await page.getByText("boom").waitFor({ timeout: 10_000 });
      failRequests = false;
      await page.getByRole("button", { name: "Retry" }).click();
      await page.getByText("Skill 0", { exact: true }).waitFor({ timeout: 10_000 });

      // A runtime without the surface shows the neutral unavailable copy.
      available = false;
      await page.getByRole("tab", { name: "Model" }).click();
      await page.getByRole("tab", { name: "Skills" }).click();
      await page.getByText(/Skills are available on the dsh runtime/).waitFor({ timeout: 10_000 });

      await page.getByRole("button", { name: "Close" }).click();
      assert.equal(await page.getByText(HISTORY_MARKER).count(), 1, "the transcript survived the dialog");
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);
