# Color themes are generated from the shadcnblocks registry

The workbench's only appearance control was a one-click light/dark toggle
(`components/studio/theme-toggle.tsx`): `next-themes` stamps `.dark` on `<html>`,
and the palette is whatever `app/globals.css` declares. Researchers read and
write in this surface for hours, so the palette is a preference, not a fixed
brand decision — and the shadcn ecosystem already publishes ready palettes: 39
themes on shadcnblocks, each a `registry:theme` item carrying the official
shadcn CSS variables in a `light` and a `dark` set
(`https://www.shadcnblocks.com/r/theme/<slug>.json`). The catch is that the
registry is built for a ONE-theme install: `npx shadcn add @shadcnblocks/theme/x`
REPLACES the tokens in `globals.css`. A picker needs all of them to coexist and
be switchable at runtime.

- **Status**: accepted
- **Context**: *Considered and rejected*: installing a theme with the shadcn CLI
  and committing it — that is a one-time rebrand, not a user choice, and it
  discards every other theme. *Considered and rejected*: fetching a theme's CSS
  at runtime and injecting a `<style>` — the app must work offline (the packaged
  Electron app has no network), a late stylesheet flashes the previous palette,
  and it makes the palette a network dependency of the UI. *Considered and
  rejected*: a service-owned setting (docs/adr/0015) — light/dark is already
  browser-local in `next-themes`, a color theme is the same kind of per-user
  chrome preference, and the service does not render. *Considered and rejected*:
  loading the theme fonts from a font CDN — same offline argument; see the font
  decision below. *Considered and rejected*: a second `next-themes` provider for
  the color theme — `useTheme()` resolves to the NEAREST provider, so a second
  instance would shadow the light/dark hook for the whole workbench (and
  `CodeRenderer`/`MarkdownRenderer` read `resolvedTheme` from it).
- **Decisions**:
  - **One generated stylesheet, scoped by `data-theme` on `<html>`.**
    `app/themes.css` carries, per theme, `html[data-theme="<id>"] { … }` (colors,
    fonts, radius) and `html[data-theme="<id>"].dark { … }` (colors only — the
    registry's dark sets are colors). The element selector is load-bearing: it
    outranks both `:root` (the base tokens) and the `next/font` class that writes
    the font variables onto `<html>`, and `html[data-theme].dark` outranks the
    light block — so the two selectors never depend on source order.
  - **`default` is the base stylesheet and gets no block.** It is the app's
    existing shadcn default look, so selecting it is selecting `:root`/`.dark`.
  - **37 themes, and the Pro ones are absent on purpose.** `alpine` and `stripe`
    are listed on the site but their registry items answer 401
    ("Authentication required to access this pro theme registry item"), so they
    are not in the catalog — the generator fails loudly rather than shipping a
    menu row that styles nothing.
  - **A theme carries colors, fonts and radius — not shadows.** The registry also
    ships a `--shadow-*` scale; the app has none, and introducing one would
    restyle every surface (cards, popovers, menus) as a side effect of a palette
    pick. Fonts and radius are what the user asked for and what makes a theme
    recognizable.
  - **Two generated files, one source, pinned by a test.** The generator
    (`scripts/generate-shadcnblocks-themes.mjs`) writes BOTH `app/themes.css` and
    `lib/theme-catalog.ts` (the menu's names + per-mode swatch colors), and
    `test/theme-catalog.test.mjs` asserts they agree in both directions: every
    catalog id has a light and a dark block, and no block exists that the menu
    cannot reach. A row that changes nothing (or a block nobody can pick) is a
    silent bug; the generated-output model makes it a test failure instead.
  - **The color theme is its own tiny provider, applied before paint.**
    `lib/color-theme.tsx` writes `data-theme`, persists under its own
    `ss-color-theme` storage key, and renders a dependency-free inline script
    from `app/layout.tsx` so a saved pick never flashes the default palette.
    Light/dark stays `next-themes` with `attribute="class"` — `.dark` is what
    shiki, Mol\*, every `dark:` variant and `enableSystem` already read, and
    nothing about the color theme may disturb it.
  - **The fonts are self-hosted through `next/font`, not a font CDN.** A theme's
    stack is rewritten onto an app-level variable layer: `--font-app-sans`,
    `-serif`, `-mono`, `-display` (defaults in `globals.css`; a theme block
    overrides them), which `@theme inline` maps to Tailwind's `font-sans`/
    `font-serif`/`font-mono`/`font-heading`. `next/font` emits a HASHED family
    name, so a self-hosted family is referenced as
    `var(--font-inter), "Inter", ui-sans-serif, …` — the literal name stays as
    the fallback. Eight families are self-hosted: Geist (the default) plus the
    seven most-used across the 37 themes (Inter, Plus Jakarta Sans, Outfit,
    DM Sans, Lora, JetBrains Mono, IBM Plex Mono), all `preload: false` so only
    the active theme's faces are fetched.
- **Consequences**: adding or refreshing a theme is a NETWORK step
  (`node scripts/generate-shadcnblocks-themes.mjs`), run by a developer and
  committed — the build itself never reaches the registry. `next/font`
  downloads its faces at build time (cached under `.next/cache`), so the first
  build after adding a family needs network once. A theme whose first family is
  not in the eight renders its declared fallback stack: the palette, radius and
  layout are right, the typeface is the platform's — acceptable for the long tail
  (Playfair Display, Merriweather, Onest, Montserrat, …), and the fix is to add
  the family to `app/layout.tsx` and to the generator's map. A theme that ships a
  `--shadow-*` scale looks flatter here than on its own demo page (the decision
  above). The pick is per browser, like light/dark; two open tabs do not sync —
  the same property `next-themes` already has. The swatch colors are duplicated
  into the catalog, which is safe precisely because both files are generated from
  one run. The menu itself is `components/studio/theme-menu.tsx` (one dropdown:
  appearance radio group + a scrollable color-theme radio group with each
  theme's own swatches); `test/theme-menu.test.mjs` drives it in a real browser
  and asserts a pick resolves to the theme's own radius, font and background
  literal, that the same theme's dark block applies, and that both choices
  survive a reload.
