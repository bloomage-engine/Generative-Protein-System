# @gps/molql-tool-openclaw

An OpenClaw gateway plugin that registers three tools: **`molql`**
(select/highlight atoms in the open structure), **`computeInteraction`**
(non-covalent interactions for a selection) and **`measurements`**
(label/distance/angle/dihedral/orientation/plane for an ordered selection set).

The model turns a natural-language request ("highlight chain A", "show residues
within 5 Å of the iron") into a Mol* `mol-script` selection and the `molql` tool
returns it as structured JSON:

```json
{
  "type": "molql-selection",
  "molql": "(sel.atom.chains (= atom.chain A))",
  "focus": true,
  "mode": "select"
}
```

The gateway persists the tool result, which reaches the Generative Protein System web app;
it parses the JSON (via `@gps/molstar-viewer`) and highlights/focuses
the atoms in the open structure. The tool never touches a structure — semantic
validation happens in the browser.

`computeInteraction` fetches the Generative Protein System service's
`/api/workspace/interactions` route (the service owns workspace file access and
runs Mol* headlessly) from the `@<project>/<path>/<molql>` mention, and returns a
Markdown interaction table.

`measurements` takes a `kind` and an ordered `selections` list (MolQL or full
mentions), fetches `POST /api/workspace/measurements`, and returns the computed
value plus the display directive; the viewer redraws the same measurement via
Mol*'s `StructureMeasurementManager`.

The full MolQL syntax manual ships under `skill/` and is mirrored from
`packages/skills/molql`; the tool description carries a cheat-sheet.

## Layout

```
src/index.ts            defineToolPlugin({ id, name, tools: (tool) => [ tool({ name: 'molql' }), tool({ name: 'computeInteraction' }), tool({ name: 'measurements' }) ] })
openclaw.plugin.json    plugin manifest (contracts.tools: ['molql', 'computeInteraction', 'measurements'])
scripts/sync-skill.mjs  copies packages/skills/molql -> ./skill before build
scripts/build.mjs       esbuild-bundles src -> dist (inlines typebox)
scripts/install.mjs     npm pack -> openclaw plugins install <tgz>
skill/                  generated; not edited by hand
```

## Build

This package is deliberately **not** part of the repo's root build (it is a
gateway-side deployable). Install and build from this directory:

```bash
npm install
npm run typecheck
npm run plugin:validate
npm run plugin:build
```

`npm run plugin:build` runs `sync-skill.mjs`, bundles `src/index.ts` into
`dist/index.js` with esbuild (inlining `typebox`), then runs
`openclaw plugins build`.

The installed plugin has **no runtime dependencies**: `typebox` is bundled and
`openclaw` is a peerDependency (plus devDependencies for the local build). This
matters — `openclaw plugins install` runs `npm install` for any runtime
`dependencies`, and that step is slow and registry-flaky; it also copies a
directory install recursively (including `node_modules`). Keep `dependencies`
empty; `scripts/install.mjs` installs from an `npm pack` tarball so only the
bundled `dist` + manifest + skill are copied.

## Deploy

```bash
npm run plugin:install   # uninstall + build + pack+install + enable, then restart the gateway
openclaw gateway restart
```

The installer needs `--accept-capabilities` for this tool plugin (the scripts
pass it). Publishing to ClawHub is `clawhub package publish .`. The `openclaw`
version and `openclaw.compat.pluginApi` must match the gateway's version.
