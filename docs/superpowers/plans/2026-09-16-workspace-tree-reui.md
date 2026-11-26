# Workspace File Tree (ReUI-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the right-pane one-directory-at-a-time file browser with a ReUI `c-tree-5`-style explorer — nested expand/collapse, per-type icons, lazy child loading, file-click opens the existing preview.

**Architecture:** A headless-tree engine (`@headless-tree/react`) drives a full nested tree with an async data loader backed by the workspace API. A thin shadcn/Tailwind primitive renders the rows. The root directory reuses the shared `useWorkspaceRoot` snapshot; deeper directories load once per expand. File clicks land on the existing `openFile` → `FilePreviewPane` flow.

**Tech Stack:** TypeScript, React 19, Next.js 15, Tailwind v4, shadcn/ui, `@headless-tree/core` + `@headless-tree/react` 1.7.0, lucide-react.

## Global Constraints

- Every artifact (this plan, commit messages, code identifiers) is in English; conversation is Chinese.
- Match the existing comment style: source files carry a brief purpose comment where the shape is non-obvious; `apps/web/test/*.mjs` files open with a short "what this guards" comment (see `workspace-panel-history.test.mjs`). Do not over-comment.
- Dependencies are pinned EXACTLY: `@headless-tree/core@1.7.0`, `@headless-tree/react@1.7.0`. Do NOT add `@base-ui/react`.
- Follow the existing shadcn/ui + Tailwind v4 conventions (`cn` from `@/lib/utils`, `data-slot` attributes).
- The real type gate is the root `npm run build`; the root `npm run typecheck` is known-broken (TS6310). Use `npm run typecheck -w @gps/web` for the app, after `npm run build -w @gps/transport-client`.
- `apps/web` e2e tests need a Chromium (auto-detected; the test SKIPS without one) and depend on `apps/web` and `@gps/transport-client` being importable.
- Do not touch `apps/web/app/api/**` route segment config (`runtime`/`dynamic` stay literal).
- Reference spec: `docs/superpowers/specs/2026-09-16-workspace-tree-reui-design.md`.

---

## File Structure

- `apps/web/components/ui/tree.tsx` (new) — presentation-only `Tree` / `TreeItem` / `TreeItemLabel` primitive over headless-tree instances.
- `apps/web/components/studio/file-icons.tsx` (modify) — add `fileIconForName(name, isFolder, isExpanded)`.
- `apps/web/components/studio/workspace-tree.tsx` (rewrite) — the explorer; owns the `useTree` instance and the workspace data loader.
- `apps/web/test/workspace-tree.test.mjs` (new) — the browser regression suite for expand/open/lazy.
- `apps/web/package.json` (modify) — the two pinned dependencies.

---

### Task 1: Regression test for the tree (red)

**Files:**
- Test: `apps/web/test/workspace-tree.test.mjs`

