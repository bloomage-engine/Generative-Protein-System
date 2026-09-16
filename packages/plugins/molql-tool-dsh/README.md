# @science-studio/molql-tool-dsh

A DeepSeek Harness plugin that registers the **`molql`** tool. The model turns a
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

The result travels as the ordinary tool-call output; the Science Studio web app
parses it (via `@science-studio/molql-viewer`) and highlights/focuses the atoms
in the open structure. The tool never touches a structure — semantic validation
(does the selection match anything) happens in the browser.

It also registers the full MolQL syntax manual as an embedded skill (when the
skill registry is mounted), so the model can load it on demand; the tool
description carries a cheat-sheet for the common cases.

## Layout

```
src/index.ts            cordis plugin: ctx.tools.register(defineTool({...}))
scripts/sync-skill.mjs  copies packages/skills/molql -> ./skill before build
skill/                  generated; not edited by hand
```

## Build

This package is deliberately **not** part of the repo's root build (it is an
agent-side deployable). Build it from its own directory, where its
`@deepseek-ai/*` peers resolve through the monorepo's `node_modules`:

```bash
node scripts/sync-skill.mjs
../../../node_modules/.bin/tsc -b tsconfig.json
```

(For an out-of-repo checkout, run `npm install` here first.)

## Deploy

Mount it in the harness composition (`<harness home>/settings.yaml`):

```yaml
- name: '@science-studio/molql-tool-dsh'
```

The syntax manual lives at `skill/SKILL.md` + `skill/references/molql-syntax.md`
(synced from `packages/skills/molql`).
