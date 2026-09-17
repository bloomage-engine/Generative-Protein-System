# Right Pane Collapsible Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the right pane as a stack of three collapsible, resizable modules — Files, Subagents, Cron — on the shadcn `Collapsible` primitive, with Files keeping the workspace tree and the other two rendering empty-state shells.

**Architecture:** A presentation-only `SidebarSection` wraps shadcn `Collapsible` (header = trigger, body = `CollapsibleContent`). Each module composes one; `RightPanel` stacks them and owns the pointer-drag resize handles. Open flags and the two non-Files heights are in-memory chrome state in the zustand store; Files is `flex-1` and absorbs the remainder.

**Tech Stack:** TypeScript, React 19, Next.js 15, Tailwind v4, shadcn/ui (`radix-ui` Collapsible already vendored at `apps/web/components/ui/collapsible.tsx`), zustand, lucide-react.

## Global Constraints

- Every artifact (this plan, commit messages, code identifiers, comments) is in English; conversation is Chinese.
- Match the existing comment style: source files carry a brief purpose comment where the shape is non-obvious; `apps/web/test/*.mjs` files open with a short "what this guards" comment. Do not over-comment.
- NO new dependencies. `Collapsible` already exists at `apps/web/components/ui/collapsible.tsx` (imports from `radix-ui`). The `collapsible-down` / `collapsible-up` keyframes already exist in `apps/web/app/globals.css`.
- Follow existing shadcn/ui + Tailwind v4 conventions (`cn` from `@/lib/utils`, `data-slot` attributes). No inline `style` for theming — only for the dynamic section height.
- State is IN-MEMORY only: open flags and heights live in `studio-store.ts`, never `localStorage`.
- The real type gate is the root `npm run build` (its last step is `typecheck:tests`); the root `npm run typecheck` is known-broken (TS6310). For the app alone: `npm run build -w @science-studio/transport-client && npm run typecheck -w @science-studio/web`.
- `apps/web` e2e tests need a Chromium (auto-detected; they SKIP without one) and depend on `@science-studio/transport-client` being built (`npm run build -w @science-studio/transport-client`).
- Do not touch `apps/web/app/api/**` route segment config.
- Reference spec: `docs/superpowers/specs/2026-09-17-right-panel-collapsible-sections-design.md`.

---

## File Structure

- `apps/web/test/right-panel-sections.test.mjs` (new) — browser regression for collapse/expand/resize.
- `apps/web/store/studio-store.ts` (modify) — `rightSections`, `rightHeights`, two actions.
- `apps/web/components/studio/sidebar-section.tsx` (new) — the `Collapsible` shell + `ModuleEmptyState`.
- `apps/web/components/studio/workspace-tree.tsx` (modify) — render the tree through `SidebarSection`; header controls become `actions`.
- `apps/web/components/studio/subagents-view.tsx` (new) — Subagents section shell.
- `apps/web/components/studio/cron-view.tsx` (new) — Cron section shell.
- `apps/web/components/studio/right-panel.tsx` (new) — the stacked pane + resize handles.
- `apps/web/components/studio/workspace.tsx` (modify) — render `RightPanel` in the right slot.
- `apps/web/components/studio/panel-toggles.tsx` (modify) — relabel the toggle "Right panel".

---

### Task 1: Regression test for the sections (red)

**Files:**
- Test: `apps/web/test/right-panel-sections.test.mjs`

