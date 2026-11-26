# @gps/molql-tool-dsh

A DeepSeek Harness plugin that registers three tools: **`molql`**
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

The result travels as the ordinary tool-call output; the Generative Protein System web app
parses it (via `@gps/molstar-viewer`) and highlights/focuses the atoms
in the open structure. The tool never touches a structure — semantic validation
(does the selection match anything) happens in the browser.

`computeInteraction` fetches the Generative Protein System service's
`/api/workspace/interactions` route (the service owns workspace file access and
runs Mol* headlessly) from the `@<project>/<path>/<molql>` mention, and returns a
Markdown interaction table.

`measurements` takes a `kind` and an ordered `selections` list (MolQL or full
mentions), fetches `POST /api/workspace/measurements`, and returns the computed
value plus the display directive; the viewer redraws the same measurement via
Mol*'s `StructureMeasurementManager`.

It also registers the full MolQL syntax manual as an embedded skill (when the
skill registry is mounted), so the model can load it on demand; the tool
description carries a cheat-sheet for the common cases.

## Layout

```
src/index.ts            cordis plugin: ctx.tools.register(defineTool({...})) for molql + computeInteraction + measurements
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
- name: '@gps/molql-tool-dsh'
```

The syntax manual lives at `skill/SKILL.md` + `skill/references/molql-syntax.md`
(synced from `packages/skills/molql`).
