# @science-studio/molql-tool-openclaw

An OpenClaw gateway plugin that registers the **`molql`** tool. The model turns a
natural-language request ("highlight chain A", "show residues within 5 Å of the
iron") into a Mol* `mol-script` selection and the tool returns it as structured
JSON:

```json
{
  "type": "molql-selection",
  "molql": "(sel.atom.chains (= atom.chain A))",
  "focus": true,
  "mode": "select"
}
```

The gateway persists the tool result, which reaches the Science Studio web app;
it parses the JSON (via `@science-studio/molql-viewer`) and highlights/focuses
the atoms in the open structure. The tool never touches a structure — semantic
validation happens in the browser.

The full MolQL syntax manual ships under `skill/` and is mirrored from
`packages/skills/molql`; the tool description carries a cheat-sheet.

## Layout

```
src/index.ts            defineToolPlugin({ id, name, tools: (tool) => [ tool({ name: 'molql', ... }) ] })
openclaw.plugin.json    plugin manifest (contracts.tools: ['molql'])
scripts/sync-skill.mjs  copies packages/skills/molql -> ./skill before build
skill/                  generated; not edited by hand
```

## Build

This package is deliberately **not** part of the repo's root build (it is a
gateway-side deployable and depends on the large `openclaw` package, which the
root install does not pull). Install and build from this directory:

```bash
npm install
npm run plugin:validate
npm run plugin:build
```

`npm run plugin:build` runs `sync-skill.mjs`, compiles with `tsc`, then runs
`openclaw plugins build`.

## Deploy

```bash
npm run plugin:install   # uninstall + build + install + enable on the gateway
```

or publish to ClawHub (`clawhub package publish .`). The `openclaw` version and
`openclaw.compat.pluginApi` must match the gateway's version.