**Interfaces:**
- Consumes: `./harness.mjs` (`findChromium`, `freePort`, `startWebServer`, `waitForServer`, `warmWorkbench`, `newWorkbenchPage`, `killTree`, `mockWorkbenchSurfaces`, `mockRecordSurface`, `HISTORY_MARKER`).
- Produces: nothing imported by other tasks; it is the acceptance test for Task 3.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/workspace-tree.test.mjs`:

```js
/**
 * Regression: the Files pane is a nested, lazy tree, not a one-level list.
 *
 * The tree must render top-level entries as `treeitem`s and must NOT fetch a
 * directory until it is expanded; clicking a file must open it in the center
 * preview. Against the old one-directory-at-a-time browser (which has no
 * `role="tree"`) this test is red.
 *
 * Prereq: `npm run build -w @gps/transport-client`.
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

const LISTINGS = {
  "": [
    { path: "notes.txt", name: "notes.txt", kind: "file", size: 3 },
    { path: "src", name: "src", kind: "dir" },
  ],
  src: [{ path: "src/index.ts", name: "index.ts", kind: "file", size: 10 }],
};

test(
  "the workspace tree expands lazily and opens a clicked file",
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

      // Registered after the harness routes (Playwright tries the most recent
      // first), so this per-directory listing wins over the flat default.
      const requestedDirs = [];
      await page.route("**/api/workspace/entries*", async (route) => {
        const url = new URL(route.request().url());
        const path = url.searchParams.get("path") ?? "";
        requestedDirs.push(path);
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, entries: LISTINGS[path] ?? [] }),
        });
      });
      await page.route("**/api/workspace/file*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: "index body",
        }),
      );

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      await page.getByRole("button", { name: "Files" }).click();

      const tree = page.getByRole("tree");
      await tree.waitFor({ timeout: 30_000 });
      const src = tree.getByRole("treeitem", { name: "src" });
      await src.waitFor({ timeout: 15_000 });

      assert.equal(await src.getAttribute("aria-expanded"), "false");
      assert.equal(
        requestedDirs.includes("src"),
        false,
        "an unexpanded directory must not be fetched",
      );

      await src.click();
      await tree.getByRole("treeitem", { name: "index.ts" }).waitFor({ timeout: 15_000 });
      assert.equal(await src.getAttribute("aria-expanded"), "true");
      assert.ok(requestedDirs.includes("src"), "expanding must load that directory");

      await tree.getByRole("treeitem", { name: "index.ts" }).click();
      await page.getByText("/src/index.ts", { exact: true }).waitFor({ timeout: 15_000 });
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

Run: `npm run build -w @gps/transport-client && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test apps/web/test/workspace-tree.test.mjs`
Expected: FAIL — `getByRole("tree")` times out because the current browser renders a flat `<ul>` with no `role="tree"`. (If no Chromium is found the test SKIPs; install one with `npx playwright install chromium` to see the red.)

- [ ] **Step 3: Commit the failing test**

```bash
git add apps/web/test/workspace-tree.test.mjs
git commit -m "test(web): cover the workspace tree's lazy expand and open"
```

---

### Task 2: Dependencies, tree primitive, and file icons

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/components/ui/tree.tsx`
- Modify: `apps/web/components/studio/file-icons.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `Tree`, `TreeItem`, `TreeItemLabel` from `@/components/ui/tree` — exported function components; `Tree` takes `{ indent?: number; tree: TreeInstance<T> } & HTMLAttributes<HTMLDivElement>`, `TreeItem` takes `{ item: ItemInstance<T> } & HTMLAttributes<HTMLButtonElement>`, `TreeItemLabel` takes `HTMLAttributes<HTMLSpanElement>` and reads its item from the enclosing `TreeItem`.
  - `fileIconForName(name: string, isFolder: boolean, isExpanded: boolean): ReactNode` from `@/components/studio/file-icons`.

- [ ] **Step 1: Add the pinned dependencies**

Run:

```bash
npm install @headless-tree/core@1.7.0 @headless-tree/react@1.7.0 -w @gps/web
```

Expected: both names appear under `dependencies` in `apps/web/package.json` with exact versions, and `package-lock.json` updates.

- [ ] **Step 2: Write the tree primitive**

Create `apps/web/components/ui/tree.tsx`:

```tsx
"use client";

import {
  createContext,
  useContext,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import type { ItemInstance, TreeInstance } from "@headless-tree/core";
import { cn } from "@/lib/utils";

const TreeIndentContext = createContext(20);

interface TreeItemContextValue<T = unknown> {
  item?: ItemInstance<T>;
}

const TreeItemContext = createContext<TreeItemContextValue>({});

export function Tree<T>({
  indent = 20,
  tree,
  className,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { indent?: number; tree: TreeInstance<T> }) {
  const containerProps = tree.getContainerProps();
  return (
    <TreeIndentContext.Provider value={indent}>
      <div
        {...props}
        {...containerProps}
        data-slot="tree"
        style={
          {
            ...(containerProps.style as CSSProperties),
            ...style,
            "--tree-indent": `${indent}px`,
          } as CSSProperties
        }
        className={cn("flex flex-col", className)}
      />
    </TreeIndentContext.Provider>
  );
}

export function TreeItem<T>({
  item,
  className,
  style,
  children,
  ...props
}: HTMLAttributes<HTMLButtonElement> & { item: ItemInstance<T>; children?: ReactNode }) {
  const indent = useContext(TreeIndentContext);
  const itemProps = item.getProps();
  return (
    <TreeItemContext.Provider value={{ item }}>
      <button
        type="button"
        {...props}
        {...itemProps}
        data-slot="tree-item"
        style={
          {
            ...style,
            "--tree-padding": `${item.getItemMeta().level * indent}px`,
          } as CSSProperties
        }
        className={cn(
          "z-10 ps-(--tree-padding) outline-hidden select-none not-last:pb-0.5 focus:z-20 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
          className,
        )}
        data-focus={item.isFocused()}
        data-folder={item.isFolder()}
        data-selected={item.isSelected()}
        aria-expanded={item.isFolder() ? item.isExpanded() : undefined}
      >
        {children}
      </button>
    </TreeItemContext.Provider>
  );
}

export function TreeItemLabel({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  const { item } = useContext(TreeItemContext);
  return (
    <span
      data-slot="tree-item-label"
      className={cn(
        "bg-background hover:bg-accent flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors [&_svg]:pointer-events-none [&_svg]:shrink-0",
        item?.isSelected() && "bg-accent text-accent-foreground",
        className,
      )}
      {...props}
    >
      {item?.isFolder() ? (
        <ChevronDown
          className={cn("text-muted-foreground size-4", !item.isExpanded() && "-rotate-90")}
        />
      ) : null}
      {children}
    </span>
  );
}
```

Note: headless-tree's `getProps()` / `getContainerProps()` return `ref` among their props; React 19 accepts `ref` in a spread onto a host element, so the primitives forward element registration without extra wiring.

- [ ] **Step 3: Add the extension-based icons**

Replace `apps/web/components/studio/file-icons.tsx` with:

```tsx
"use client";

import type { ReactNode } from "react";
import {
  Braces,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Palette,
} from "lucide-react";
import type { FileKind } from "./file-utils";

export function fileIcon(kind: FileKind): ReactNode {
  switch (kind) {
    case "markdown":
      return <FileText className="size-3.5 text-sky-500" />;
    case "json":
      return <Braces className="size-3.5 text-amber-500" />;
    case "code":
      return <FileCode2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />;
    default:
      return <File className="size-3.5 text-muted-foreground" />;
  }
}

export function fileIconForName(
  name: string,
  isFolder: boolean,
  isExpanded: boolean,
): ReactNode {
  if (isFolder) {
    return isExpanded ? (
      <FolderOpen className="size-4 shrink-0 text-amber-500" />
    ) : (
      <Folder className="size-4 shrink-0 text-amber-500" />
    );
  }
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["ts", "tsx", "js", "jsx", "mjs", "py", "go", "rs"].includes(ext)) {
    return <FileCode2 className="size-4 shrink-0 text-blue-500" />;
  }
  if (ext === "css" || ext === "scss") {
    return <Palette className="size-4 shrink-0 text-purple-500" />;
  }
  if (ext === "json") {
    return <Braces className="size-4 shrink-0 text-yellow-500" />;
  }
  if (ext === "md" || ext === "mdx") {
    return <FileText className="size-4 shrink-0 text-sky-500" />;
  }
  return <File className="text-muted-foreground size-4 shrink-0" />;
}
```

- [ ] **Step 4: Type-check the app**

