# Workspace file tree — ReUI-style explorer (design)

Date: 2026-09-16
Status: approved

## Goal

Replace the right-pane file browser (`apps/web/components/studio/workspace-tree.tsx`)
with a ReUI `c-tree-5`-style file explorer: a full nested tree with
expand/collapse, per-type icons, keyboard navigation, lazy child loading, and
file-click → the existing preview tabs. The tree is built on
`@headless-tree/react` (the engine ReUI's tree wraps) with a thin shadcn/Tailwind
wrapper, not ReUI's registry file — so we do not take on `@base-ui/react`.

## Motivation

The current browser shows one directory at a time (`useWorkspaceBrowser`) with a
breadcrumb + parent button. That model hides the shape of the workspace and makes
reaching a nested file a multi-click walk. A collapsing tree shows the whole
workspace at once, matches the ReUI file-explorer pattern, and lets keyboard
navigation do the walking.

ReUI's `c-tree-5` is a static demo (a hard-coded nested object, a
demo-only `IconPlaceholder`, and an `@base-ui/react` dependency). It is a visual
and behavioural reference, not a drop-in. We reproduce its look and interaction
on top of the same engine with the repo's own primitives.

## Scope

In scope:

- New shadcn-style tree primitive.
- Rewrite of `workspace-tree.tsx` as a headless-tree explorer.
- Extension-based file icons modeled on `c-tree-5`.
- Two new pinned dependencies in `apps/web`.

Out of scope (unchanged):

- `FilePreviewPane`, the tab strip, top-bar search, status bar.
- The workspace HTTP surface (`/api/workspace/*`) and `transport-client` hooks.
- Drag-and-drop, rename, multi-select, checkboxes, in-tree search (none are part
  of `c-tree-5`).

## Decisions

- **Engine + wrapper, no Base UI.** Depend on `@headless-tree/core@1.7.0` and
  `@headless-tree/react@1.7.0` (exact pins). Write our own `Tree` /
  `TreeItem` / `TreeItemLabel` instead of installing ReUI's `tree.tsx`, which
  imports `@base-ui/react` and `@/app/(create)/components/icon-placeholder`.
- **Lazy async loading.** Use `asyncDataLoaderFeature` so a directory's children
  are fetched the first time it expands, matching the per-directory workspace
  API. Not an eager full-workspace walk (unbounded request fan-out) and not a
  static nested map.
- **Item identity = workspace-relative path.** Root id is `""`. A child's id is
  its entry path, which is already unique across files and directories.
- **Root listing stays shared.** The root directory is the one listing the file
  tree, the status bar's availability chip and the top-bar search all want; the
  tree reads it through the existing `useWorkspaceRoot` shared snapshot so the
  count of root requests does not grow. Deeper directories are per-expand and
  cached by headless-tree.
- **Single click on a file opens it.** Selection state (`selectionFeature`) is
  kept for the active file highlight; activation opens the file in a tab. Click
  on a folder toggles expansion.

## Components

### `apps/web/components/ui/tree.tsx` (new)

A shadcn-style, presentation-only primitive, adapted from ReUI's `tree.tsx`:

- `Tree` — renders the headless-tree container props plus a `--tree-indent` CSS
  variable and `data-slot="tree"`.
- `TreeItem` — renders one row using `item.getProps()`, setting
  `--tree-padding` from `item.getItemMeta().level * indent` and the
  `data-folder` / `data-selected` / `data-focus` attributes.
- `TreeItemLabel` — the label surface, including the folder chevron that rotates
  on `aria-expanded`.
- `TreeDragLine` — omitted (no drag-and-drop in scope).

Differences from ReUI: no `@base-ui/react` (`useRender`/`mergeProps` replaced
with a plain element and merged props), and no `IconPlaceholder` (lucide icons
directly).

### `apps/web/components/studio/workspace-tree.tsx` (rewrite)

Holds the `useTree` instance:

- `features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature]`.
- `rootItemId: ""`, `indent: 20`.
- `getItemName(item)` → `entry.name`; `isItemFolder(item)` → `entry.kind === "dir"`.
- `dataLoader.getChildrenWithData(id)`:
  - For the root (`""`), map the shared `useWorkspaceRoot` listing.
  - For any other directory, `fetchWorkspaceEntries(api, id, project)`.
  - Map each `Entry` to `{ id: entry.path, data: entry }`.
- Renders `tree.getItems()` (root excluded) through the primitive, with
  `fileIconForName` for files and an open/closed folder icon for directories.

Behaviour:

- **Open file** — compose the row click: run the item's own handler (selection /
  folder toggle), then for a non-folder call `openFile(entry.path, entry.name)`.
- **Reveal on external selection** — when `activeTabPath` changes (agent markdown
  link or top-bar search), expand every ancestor directory and select the file,
  so the viewer's file is visible in the tree. Async expansion loads ancestors
  as needed.
- **Refresh** — invalidate the loaded children and re-read; the header button
  keeps the current browser's refresh affordance.
- **Project switch** — the tree is rebuilt for the active Project (the store
  already clears tabs on a Project switch), so no stale paths survive.
- **Unavailable / error** — a 503 shows `WORKSPACE_UNAVAILABLE_REASON` (via
  `isWorkspaceUnavailable`) as neutral copy; other failures show the error text.

Header: a slim title + Refresh button. The breadcrumb and parent-directory
button are dropped as redundant with expand/collapse.

### `apps/web/components/studio/file-icons.tsx` (extend)

Add `fileIconForName(name): ReactNode`, an extension-based map modeled on
`c-tree-5`'s `getFileIcon`:

- folders — amber, `FolderIcon` / `FolderOpenIcon` by expanded state;
- `.ts`/`.tsx`/`.js`/`.jsx`/`.py` — blue `FileCode2`;
- `.css` — purple `Palette`;
- `.json` — yellow `Braces`;
- `.md`/`.mdx` — sky `FileText`;
- otherwise `File` in the muted foreground.

The existing `fileIcon(kind)` (used by the preview pane) is left in place.

## Dependencies

`apps/web/package.json`:

- `@headless-tree/core` `1.7.0`
- `@headless-tree/react` `1.7.0`

Exact pins, consistent with the repo's dependency discipline.

## Verification

- `npm run build` — the real type gate (includes `typecheck:tests`).
- The existing `apps/web/test/*.mjs` suites do not reference the tree DOM
  (confirmed), so no suite rewrite is expected. `npm run test:e2e -w
  @science-studio/web` should stay green.
- Manual: expand/collapse a nested directory; open a file into the preview;
  reveal a file via a top-bar search pick and via an agent file link; switch
  Projects and confirm the tree rebuilds; run with no `PROJECT_ROOT` and confirm
  the friendly 503 copy.

## Cleanup (optional)

`apps/web/components/workspace/workspace-panel.tsx` is an unused, obsolete
duplicate of the browser and can be deleted; nothing imports it. This is
independent of the tree work and can be done or skipped.

## Risks

- **headless-tree API drift** — the exact async-loader contract (`getChildren`
  vs `getChildrenWithData`, `invalidateChildrenIds`) is pinned at 1.7.0 and
  verified against the type definitions at implementation time.
- **Root-request sharing** — the loader must read the shared root snapshot
  rather than fetch the root again; this is the one invariant the AGENTS notes
  call out, and it is a testable acceptance point.
