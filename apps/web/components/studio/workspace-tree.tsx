"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
} from "@science-studio/transport-client";
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

  const [loadError, setLoadError] = useState<string | null>(null);

  const rootListingRef = useRef<DirListing | null>(null);
  rootListingRef.current = root.listing;
  const rootFailedRef = useRef(false);
  rootFailedRef.current = root.listing == null && (root.error != null || root.unavailable);
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
        const cached = rootListingRef.current;
        if (cached) return cached.entries;
        if (rootFailedRef.current) return [];
        await new Promise<void>((resolve) => rootWaitersRef.current.push(resolve));
        return rootListingRef.current?.entries ?? [];
      }
      try {
        const listing = await fetchWorkspaceEntries(api, id, proj);
        setLoadError(null);
        return listing.entries;
      } catch (error) {
        // headless-tree neither catches a loader rejection nor clears its
        // loading flag, which would wedge the folder. Report it and return empty.
        setLoadError(error instanceof Error ? error.message : String(error));
        return [];
      }
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
    const waiters = rootWaitersRef.current;
    if (root.listing) {
      rootWaitersRef.current = [];
      for (const resolve of waiters) resolve();
      void tree.getItemInstance(ROOT_ID).invalidateChildrenIds(true);
    } else if (root.error || root.unavailable) {
      rootWaitersRef.current = [];
      for (const resolve of waiters) resolve();
    }
  }, [root.listing, root.error, root.unavailable, tree]);

  useEffect(() => {
    if (!activeTabPath) return;
    const ancestors = ancestorPaths(activeTabPath);
    tree.applySubStateUpdate("expandedItems", (old) =>
      Array.from(new Set([...old, ...ancestors])),
    );
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
          {loadError && <p className="text-destructive px-3 py-2 text-xs">{loadError}</p>}
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
