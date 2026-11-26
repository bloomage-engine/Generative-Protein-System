/**
 * Regression: the structure preview's canvas paints the APP's background, not
 * Mol*'s own opaque clear color.
 *
 * The Mol* layout hides every control panel (`showControls: false`), so the whole
 * visible surface is the WebGL canvas. It is TRANSPARENT and the renderer's
 * wrapper paints `bg-background`, so a light/dark switch and every color theme
 * (docs/adr/0027) reach the structure view with no per-theme code.
 *
 * Asserting on the DOM alone would pass even with an opaque canvas, so this test
 * screenshots the canvas and reads an EMPTY corner pixel: it must equal the
 * theme's resolved `--background` — default light, dark, and a color theme whose
 * light background is not white. A canvas that keeps Mol*'s own color fails the
 * very first one.
 *
 * Prereq: `npm run build -w @science-studio/transport-client`. Needs a Chromium
 * with WebGL; SKIPPED when either is missing.
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

/** Five atoms of crambin — enough for Mol* to build a representation. */
const TINY_PDB = [
  "ATOM      1  N   THR A   1      17.047  14.099   3.625  1.00 13.79           N",
  "ATOM      2  CA  THR A   1      16.967  12.784   4.338  1.00 10.80           C",
  "ATOM      3  C   THR A   1      15.685  12.755   5.133  1.00  9.19           C",
  "ATOM      4  O   THR A   1      15.268  13.825   5.594  1.00  9.71           O",
  "ATOM      5  CB  THR A   1      18.170  12.703   5.287  1.00 13.02           C",
  "END",
].join("\n");

/**
 * The theme's resolved `--background`, as sRGB bytes.
 *
 * A computed `background-color` keeps the token's own color space (Chrome
 * answers `oklch(1 0 0)`), while the screenshot is sRGB — so the token is parsed
 * by a 1×1 canvas and read back as pixels. A token the canvas cannot parse
 * throws instead of silently comparing against the sentinel.
 */
function resolvedBackground(page) {
  return page.evaluate(() => {
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ff00ff";
    ctx.fillStyle = token;
    if (ctx.fillStyle === "#ff00ff") throw new Error(`--background is not a CSS color: ${token}`);
    ctx.fillRect(0, 0, 1, 1);
    return { token, rgb: Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)) };
  });
}

/**
 * The top-left pixel of the canvas. Mol* centers the structure and draws its
 * logo bottom-right, so this corner is empty background in every mode.
 *
 * Playwright screenshots the COMPOSITED page, which is the point: a transparent
 * canvas shows the pane behind it, an opaque one shows Mol*'s own color.
 */
async function cornerPixel(page, canvas) {
  const png = await canvas.screenshot({ timeout: 30_000 });
  return await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const buffer = document.createElement("canvas");
    buffer.width = image.naturalWidth;
    buffer.height = image.naturalHeight;
    const ctx = buffer.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return Array.from(ctx.getImageData(3, 3, 1, 1).data);
  }, png.toString("base64"));
}

async function assertCornerIsThemeBackground(page, canvas, label) {
  const expected = await resolvedBackground(page);
  const actual = await cornerPixel(page, canvas);
  for (let index = 0; index < 3; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected.rgb[index]) <= 2,
      `${label}: canvas corner is rgb(${actual.slice(0, 3).join(", ")}) but --background is ${expected.token} (rgb(${expected.rgb.join(", ")}))`,
    );
  }
  assert.equal(actual[3], 255, `${label}: the composited page is opaque`);
}

test(
  "the structure canvas follows the appearance and the color theme",
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
      // Registered after the harness mocks (most recent route wins): a structure
      // file in the tree, and its bytes on the viewer's own download URL.
      await page.route("**/api/workspace/entries*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: "",
            entries: [
              { path: "notes.txt", name: "notes.txt", kind: "file", size: 3 },
              { path: "1crn.pdb", name: "1crn.pdb", kind: "file", size: 500 },
            ],
          }),
        }),
      );
      await page.route("**/api/workspace/file*", (route) => {
        const path = new URL(route.request().url()).searchParams.get("path") ?? "";
        return route.fulfill({
          status: 200,
          headers: { "content-type": "chemical/x-pdb" },
          body: path.endsWith(".pdb") ? TINY_PDB : "hi",
        });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      const tree = page.getByRole("tree");
      await tree.waitFor({ timeout: 30_000 });
      await tree.getByRole("treeitem", { name: "1crn.pdb" }).click();
      await page.getByText("/1crn.pdb", { exact: true }).waitFor({ timeout: 15_000 });

      await page.locator(".msp-plugin").waitFor({ timeout: 60_000 });
      const canvas = page.locator(".msp-plugin canvas");
      if ((await canvas.count()) === 0) {
        t.skip("this Chromium has no WebGL — the Mol* canvas never mounted");
        return;
      }

      // The logo is rendered until a representation exists, so waiting for it to
      // disappear is what proves a frame has actually been drawn (an untouched
      // canvas is transparent and would pass this test by accident).
      await page.locator(".msp-logo").waitFor({ state: "detached", timeout: 60_000 });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );

      // Default appearance/theme: the app's own light background.
      await assertCornerIsThemeBackground(page, canvas, "default light");

      // Dark: the same canvas, now over the dark background.
      await page.getByRole("button", { name: "Theme" }).click();
      await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
      await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
      await assertCornerIsThemeBackground(page, canvas, "default dark");

      // A color theme whose LIGHT background is a warm grey (not white), with
      // its own radius/fonts — the canvas must follow the token, not a
      // light/dark pair hardcoded in the viewer.
      await page.getByRole("button", { name: "Theme" }).click();
      await page.getByRole("menuitemradio", { name: "Astrovista" }).click();
      await page.getByRole("button", { name: "Theme" }).click();
      await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.documentElement.dataset.theme === "astrovista" &&
          !document.documentElement.classList.contains("dark"),
      );
      const astrovista = await resolvedBackground(page);
      assert.notDeepEqual(
        astrovista.rgb,
        [255, 255, 255],
        "Astrovista's light background is a token of its own, not the base white",
      );
      await assertCornerIsThemeBackground(page, canvas, "astrovista light");
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);
