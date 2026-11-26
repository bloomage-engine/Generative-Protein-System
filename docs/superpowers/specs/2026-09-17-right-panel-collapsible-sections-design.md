# Right pane — Collapsible sections (Files / Subagents / Cron) (design)

Date: 2026-09-17
Status: approved

## Goal

Turn the right pane into a stack of three collapsible, resizable modules —
**Files**, **Subagents**, **Cron** — built on the shadcn `Collapsible`
primitive (`apps/web/components/ui/collapsible.tsx`). Files keeps the existing
workspace tree as its body; Subagents and Cron are empty-state shells so the
workbench shape is in place before their data sources exist.

This is a UI skeleton: no new record, transport, service or data-layer work.

## Motivation

Today the right pane is a single `WorkspaceTree` that renders its own header
(titled "Files") inside an `<aside>`. There is no room for the other surfaces
the workbench is growing — the subagent activity that emerges from a run, and
scheduled (cron) work. A collapsible stack gives each its own titled region
with an independent open/closed state and height, so later modules can be added
or pointed at real data without restructuring the pane.

## Scope

In scope:

- A collapsible/resizable right pane with three modules.
- A reusable shadcn-`Collapsible` section shell.
- Refactor of `WorkspaceTree` to render a section body (header controls become
  the section's `actions`), not its own `<aside>`/header.
- Store state for per-module open flags and per-module heights (in memory).
- Empty-state views for Subagents and Cron.
- A regression test for the pane's collapse/resize behavior.

Out of scope (unchanged):

- Subagent / cron data: no adapters, no service routes, no record types. The
  two modules only render neutral empty-state copy.
- `FilePreviewPane`, tab strip, top-bar search, status bar, workspace HTTP
  surface, `transport-client` hooks.
- Persisting open flags or heights across reloads (deliberately in-memory; a
  reload returns to the default layout).
- The workspace tree's own loading/reveal behavior (`workspace-tree.tsx`
  internals other than the header extraction).

## Decisions

- **`Collapsible` is the one open/close mechanism.** Each module is a shadcn
  `Collapsible`; the section header is the `CollapsibleTrigger` (a button, so
  `aria-expanded` is exposed and keyboard-operable). No second mechanism (e.g.
  `react-resizable-panels` panel collapse) competes for size.
- **Resizing is a custom pointer-drag handle.** Radix `Collapsible` owns
  open/closed; a handle between modules owns height. Keeping one owner per
  concern avoids the two-mechanisms-fight-over-height problem.
- **Files is the flexible module.** `Files` uses `flex-1 min-h-0` and always
  absorbs the leftover height, so it stays useful when the other two are
  collapsed. `Subagents` / `Cron` carry explicit pixel heights when open and
  only a header when collapsed.
- **Heights live in the store, in memory.** Open flags and the two pixel
  heights are chrome state (like `tabs`/`panel visibility`) in
  `studio-store.ts`, not `localStorage`. A collapse keeps the last height so
  re-expanding restores it.
- **Each module is self-contained.** A shared presentation-only
  `SidebarSection` renders the shell; each module supplies its own body. The
  pane container only stacks them and draws the handles.
- **Empty states are copy, not mock data.** Subagents/Cron render an icon and a
  sentence — no fabricated rows that would later look like real data.

## Components

### `apps/web/components/studio/sidebar-section.tsx` (new)

Presentation-only shell around shadcn `Collapsible`:

- Props: `title: string`, `icon: LucideIcon`, `open: boolean`,
  `onOpenChange: (open: boolean) => void`, `actions?: ReactNode` (rendered
  before the chevron), `children`, `className?`.
- Header: a `div.flex.items-center` row. Its first child is the
  `CollapsibleTrigger asChild` on a `<button className="flex-1 ...">` holding a
  `ChevronRight` (disclosure, rotates on `open`), the module icon and the title.
  Its second child is the `actions` `<div>` (may be empty). Because `actions`
  is a sibling of the trigger, Upload/Refresh clicks can never toggle the
  section — no `stopPropagation`.
- Body: `CollapsibleContent` with the existing `collapsible-down`/`collapsible-up`
  keyframes (`data-[state=closed]:animate-collapsible-up`,
  `data-[state=open]:animate-collapsible-down`), `overflow-hidden`,
  `min-h-0 flex-1`.
- No store or module knowledge; it is reusable and independently testable.

### `apps/web/components/studio/right-panel.tsx` (new)

The right pane container, replacing `<WorkspaceTree>` in `workspace.tsx`:

- Vertical flex, `h-full min-h-0`.
- Reads `rightSections` from the store and renders, in order,
  `<WorkspaceTree>` → `<SubagentsView>` → `<CronView>`, with a `ResizeHandle`
  between adjacent modules.