Run: `npm run build -w @gps/transport-client && npm run typecheck -w @gps/web`
Expected: PASS with no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json package-lock.json apps/web/components/ui/tree.tsx apps/web/components/studio/file-icons.tsx
git commit -m "feat(web): add a headless-tree primitive and file-type icons"
```

---

### Task 3: Rewrite the workspace tree

**Files:**
- Modify: `apps/web/components/studio/workspace-tree.tsx`

**Interfaces:**
- Consumes: `Tree`, `TreeItem`, `TreeItemLabel` (Task 2); `fileIconForName` (Task 2); `useWorkspaceRoot`, `useWorkspaceApi`, `fetchWorkspaceEntries`, `WORKSPACE_UNAVAILABLE_REASON`, types `Entry` / `DirListing` from `@gps/transport-client`; `useStudioStore` (`openFile`, `activeTabPath`).
- Produces: `WorkspaceTree({ project }: { project?: string | null })` — same export and props the shell already uses (`apps/web/components/studio/workspace.tsx:55`).

- [ ] **Step 1: Rewrite `workspace-tree.tsx`**

Replace `apps/web/components/studio/workspace-tree.tsx` with:

```tsx
"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  asyncDataLoaderFeature,
  hotkeysCoreFeature,
  selectionFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import {
  fetchWorkspaceEntries,
  useWorkspaceApi,
  useWorkspaceRoot,
  WORKSPACE_UNAVAILABLE_REASON,
  type DirListing,
  type Entry,
} from "@gps/transport-client";
import { Loader2, RefreshCw } from "lucide-react";
import { Tree, TreeItem, TreeItemLabel } from "@/components/ui/tree";
import { cn } from "@/lib/utils";
import { useStudioStore } from "@/store/studio-store";
import { fileIconForName } from "./file-icons";

const ROOT_ID = "";
const INDENT = 20;

function ancestorPaths(path: string): string[] {
  const parts = path.split("/");
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i += 1) ancestors.push(parts.slice(0, i).join("/"));
  return ancestors;
}