**Interfaces:**
- Consumes: `./harness.mjs` (`findChromium`, `freePort`, `startWebServer`, `waitForServer`, `warmWorkbench`, `newWorkbenchPage`, `killTree`, `mockWorkbenchSurfaces`, `mockRecordSurface`, `HISTORY_MARKER`).
- Produces: nothing imported by other tasks; it is the acceptance test for Tasks 2–4. It asserts the `data-section` hooks and the `separator` handle role the later tasks must render.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/right-panel-sections.test.mjs`:

```js
/**
 * Regression: the right pane stacks three collapsible modules (Files,
 * Subagents, Cron). Files is open by default and holds the tree; the other two
 * start collapsed, expand to an empty state, and are resizable by dragging
 * their handle. Collapsing Files unmounts the tree; re-expanding restores it.
 *
 * Prereq: `npm run build -w @science-studio/transport-client`.
 * Needs a Chromium; SKIPPED when none is found.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MARKER,
  findChromium,
  freePort,
  killTree,
  newWorkbenchPage,
  mockRecordSurface,
  mockWorkbenchSurfaces,
  startWebServer,
  waitForServer,
  warmWorkbench,
} from "./harness.mjs";

test(
  "the right pane stacks collapsible Files, Subagents and Cron sections",
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

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      // Files is open by default, so the tree is already mounted.
      const tree = page.getByRole("tree");
      await tree.waitFor({ timeout: 30_000 });

      const subagents = page.locator('[data-section="subagents"]');
      const cron = page.locator('[data-section="cron"]');
      await subagents.waitFor({ timeout: 15_000 });
      await cron.waitFor({ timeout: 15_000 });

      // The two new modules start collapsed: headers present, copy absent.
      assert.equal(
        await subagents.getByRole("button", { name: "Subagents" }).getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(
        await cron.getByRole("button", { name: "Cron" }).getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(await subagents.getByText("No subagents yet.").count(), 0);
      assert.equal(await cron.getByText("No scheduled tasks.").count(), 0);

      // Expanding reveals the empty state.
      await subagents.getByRole("button", { name: "Subagents" }).click();
      await subagents.getByText("No subagents yet.").waitFor({ timeout: 10_000 });
      await cron.getByRole("button", { name: "Cron" }).click();
      await cron.getByText("No scheduled tasks.").waitFor({ timeout: 10_000 });

      // Dragging the Subagents handle up grows that section.
      const before = await subagents.boundingBox();
      const handle = page.getByRole("separator", { name: "Resize Subagents" });
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 60, { steps: 8 });
      await page.mouse.up();
      const after = await subagents.boundingBox();
      assert.ok(
        after.height >= before.height + 40,
        `expected the section to grow, got ${before.height} -> ${after.height}`,
      );

      // Collapsing Files unmounts the tree; re-expanding restores it.
      await page.getByRole("button", { name: "Files" }).click();
      await tree.waitFor({ state: "detached", timeout: 10_000 });
      await page.getByRole("button", { name: "Files" }).click();
      await page.getByRole("tree").waitFor({ timeout: 10_000 });
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build -w @science-studio/transport-client && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test apps/web/test/right-panel-sections.test.mjs`
Expected: FAIL — `page.locator('[data-section="subagents"]')` times out because the pane is currently a single `WorkspaceTree` with no sections. (If no Chromium is found the test SKIPs; install one with `npx playwright install chromium` to see the red.)

- [ ] **Step 3: Commit the failing test**

```bash
git add apps/web/test/right-panel-sections.test.mjs
git commit -m "test(web): cover the right-pane collapsible sections"
```

---

### Task 2: Store state and the `SidebarSection` shell

**Files:**
- Modify: `apps/web/store/studio-store.ts`
- Create: `apps/web/components/studio/sidebar-section.tsx`

**Interfaces:**
- Consumes: `Collapsible`, `CollapsibleContent`, `CollapsibleTrigger` from `@/components/ui/collapsible` (already present); `cn` from `@/lib/utils`.
- Produces:
  - `RightSectionId = "files" | "subagents" | "cron"` from `@/store/studio-store`.
  - Store: `rightSections: Record<RightSectionId, boolean>`, `rightHeights: { subagents: number; cron: number }`, `toggleRightSection(id: RightSectionId): void`, `setRightSectionHeight(id: "subagents" | "cron", height: number): void`.
  - `SidebarSection(props)` from `@/components/studio/sidebar-section`: `{ section: string; title: string; icon: LucideIcon; open: boolean; onOpenChange: (open: boolean) => void; actions?: ReactNode; className?: string; style?: CSSProperties; children: ReactNode }`. Renders `data-section={section}` on its root.
  - `ModuleEmptyState(props)`: `{ icon: LucideIcon; message: string; hint: string }`.

- [ ] **Step 1: Add the store state**

In `apps/web/store/studio-store.ts`, add the exported type near `LeftView` (after line 26):

```ts
/** The right pane's three collapsible modules. */
export type RightSectionId = "files" | "subagents" | "cron";
```

In the `State` type, add after `rightPanel: boolean;`:

```ts
  /** Which right-pane modules are expanded (in memory; reload returns to defaults). */
  rightSections: Record<RightSectionId, boolean>;
  /** Pixel heights of the two non-Files modules, kept across a collapse. */
  rightHeights: { subagents: number; cron: number };
