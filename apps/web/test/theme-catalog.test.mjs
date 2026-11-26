/**
 * The color-theme catalog and the generated stylesheet must stay one thing.
 *
 * `lib/theme-catalog.ts` drives the menu (names + swatch colors) while
 * `app/themes.css` carries the token blocks that make a pick real, and both are
 * generated from the same shadcnblocks registry items
 * (`scripts/generate-shadcnblocks-themes.mjs`). A theme that exists in only one
 * of them is a silent bug: a menu row that changes nothing, or a block nobody
 * can reach.
 *
 * Pure Node — no browser, no dev server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { COLOR_THEMES, DEFAULT_COLOR_THEME } from "@/lib/theme-catalog";

const CSS = readFileSync(fileURLToPath(new URL("../app/themes.css", import.meta.url)), "utf8");

/** Every `html[data-theme="<id>"]` (and its `.dark` sibling) the stylesheet declares. */
function blocksInCss() {
  const blocks = new Map();
  const pattern = /^html\[data-theme="([^"]+)"\](\.dark)? \{\n([\s\S]*?)^\}/gm;
  for (const match of CSS.matchAll(pattern)) {
    const [, id, dark, body] = match;
    const entry = blocks.get(id) ?? { light: null, dark: null };
    entry[dark ? "dark" : "light"] = body;
    blocks.set(id, entry);
  }
  return blocks;
}

const tokensOf = (body) =>
  new Set([...body.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));

test("the catalog lists the 37 free shadcnblocks themes, default first", () => {
  assert.equal(DEFAULT_COLOR_THEME, "default");
  assert.equal(COLOR_THEMES.length, 37);
  assert.equal(COLOR_THEMES[0].id, "default");
  assert.equal(new Set(COLOR_THEMES.map((theme) => theme.id)).size, 37, "ids are unique");
  for (const theme of COLOR_THEMES) {
    assert.ok(theme.name.trim().length > 0, `${theme.id} has a display name`);
    for (const mode of ["light", "dark"]) {
      assert.equal(theme.swatches[mode].length, 3, `${theme.id} has three ${mode} swatches`);
      for (const color of theme.swatches[mode]) {
        assert.match(color, /^(oklch|hsl|rgb|#)/, `${theme.id} ${mode} swatch is a real color`);
      }
    }
  }
});

test("every non-default theme has a light and a dark token block", () => {
  const blocks = blocksInCss();
  for (const theme of COLOR_THEMES) {
    if (theme.id === DEFAULT_COLOR_THEME) {
      assert.equal(blocks.has(theme.id), false, "the default theme is the base stylesheet");
      continue;
    }
    const entry = blocks.get(theme.id);
    assert.ok(entry, `${theme.id} is styled`);
    assert.ok(entry.light, `${theme.id} has a light block`);
    assert.ok(entry.dark, `${theme.id} has a dark block`);
    for (const mode of ["light", "dark"]) {
      const tokens = tokensOf(entry[mode]);
      for (const token of ["--background", "--foreground", "--primary", "--accent", "--border"]) {
        assert.ok(tokens.has(token), `${theme.id} ${mode} defines ${token}`);
      }
    }
  }
});

test("a theme follows its fonts and radius, not just its colors", () => {
  const blocks = blocksInCss();
  for (const theme of COLOR_THEMES) {
    if (theme.id === DEFAULT_COLOR_THEME) continue;
    const tokens = tokensOf(blocks.get(theme.id).light);
    assert.ok(tokens.has("--radius"), `${theme.id} carries its own radius`);
    assert.ok(
      ["--font-app-sans", "--font-app-serif", "--font-app-mono"].some((token) => tokens.has(token)),
      `${theme.id} carries a font family`,
    );
  }
});

test("no declaration is a bare variable name", () => {
  // next/font emits a hashed family name, so a theme's self-hosted family is
  // referenced as `var(--font-inter), Inter, …`. A value that IS a variable name
  // (`--font-inter, Inter, …`) silently drops the font.
  for (const [id, entry] of blocksInCss()) {
    for (const body of [entry.light, entry.dark]) {
      for (const match of body.matchAll(/^\s*--[a-z0-9-]+:\s*(.+);$/gm)) {
        assert.doesNotMatch(match[1], /^--/, `${id} has a resolvable value`);
      }
    }
  }
});

test("the stylesheet declares no theme the catalog cannot reach", () => {
  const known = new Set(COLOR_THEMES.map((theme) => theme.id));
  for (const id of blocksInCss().keys()) {
    assert.ok(known.has(id), `html[data-theme="${id}"] is in the catalog`);
  }
});
