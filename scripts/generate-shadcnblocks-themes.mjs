#!/usr/bin/env node
/**
 * Regenerate the workbench's shadcnblocks color themes.
 *
 *   node scripts/generate-shadcnblocks-themes.mjs
 *
 * Writes two files from the same registry items, so they cannot drift:
 *
 *   apps/web/app/themes.css        the token blocks (`html[data-theme="<id>"]`)
 *   apps/web/lib/theme-catalog.ts  the menu's catalog (names + swatch colors)
 *
 * Source: https://www.shadcnblocks.com/r/theme/<slug>.json — the free shadcn
 * theme registry items (official shadcn CSS variables, light + dark). `alpine`
 * and `stripe` are listed on the site but their registry items are Pro (401
 * "Authentication required"), so they are not here.
 *
 * What a theme carries: every color token, its font families (mapped onto the
 * app's `--font-app-*` variables, which the self-hosted next/font faces fill in)
 * and its radius. Shadow tokens are dropped on purpose — the app has no
 * `--shadow-*` scale, and inventing one would restyle every surface.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY = "https://www.shadcnblocks.com/r/theme";

/** Menu order: the site's own order, with the base look first. */
const THEMES = [
  "default",
  "shadcnblocks",
  "vercel",
  "supabase",
  "linear",
  "claude",
  "claymorphism",
  "amber-minimal",
  "cleanslate",
  "citrus",
  "falcon",
  "modern-minimal",
  "light-green",
  "zen-inspired",
  "astrovista",
  "qrafthive",
  "whatsapp",
  "sage-green",
  "vtron",
  "autoblog",
  "enterprise-mod-2",
  "porfolio",
  "deep-purple",
  "bold-wikipedia",
  "vescrow",
  "japan-blues",
  "chalk",
  "vermillion",
  "meridian",
  "celestial",
  "openprofile",
  "stillwater",
  "polaris",
  "sandstone",
  "exploremiam",
  "vs-code",
  "stella",
];

/**
 * `default` is the app's own base stylesheet (`:root` / `.dark` in globals.css),
 * so it gets no block: selecting it is selecting the shadcn default tokens.
 */
const BASE_THEME = "default";

/** The color tokens a block carries, in a stable order. */
const COLOR_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
];

/** Registry font variable → the app variable the block overrides. */
const FONT_VARS = {
  "font-sans": "--font-app-sans",
  "font-serif": "--font-app-serif",
  "font-mono": "--font-app-mono",
  "font-display": "--font-app-display",
};

/**
 * Families the app self-hosts through next/font (`app/layout.tsx`). next/font
 * emits a hashed family name, so a theme that asks for "Inter" has to reference
 * the variable — the literal name is kept after it as a fallback.
 */
const SELF_HOSTED = {
  Inter: "var(--font-inter)",
  "Plus Jakarta Sans": "var(--font-plus-jakarta-sans)",
  Geist: "var(--font-geist)",
  Outfit: "var(--font-outfit)",
  "DM Sans": "var(--font-dm-sans)",
  Lora: "var(--font-lora)",
  "JetBrains Mono": "var(--font-jetbrains-mono)",
  "IBM Plex Mono": "var(--font-ibm-plex-mono)",
};