```

In the `State` type, add after `toggleRight: () => void;`:

```ts
  toggleRightSection: (id: RightSectionId) => void;
  setRightSectionHeight: (id: "subagents" | "cron", height: number) => void;
```

In the initial state, add after `rightPanel: true,`:

```ts
  rightSections: { files: true, subagents: false, cron: false },
  rightHeights: { subagents: 200, cron: 200 },
```

In the implementation, add after `toggleRight: () => set((s) => ({ rightPanel: !s.rightPanel })),`:

```ts
  toggleRightSection: (id) =>
    set((s) => ({ rightSections: { ...s.rightSections, [id]: !s.rightSections[id] } })),
  setRightSectionHeight: (id, height) =>
    set((s) => ({ rightHeights: { ...s.rightHeights, [id]: height } })),
```

- [ ] **Step 2: Write the `SidebarSection` shell**

Create `apps/web/components/studio/sidebar-section.tsx`:

```tsx
"use client";

import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * A titled, collapsible right-pane module. The header's title area is the
 * `CollapsibleTrigger`; `actions` is a SIBLING of it, so a header action
 * (upload, refresh) can never toggle the section.
 */
export function SidebarSection({
  section,
  title,
  icon: Icon,
  open,
  onOpenChange,
  actions,
  className,
  style,
  children,
}: {
  section: string;
  title: string;
  icon: LucideIcon;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      data-section={section}
      data-slot="sidebar-section"
      style={style}
      className={cn("flex min-h-0 flex-col overflow-hidden", className)}
    >
      <div className="flex items-center gap-1 px-2 py-1.5">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center gap-1 text-left"
          >
            <ChevronRight
              className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
            />
            <Icon className="size-3.5 shrink-0" />
            <span className="text-foreground truncate text-xs font-medium">{title}</span>
          </button>
        </CollapsibleTrigger>
        {actions ? <div className="flex items-center gap-0.5">{actions}</div> : null}
      </div>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down min-h-0 flex-1 overflow-hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The neutral empty state a not-yet-wired module shows. */
export function ModuleEmptyState({
  icon: Icon,
  message,
  hint,
}: {
  icon: LucideIcon;
  message: string;
  hint: string;
}) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <Icon className="size-5 opacity-60" />
      <div className="text-xs">{message}</div>
      <div className="text-[11px] opacity-70">{hint}</div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npm run build -w @science-studio/transport-client && npm run typecheck -w @science-studio/web`
Expected: PASS, no errors. (The new files are unreferenced; this proves they compile.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/store/studio-store.ts apps/web/components/studio/sidebar-section.tsx
git commit -m "feat(web): add right-pane section state and a Collapsible shell"
```

---

### Task 3: Render the Files tree through the section shell

**Files:**
- Modify: `apps/web/components/studio/workspace-tree.tsx`

**Interfaces:**
- Consumes: `SidebarSection` (Task 2); store `rightSections.files` + `toggleRightSection` (Task 2); the existing upload/refresh handlers and tree body in this file.
- Produces: `WorkspaceTree({ project }: { project?: string | null })` — same export and props (`apps/web/components/studio/workspace.tsx:55`), now rendering a full-height `SidebarSection` with `section="files"`, title `"Files"`, `data-section="files"`, and the Upload/Refresh buttons as `actions`.

- [ ] **Step 1: Swap the wrapper for `SidebarSection`**

In `apps/web/components/studio/workspace-tree.tsx`:

1. Add `FolderTree` to the lucide import and add the new imports:

```tsx
import { Download, FolderTree, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { SidebarSection } from "./sidebar-section";
```

2. Add the two store reads next to the existing `openFile` / `activeTabPath` reads:

```tsx
  const filesOpen = useStudioStore((s) => s.rightSections.files);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
```

3. Replace the `return (` block's `<aside>`/`<header>` wrapper. The old block starts at `<aside className="relative flex h-full flex-col border-l border-border/70 bg-background">` and ends at `</aside>`. Replace it with:

```tsx
  return (
    <SidebarSection
      section="files"
      title="Files"
      icon={FolderTree}
      open={filesOpen}
      onOpenChange={() => toggleRightSection("files")}
      className="min-h-[72px] flex-1"
      actions={
        <>
          <button
            type="button"
            aria-label="Upload to workspace"
            disabled={busy || root.unavailable}
            onClick={() => triggerUpload("")}
            className="text-muted-foreground hover:text-foreground rounded p-1 disabled:opacity-30"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          </button>
          <button
            type="button"
            aria-label="Refresh"
            onClick={refresh}
            className="text-muted-foreground hover:text-foreground rounded p-1"
          >
            <RefreshCw className={cn("size-4", root.isLoading && "animate-spin")} />
          </button>
        </>
      }
    >
      <div className="relative flex h-full min-h-0 flex-col">
        {actionError && <p className="text-destructive px-3 py-2 text-xs">{actionError}</p>}

        {root.unavailable ? (
          <p className="text-muted-foreground p-3 text-xs">{WORKSPACE_UNAVAILABLE_REASON}</p>
        ) : (
          <>
            {root.error && <p className="text-muted-foreground px-3 py-2 text-xs">{root.error}</p>}
            {loadError && <p className="text-destructive px-3 py-2 text-xs">{loadError}</p>}
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {root.isLoading && (
                <Loader2 className="text-muted-foreground m-2 size-4 animate-spin" />
              )}
              <Tree indent={INDENT} tree={tree} aria-label="Workspace files">
                {tree.getItems().map((item) => (
                  <TreeItem
                    key={item.getId()}
                    item={item}
                    onContextMenu={(e) => onItemContextMenu(e, item)}
                  >
                    <TreeItemLabel>
                      <span className="flex min-w-0 items-center gap-2">
                        {fileIconForName(item.getItemName(), item.isFolder(), item.isExpanded())}
                        <span className="truncate">{item.getItemName()}</span>
                      </span>
                    </TreeItemLabel>
                  </TreeItem>
                ))}
              </Tree>
            </div>
          </>
        )}

        {/* A hidden input drives both the header and the per-folder "Upload files…". */}
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFiles} />

        {menu &&
          createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{
                position: "fixed",
                left: Math.max(4, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 4)),
                top: Math.max(4, Math.min(menu.y, window.innerHeight - 140)),
                width: MENU_WIDTH,
              }}
              className="z-50 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
            >
              <div
                className="text-muted-foreground truncate px-1.5 py-1 text-xs"
                title={menu.entry.path}
              >
                {menu.entry.name}
              </div>
              {menuActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  role="menuitem"
                  onClick={action.onClick}
                  className={cn(
                    "hover:bg-accent flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm select-none",
                    action.destructive &&
                      "text-destructive hover:bg-destructive/10 hover:text-destructive",
                  )}
                >
                  <action.icon className="size-4 shrink-0" />
                  {action.label}
                </button>
              ))}
            </div>,
            document.body,
          )}
      </div>
    </SidebarSection>
  );
}
```

Every handler, ref, effect and `MENU_WIDTH` above the return is unchanged. In particular `triggerUpload`, `refresh`, `busy`, `handleFiles`, `fileInputRef`, `menu`, `menuRef`, `menuActions`, `onItemContextMenu` keep their current definitions.

- [ ] **Step 2: Type-check**

Run: `npm run build -w @science-studio/transport-client && npm run typecheck -w @science-studio/web`
Expected: PASS.

- [ ] **Step 3: Run the existing tree regression (no behavior loss)**

Run: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test apps/web/test/workspace-tree.test.mjs`
Expected: PASS (or SKIP with no Chromium). It must not FAIL — the tree is still mounted by default and still opens a clicked file.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/studio/workspace-tree.tsx
git commit -m "refactor(web): render the Files tree through the section shell"
```

---

### Task 4: Subagents/Cron sections, `RightPanel`, and wiring

**Files:**
- Create: `apps/web/components/studio/subagents-view.tsx`
- Create: `apps/web/components/studio/cron-view.tsx`
- Create: `apps/web/components/studio/right-panel.tsx`
- Modify: `apps/web/components/studio/workspace.tsx`
- Modify: `apps/web/components/studio/panel-toggles.tsx`

**Interfaces:**
- Consumes: `SidebarSection`, `ModuleEmptyState` (Task 2); store `rightSections`, `rightHeights`, `toggleRightSection`, `setRightSectionHeight` (Task 2); `WorkspaceTree` (Task 3).
- Produces:
  - `SubagentsView()` and `CronView()` from their files (no props).
  - `RightPanel({ project }: { project: string | null })` from `@/components/studio/right-panel`.
  - A resize handle rendered as `role="separator"` with `aria-label="Resize Subagents"` / `"Resize Cron"` (the Task 1 test depends on these).

- [ ] **Step 1: Write the Subagents section**

Create `apps/web/components/studio/subagents-view.tsx`:

```tsx
"use client";

import { Bot } from "lucide-react";
import { ModuleEmptyState, SidebarSection } from "./sidebar-section";
import { useStudioStore } from "@/store/studio-store";

/** The Subagents module. A skeleton: no subagent data source exists yet. */
export function SubagentsView() {
  const open = useStudioStore((s) => s.rightSections.subagents);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.subagents);

  return (
    <SidebarSection
      section="subagents"
      title="Subagents"
      icon={Bot}
      open={open}
      onOpenChange={() => toggleRightSection("subagents")}
      className="shrink-0"
      style={open ? { height } : undefined}
    >
      <ModuleEmptyState
        icon={Bot}
        message="No subagents yet."
        hint="Subagent runs will appear here."
      />
    </SidebarSection>
  );
}
```

- [ ] **Step 2: Write the Cron section**

Create `apps/web/components/studio/cron-view.tsx`:

```tsx
"use client";

import { CalendarClock } from "lucide-react";
import { ModuleEmptyState, SidebarSection } from "./sidebar-section";
import { useStudioStore } from "@/store/studio-store";

/** The Cron module. A skeleton: no scheduled-work data source exists yet. */
export function CronView() {
  const open = useStudioStore((s) => s.rightSections.cron);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.cron);

  return (
    <SidebarSection
      section="cron"
      title="Cron"
      icon={CalendarClock}
      open={open}
      onOpenChange={() => toggleRightSection("cron")}
      className="shrink-0"
      style={open ? { height } : undefined}
    >
      <ModuleEmptyState
        icon={CalendarClock}
        message="No scheduled tasks."
        hint="Scheduled runs will appear here."
      />
    </SidebarSection>
  );
}
```

- [ ] **Step 3: Write the right panel with resize handles**

Create `apps/web/components/studio/right-panel.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { CronView } from "./cron-view";
import { SubagentsView } from "./subagents-view";
import { WorkspaceTree } from "./workspace-tree";
import { useStudioStore } from "@/store/studio-store";

const MIN_SECTION_PX = 120;
const FILES_MIN_PX = 72;
const HANDLE_PX = 4;
const COLLAPSED_HEADER_PX = 30;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * A drag handle that resizes the module BELOW it by growing/shrinking the
 * pane's bottom edge. Dragging up grows the lower module; Files (`flex-1`)
 * absorbs the difference.
 */
function ResizeHandle({ section, label }: { section: "subagents" | "cron"; label: string }) {
  const setHeight = useStudioStore((s) => s.setRightSectionHeight);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      onPointerDown={(event) => {
        event.preventDefault();
        const handle = event.currentTarget;
        const containerHeight = handle.parentElement?.clientHeight ?? 600;
        const startY = event.clientY;
        const state = useStudioStore.getState();
        const startHeight = state.rightHeights[section];

        const other = section === "subagents" ? "cron" : "subagents";
        const otherOpen = state.rightSections[other];
        const reserved =
          FILES_MIN_PX +
          HANDLE_PX +
          (otherOpen ? state.rightHeights[other] + HANDLE_PX : COLLAPSED_HEADER_PX);
        const max = Math.max(MIN_SECTION_PX, containerHeight - reserved);

        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
          /* pointer already captured */
        }

        const onMove = (moveEvent: PointerEvent) => {
          const next = clamp(startHeight + (startY - moveEvent.clientY), MIN_SECTION_PX, max);
          setHeight(section, next);
        };
        const onUp = () => {
          try {
            handle.releasePointerCapture(event.pointerId);
          } catch {
            /* already released */
          }
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          cleanupRef.current = null;
        };
        cleanupRef.current = onUp;
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      }}
      className="bg-border hover:bg-primary/40 h-1 shrink-0 cursor-row-resize touch-none"
    />
  );
}

/** The right pane: Files (flexible) stacked above Subagents and Cron. */
export function RightPanel({ project }: { project: string | null }) {
  const subagentsOpen = useStudioStore((s) => s.rightSections.subagents);
  const cronOpen = useStudioStore((s) => s.rightSections.cron);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border/70 bg-background">
      <WorkspaceTree project={project} />
      {subagentsOpen && <ResizeHandle section="subagents" label="Resize Subagents" />}
      <SubagentsView />
      {cronOpen && <ResizeHandle section="cron" label="Resize Cron" />}
      <CronView />
    </aside>
  );
}
```

> **Amendment (final review):** the resize clamp now reserves the other module's current height (plus Files' 72 px minimum and the handles) instead of a flat `MAX_FRACTION`, so a drag cannot make the two sections overflow the pane; the handle also gained `touch-none`, guarded pointer capture, and an unmount cleanup.

- [ ] **Step 4: Wire `RightPanel` into the workbench**

In `apps/web/components/studio/workspace.tsx`, replace the `WorkspaceTree` import:

```tsx
import { WorkspaceTree } from "./workspace-tree";
```

with:

```tsx
import { RightPanel } from "./right-panel";
```

and replace the right Panel's child:

```tsx
        <Panel id="right" defaultSize="30" minSize="15" maxSize="60" className="h-full">
          <WorkspaceTree project={projectId} />
        </Panel>
```

with:

```tsx
        <Panel id="right" defaultSize="30" minSize="15" maxSize="60" className="h-full">
          <RightPanel project={projectId} />
        </Panel>
```

- [ ] **Step 5: Relabel the pane toggle**

In `apps/web/components/studio/panel-toggles.tsx`, change the right-panel button's `aria-label` and tooltip body from "Files" to "Right panel":

```tsx
            aria-label="Right panel"
```

```tsx
        <TooltipContent>Right panel</TooltipContent>
```

- [ ] **Step 6: Type-check**

Run: `npm run build -w @science-studio/transport-client && npm run typecheck -w @science-studio/web`
Expected: PASS.

- [ ] **Step 7: Run the new regression test**

Run: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test apps/web/test/right-panel-sections.test.mjs`
Expected: PASS (or SKIP with no Chromium). If the resize assertion fails, confirm the handle's `parentElement` is the `<aside>` and that `rightHeights.subagents` starts at `200`.

- [ ] **Step 8: Run the full root build gate**

Run: `npm run build`
Expected: PASS through `typecheck:tests`.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/studio/subagents-view.tsx apps/web/components/studio/cron-view.tsx apps/web/components/studio/right-panel.tsx apps/web/components/studio/workspace.tsx apps/web/components/studio/panel-toggles.tsx
git commit -m "feat(web): stack Files, Subagents and Cron in the right pane"
```

---

## Self-Review

- **Spec coverage:** three collapsible modules (Tasks 3–4); shadcn `Collapsible` as the one open/close mechanism (Task 2); custom pointer drag handle (Task 4); Files `flex-1` & the other two store heights (Tasks 2, 4); in-memory only (Task 2, no `localStorage`); empty-state copy (Task 4); `WorkspaceTree` header extraction into `actions` (Task 3); `workspace.tsx` wiring (Task 4); pane-toggle relabel (Task 4); regression test (Task 1); existing tree test stays green (Task 3 Step 3). Covered.
- **Placeholder scan:** no TBD/TODO/"add error handling"; every code step carries complete, runnable code, including the full rewritten `workspace-tree.tsx` return block.
- **Type consistency:** `RightSectionId` and the two action names match between Task 2 (definition) and Tasks 3–4 (call sites); `SidebarSection` prop names (`section`/`icon`/`open`/`onOpenChange`/`actions`) match across Tasks 3–4; `ModuleEmptyState` (`icon`/`message`/`hint`) matches Task 4; `data-section` and the `separator` `aria-label`s match the Task 1 selectors.
- **Risk note honored:** because `CollapsibleContent` unmounts, collapsing Files drops the tree's local expand state and re-fetches the root on re-expand. That is the spec's accepted behavior ("collapsing Files unmounts the tree; re-expanding restores it").
```