- Each module composes its own `SidebarSection`: Files passes
  `className="min-h-[72px] flex-1"`; Subagents/Cron read their own
  `rightHeights[id]` and apply `style={{ height }}` only while open (header-only
  when collapsed). The module owns its section config; `RightPanel` owns layout
  and the handles.
- A draggable `ResizeHandle` is rendered between a module and the next module
  **only when the next module (the one whose height it controls) is open**.
  `onPointerDown` captures the pointer; `pointermove` computes
  `startHeight + (startY - currentY)` (drag up grows the lower module), clamps
  to `[MIN_SECTION_PX, containerHeight - reserved]` — where `reserved` is the
  Files floor (`FILES_MIN_PX`) plus the sibling module's preferred height (or its
  collapsed header) plus the drag handles — and writes through
  `setRightSectionHeight`. `pointerup`/`pointercancel` releases the capture.
  The clamp bounds and constants are module-level in this file.

### `apps/web/components/studio/subagents-view.tsx` (new)

`<SidebarSection>` body only: centered empty state — `Bot` icon, "No subagents
yet.", muted hint that subagent runs will appear here. Pure presentation.

### `apps/web/components/studio/cron-view.tsx` (new)

Same shape for scheduled work — `CalendarClock` icon, "No scheduled tasks.",
muted hint.

### `apps/web/components/studio/workspace-tree.tsx` (refactor)

- Remove the `<aside>` and `<header>` wrapper and the Files title.
- Keep the tree body (root/hidden input/context menu portal) and the
  upload/refresh handlers unchanged.
- Render through `SidebarSection`: title "Files", `FolderTree` icon, `actions`
  = the existing Upload button and Refresh button (with their disabled/spin
  states), body = the tree.
- The hidden file `<input>` and context-menu portal stay inside the section
  body so upload/delete continue to work.

### `apps/web/components/studio/workspace.tsx` (edit)

- Replace `<WorkspaceTree project={projectId} />` with
  `<RightPanel project={projectId} />`.

### `apps/web/components/studio/panel-toggles.tsx` (edit)

- The right-panel toggle's `aria-label` / `TooltipContent` change from "Files"
  to "Right panel", since it shows/hides the whole pane, not the Files module.

### `apps/web/store/studio-store.ts` (edit)

Add:

```ts
export type RightSectionId = "files" | "subagents" | "cron";

rightSections: Record<RightSectionId, boolean>;   // { files: true, subagents: false, cron: false }
rightHeights: { subagents: number; cron: number }; // { subagents: 200, cron: 200 }
toggleRightSection: (id: RightSectionId) => void;
setRightSectionHeight: (id: "subagents" | "cron", height: number) => void;
```

`rightHeights` intentionally has no `files` key — Files is flexible.

## Data flow

Open flags flow store → `RightPanel` → `SidebarSection`; toggling calls
`toggleRightSection`, which flips that key only. Height flows store →
`RightPanel` → section `style`; the handle's pointermove calls
`setRightSectionHeight`. `Collapsible`'s own `onOpenChange` is wired straight to
`toggleRightSection` so Radix internal state and the store cannot diverge
(controlled `open`).

## Error handling

- No new network or async path; the modules have no failure modes of their own.
- The tree's existing error / 503 / action-error copy moves unchanged with the
  body.
- The resize clamp prevents a section from collapsing to zero (header stays
  visible) or exceeding the pane, so a bad drag cannot wedge the layout.

## Testing

- New `apps/web/test/right-panel-sections.test.mjs` (reuses `test/harness.mjs`,
  Chromium-gated/skipped like the others):
  - On load Files is expanded (`role="tree"` present) and Subagents/Cron show
    only their headers.
  - Collapsing Files unmounts the tree; re-expanding restores it.
  - Expanding Subagents and Cron reveals their empty-state copy.
  - Dragging a handle changes the section height (assert a height delta in the
    DOM), within clamp bounds.
- Existing `apps/web/test/workspace-tree.test.mjs` relies on the right pane
  being open by default and the tree being mounted — Files defaults open, so it
  stays green; the test's locators do not touch the removed `<aside>`/header.
- `npm run build` is the type gate (includes `typecheck:tests`). The suite
  needs `npm run build -w @gps/transport-client` first, per the
  existing web-e2e notes.

## Risks

- **`CollapsibleContent` height animation vs a fixed pixel height.** Radix
  animates on the `--radix-collapsible-content-height` variable; giving the
  content a fixed height from the store must not fight the animation. If they
  conflict, drop the height transition on the content and animate opacity only
  (the collapse still works; only the motion is lost).
- **Header action clicks toggling the section.** Resolved by design: `actions`
  is a sibling of the trigger, never a child, so it cannot bubble into a
  toggle.
- **Test flakiness on pointer drag.** The drag assertions must use explicit
  pointer down/move/up with intermediate waits, not a synthetic `dragTo`, and
  should assert a conservative delta rather than an exact pixel value.