const firstFamily = (value) =>
  value.split(",")[0].trim().replace(/^["']/, "").replace(/["']$/, "");

function fontStack(value) {
  const variable = SELF_HOSTED[firstFamily(value)];
  return variable ? `${variable}, ${value}` : value;
}

const declarations = (entries) =>
  entries.map(([name, value]) => `  ${name}: ${value};`).join("\n");

const colorEntries = (tokens) =>
  COLOR_TOKENS.filter((token) => tokens[token]).map((token) => [`--${token}`, tokens[token]]);

function lightEntries(tokens) {
  const entries = colorEntries(tokens);
  for (const [source, target] of Object.entries(FONT_VARS)) {
    if (tokens[source]) entries.push([target, fontStack(tokens[source])]);
  }
  if (tokens.radius) entries.push(["--radius", tokens.radius]);
  return entries;
}

async function fetchTheme(slug) {
  const response = await fetch(`${REGISTRY}/${slug}.json`);
  if (!response.ok) {
    throw new Error(`${slug}: ${response.status} ${await response.text()}`);
  }
  const item = await response.json();
  const light = item.cssVars?.light;
  const dark = item.cssVars?.dark;
  if (!light || !dark) throw new Error(`${slug}: no light/dark tokens`);
  return { slug, name: item.title ?? slug, light, dark };
}

const swatches = (tokens) => [tokens.background, tokens.primary, tokens.accent];
const quote = (value) => JSON.stringify(value);

function renderCss(themes) {
  const blocks = themes
    .filter((theme) => theme.slug !== BASE_THEME)
    .map((theme) =>
      [
        `html[data-theme="${theme.slug}"] {`,
        declarations(lightEntries(theme.light)),
        `}`,
        `html[data-theme="${theme.slug}"].dark {`,
        declarations(colorEntries(theme.dark)),
        `}`,
      ].join("\n"),
    )
    .join("\n\n");

  return `/*
 * shadcnblocks color themes — GENERATED, do not edit by hand.
 * Regenerate: node scripts/generate-shadcnblocks-themes.mjs
 * Source: ${REGISTRY}/<slug>.json (free registry items)
 *
 * Every block is scoped to \`html[data-theme="<id>"]\` so it outranks \`:root\`
 * (the base tokens, i.e. the \`${BASE_THEME}\` theme) AND the next/font class that
 * writes the font variables on <html>. The dark sibling adds \`.dark\` — the class
 * next-themes puts on <html> — and outranks the light block, so the two
 * selectors never have to rely on source order.
 *
 * A theme carries its colors, its fonts (as the app's \`--font-app-*\` variables,
 * which the self-hosted faces in app/layout.tsx fill in) and its radius. Shadow
 * tokens are deliberately absent: the app has no \`--shadow-*\` scale.
 */

${blocks}
`;
}

function renderCatalog(themes) {
  const ids = themes.map((theme) => theme.slug);
  const entries = themes
    .map((theme) =>
      [
        `  {`,
        `    id: ${quote(theme.slug)},`,
        `    name: ${quote(theme.name)},`,
        `    swatches: {`,
        `      light: [${swatches(theme.light).map(quote).join(", ")}],`,
        `      dark: [${swatches(theme.dark).map(quote).join(", ")}],`,
        `    },`,
        `  },`,
      ].join("\n"),
    )
    .join("\n");

  return `/**
 * The color themes the workbench theme menu offers — GENERATED, do not edit by
 * hand. Regenerate: node scripts/generate-shadcnblocks-themes.mjs
 *
 * \`id\` is the \`data-theme\` value and the key in app/themes.css; \`name\` is the
 * registry item's title; \`swatches\` are that theme's own tokens
 * (background / primary / accent) so a menu row previews what it applies.
 */
export type ColorThemeId =
${ids.map((id) => `  | ${quote(id)}`).join("\n")};

export type ColorTheme = {
  id: ColorThemeId;
  name: string;
  swatches: { light: [string, string, string]; dark: [string, string, string] };
};

/** The base stylesheet: \`:root\` / \`.dark\` in app/globals.css. */
export const DEFAULT_COLOR_THEME: ColorThemeId = ${quote(BASE_THEME)};

export const COLOR_THEMES: readonly ColorTheme[] = [
${entries}
];
`;
}

const themes = [];
for (const slug of THEMES) themes.push(await fetchTheme(slug));

for (const [path, contents] of [
  [join(ROOT, "apps/web/app/themes.css"), renderCss(themes)],
  [join(ROOT, "apps/web/lib/theme-catalog.ts"), renderCatalog(themes)],
]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  console.log(`wrote ${path}`);
}