export function WorkspaceTree({ project }: { project?: string | null }) {
  const scope = useWorkspaceApi();
  const api = scope.api;
  const proj = project ?? scope.project;

  const root = useWorkspaceRoot({ project: proj });
  const openFile = useStudioStore((s) => s.openFile);
  const activeTabPath = useStudioStore((s) => s.activeTabPath);

  const rootListingRef = useRef<DirListing | null>(null);
  rootListingRef.current = root.listing;
  const rootWaitersRef = useRef<Array<() => void>>([]);
  const entryCache = useRef(new Map<string, Entry>());

  entryCache.current.set(ROOT_ID, {
    path: "",
    name: proj ?? "workspace",
    kind: "dir",
  });

  const loadChildren = useCallback(
    async (id: string): Promise<Entry[]> => {
      if (id === ROOT_ID) {
        if (rootListingRef.current) return rootListingRef.current.entries;
        await new Promise<void>((resolve) => rootWaitersRef.current.push(resolve));
        return rootListingRef.current?.entries ?? [];
      }
      const listing = await fetchWorkspaceEntries(api, id, proj);
      return listing.entries;
    },
    [api, proj],
  );

  const tree = useTree<Entry>({
    rootItemId: ROOT_ID,
    indent: INDENT,
    getItemName: (item) => item.getItemData()?.name ?? "",
    isItemFolder: (item) => item.getItemData()?.kind === "dir",
    onPrimaryAction: (item) => {
      const entry = item.getItemData();
      if (entry && entry.kind === "file") openFile(entry.path, entry.name);
    },
    dataLoader: {
      getItem: (id) =>
        entryCache.current.get(id) ?? {
          path: id,
          name: id.split("/").pop() ?? id,
          kind: "file",
        },
      getChildrenWithData: async (id) => {
        const entries = await loadChildren(id);
        return entries.map((entry) => {
          entryCache.current.set(entry.path, entry);
          return { id: entry.path, data: entry };
        });
      },
    },
    features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  useEffect(() => {
    if (!root.listing) return;
    const waiters = rootWaitersRef.current;
    rootWaitersRef.current = [];
    for (const resolve of waiters) resolve();
    void tree.getItemInstance(ROOT_ID).invalidateChildrenIds(true);
  }, [root.listing, tree]);

  useEffect(() => {
    if (!activeTabPath) return;
    const ancestors = ancestorPaths(activeTabPath);
    if (ancestors.length === 0) return;
    tree.setState((old) => ({
      ...old,
      expandedItems: Array.from(new Set([...old.expandedItems, ...ancestors])),
    }));
    tree.setSelectedItems([activeTabPath]);
    tree.rebuildTree();
  }, [activeTabPath, tree]);

  const refreshRoot = root.refresh;
  const refresh = useCallback(() => {
    refreshRoot();
    for (const item of tree.getItems()) void item.invalidateChildrenIds();
  }, [refreshRoot, tree]);

  return (
    <aside className="flex h-full flex-col border-l border-border/70 bg-background">
      <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">Files</span>
        <button
          type="button"
          aria-label="Refresh"
          onClick={refresh}
          className="text-muted-foreground hover:text-foreground rounded p-1"
        >
          <RefreshCw className={cn("size-4", root.isLoading && "animate-spin")} />
        </button>
      </header>

      {root.unavailable ? (
        <p className="text-muted-foreground p-3 text-xs">{WORKSPACE_UNAVAILABLE_REASON}</p>
      ) : (
        <>
          {root.error && <p className="text-destructive px-3 py-2 text-xs">{root.error}</p>}
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {root.isLoading && (
              <Loader2 className="text-muted-foreground m-2 size-4 animate-spin" />
            )}
            <Tree indent={INDENT} tree={tree} aria-label="Workspace files">
              {tree.getItems().map((item) => (
                <TreeItem key={item.getId()} item={item}>
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
    </aside>
  );
}
```

The 503 case is handled by `root.unavailable`, so no separate `isWorkspaceUnavailable` import is needed.

- [ ] **Step 2: Type-check the app**

Run: `npm run build -w @gps/transport-client && npm run typecheck -w @gps/web`
Expected: PASS.

- [ ] **Step 3: Run the regression test to verify it passes**

Run: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test apps/web/test/workspace-tree.test.mjs`
Expected: PASS (or SKIP with no Chromium). It must not FAIL.

- [ ] **Step 4: Run the full root build gate**

Run: `npm run build`
Expected: PASS through `typecheck:tests`.

- [ ] **Step 5: Manual smoke (dev)**

Run: `npm run dev` with a `PROJECT_ROOT` configured, open the workbench, then confirm:
- top-level entries render and nested folders expand/collapse;
- opening a nested file shows it in the center preview and adds a tab;
- a top-bar search pick reveals and selects the file in the tree;
- Refresh re-reads the tree;
- with no `PROJECT_ROOT`, the pane shows the friendly "File browsing is not enabled on this server." copy.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/studio/workspace-tree.tsx
git commit -m "feat(web): browse the workspace with a nested lazy tree"
```

---

### Task 4 (optional): Remove the dead browser

**Files:**
- Delete: `apps/web/components/workspace/workspace-panel.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Nothing imports this file (verified with `grep -rn "WorkspacePanel" apps/web`).

- [ ] **Step 1: Confirm it is unused**

Run: `grep -rn "WorkspacePanel" apps/web --include="*.ts" --include="*.tsx"`
Expected: only the definition inside `components/workspace/workspace-panel.tsx`.

- [ ] **Step 2: Delete it**

```bash
git rm apps/web/components/workspace/workspace-panel.tsx
```

- [ ] **Step 3: Re-run the type gate**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(web): drop the unused file browser panel"
```

---

## Self-Review

- **Spec coverage:** nested expand/collapse (Task 3), per-type icons (Task 2), lazy async loading (Task 3 `getChildrenWithData`), file-click → preview (Task 3 `onPrimaryAction`), shared root listing (Task 3 `loadChildren(ROOT_ID)` + `useWorkspaceRoot`), reveal on `activeTabPath` (Task 3 effect), refresh (Task 3 header), 503 copy (Task 3), exact dependency pins (Task 2), optional cleanup (Task 4). Covered.
- **Placeholder scan:** no TBD/TODO/"add error handling"; every code step carries complete, runnable code.
- **Type consistency:** `Tree`/`TreeItem`/`TreeItemLabel` names match between Task 2 and Task 3; `fileIconForName(name, isFolder, isExpanded)` matches its Task 3 call; `WorkspaceTree({ project })` matches the existing call site; `ROOT_ID`/`ancestorPaths` are local and consistently used.
