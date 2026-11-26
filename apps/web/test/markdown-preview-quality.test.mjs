/**
 * Regression: the Markdown file preview must be typeset and its code blocks
 * syntax-highlighted.
 *
 * `MarkdownRenderer` relies on two easy-to-lose things: the `prose` /
 * `prose-sm` classes only mean anything while the Tailwind typography plugin
 * is actually in the build (Tailwind v4 loads it with an `@plugin` directive
 * in the CSS — installing the package is not enough), and the fenced code
 * blocks get their colors from a shiki highlighter the renderer has to wire
 * into its `<pre>`. When either drops out the preview silently degrades to
 * unstyled HTML with monochrome `pre` blocks — the exact shape this test
 * drives.
 *
 * Prereq: `npm run build -w @gps/transport-client`. Needs a
 * Chromium; SKIPPED when none is found.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findChromium,
  freePort,
  killTree,
  mockRecordSurface,
  mockWorkbenchSurfaces,
  newWorkbenchPage,
  startWebServer,
  waitForServer,
  warmWorkbench,
} from "./harness.mjs";

// A markdown file that exercises the parts users notice: a heading hierarchy,
// a list, a GFM table, inline code and a fenced python block.
const MD_BODY = [
  "# Study notes",
  "",
  "Intro paragraph with **bold** and `inline code`.",
  "",
  "## Methods",
  "",
  "- first step",
  "- second step",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "```python",
  "def f(x):",
  "    return x + 1",
  "```",
].join("\n");

/** Poll `fn` (in-page) until it returns a truthy value or the deadline passes. */
async function eventually(page, fn, timeoutMs = 15_000) {
  const start = Date.now();
  let value;
  for (;;) {
    value = await page.evaluate(fn);
    if (value) return value;
    if (Date.now() - start > timeoutMs) return value;
    await page.waitForTimeout(250);
  }
}

test(
  "a markdown file is typeset and its code blocks are highlighted",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip(
        "no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one (e.g. `npx playwright install chromium`)",
      );
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
      // Registered after the harness mocks (most recent route wins): the tree
      // lists notes.md and the file fetch serves the markdown body.
      await page.route("**/api/workspace/entries*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: "",
            entries: [{ path: "notes.md", name: "notes.md", kind: "file", size: MD_BODY.length }],
          }),
        }),
      );
      await page.route("**/api/workspace/file*", (route) =>
        route.fulfill({ status: 200, headers: { "content-type": "text/markdown" }, body: MD_BODY }),
      );

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      const tree = page.getByRole("tree");
      await tree.waitFor({ timeout: 30_000 });
      await tree.getByRole("treeitem", { name: "notes.md" }).click();
      await page.getByText("Study notes", { exact: true }).waitFor({ timeout: 15_000 });

      // The GFM parts must be real HTML (this already works today — it guards
      // the renderer's parse pipeline that the two fixed behaviors depend on).
      assert.ok(
        (await page.evaluate(() => document.querySelectorAll(".prose table").length)) > 0,
        "the GFM table must render as a <table>",
      );

      // 1) Typesetting: the typography plugin's rules must be in the stylesheets.
      //    With the plugin missing, NO rule anywhere mentions .prose.
      //    Tailwind v4 emits the rules nested inside @layer blocks (the .prose
      //    rule nests its element selectors), so walk the rule tree — a flat
      //    selectorText scan reports the plugin as absent even when it is in
      //    the build.
      const proseRules = await page.evaluate(() => {
        let n = 0;
        const walk = (rules) => {
          for (const rule of rules ?? []) {
            if (rule.selectorText && /\bprose\b/.test(rule.selectorText)) n += 1;
            if (rule.cssRules) walk(rule.cssRules);
          }
        };
        for (const sheet of document.styleSheets) {
          let rules;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          walk(rules);
        }
        return n;
      });
      assert.ok(
        proseRules > 0,
        "no .prose rules in any stylesheet — the typography plugin is not in the build, " +
          "so the preview is unstyled HTML",
      );

      // 2) Code highlighting: shiki emits token <span>s carrying inline colors.
      //    The highlighter loads async, so poll for it.
      const highlightedSpans = await eventually(page, () => {
        let max = 0;
        for (const pre of document.querySelectorAll(".prose pre")) {
          max = Math.max(max, pre.querySelectorAll("span[style*='color']").length);
        }
        return max;
      });
      assert.ok(
        highlightedSpans > 0,
        "the fenced python block has no highlighted token spans — code blocks are monochrome",
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
