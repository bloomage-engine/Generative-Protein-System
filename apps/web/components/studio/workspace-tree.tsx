"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  asyncDataLoaderFeature,
  hotkeysCoreFeature,
  selectionFeature,
  type ItemInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import {
  deleteWorkspaceEntry,
  fetchWorkspaceEntries,
  uploadWorkspaceFile,
  useWorkspaceApi,
  useWorkspaceRoot,
  workspaceFileUrl,
  WORKSPACE_UNAVAILABLE_REASON,
  type DirListing,
  type Entry,
} from "@science-studio/transport-client";
import { Download, FolderTree, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { Tree, TreeItem, TreeItemLabel } from "@/components/ui/tree";
import { cn } from "@/lib/utils";
import { useStudioStore } from "@/store/studio-store";
import { fileIconForName } from "./file-icons";
import { SidebarSection } from "./sidebar-section";

const ROOT_ID = "";
const INDENT = 20;
const MENU_WIDTH = 200;

function ancestorPaths(path: string): string[] {
  const parts = path.split("/");
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i += 1) ancestors.push(parts.slice(0, i).join("/"));
  return ancestors;
}

/** A right-clicked entry plus the cursor position the menu should anchor to. */
interface MenuTarget {
  entry: Entry;
  x: number;
  y: number;
}

export function WorkspaceTree({ project }: { project?: string | null }) {
  const scope = useWorkspaceApi();
  const api = scope.api;
  const proj = project ?? scope.project;

  const root = useWorkspaceRoot({ project: proj });
  const openFile = useStudioStore((s) => s.openFile);
  const activeTabPath = useStudioStore((s) => s.activeTabPath);
  const filesOpen = useStudioStore((s) => s.rightSections.files);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);

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
    setLoadError(null);
    refreshRoot();
    // Only folders have children to re-read; invalidating a file's children
    // asks the API for a listing it answers ENOTDIR (HTTP 500).
    for (const item of tree.getItems()) {
      if (item.isFolder()) void item.invalidateChildrenIds();
    }
  }, [refreshRoot, tree]);

  // -- Context menu (right-click: upload / download / delete) -----------------

  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [uploading, setUploading] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The directory a pending "Upload files…" drops into, read on file pick.
  const uploadTargetRef = useRef<string>("");

  const closeMenu = useCallback(() => setMenu(null), []);

  const onItemContextMenu = (e: MouseEvent, item: ItemInstance<Entry>) => {
    e.preventDefault();
    const entry = item.getItemData();
    if (!entry) return;
    setActionError(null);
    setMenu({ entry, x: e.clientX, y: e.clientY });
  };

  /** Open the OS file picker to upload into `dir` ("" is the workspace root). */
  const triggerUpload = useCallback((dir: string) => {
    uploadTargetRef.current = dir;
    fileInputRef.current?.click();
    setMenu(null);
  }, []);

  const handleFiles = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      if (files.length === 0) return;
      const dir = uploadTargetRef.current;
      setActionError(null);
      setUploading(files.length);
      try {
        for (const file of files) {
          await uploadWorkspaceFile(api, dir ? `${dir}/${file.name}` : file.name, file, proj);
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(0);
      }
      // A new file (or folder) may have landed under an already-listed dir;
      // revalidate the root and every loaded folder so it shows up.
      void refresh();
    },
    [api, proj, refresh],
  );

  const handleDownload = useCallback(
    (entry: Entry) => {
      // A real navigation to the file's download URL — the service answers with
      // `content-disposition: attachment`, so the browser saves it.
      const a = document.createElement("a");
      a.href = workspaceFileUrl(api, entry.path, { download: true, project: proj });
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      closeMenu();
    },
    [api, proj, closeMenu],
  );

  const handleDelete = useCallback(
    async (entry: Entry) => {
      closeMenu();
      const confirmed = window.confirm(
        entry.kind === "dir"
          ? `Delete "${entry.name}" and everything inside it?`
          : `Delete "${entry.name}"?`,
      );
      if (!confirmed) return;
      setActionError(null);
      try {
        await deleteWorkspaceEntry(api, entry.path, proj);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        return;
      }
      void refresh();
    },
    [api, proj, closeMenu, refresh],
  );

  // Dismiss the menu on any outside pointer press or Escape.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const menuActions = useMemo(() => {
    if (!menu) return [];
    const { entry } = menu;
    const actions: Array<{
      label: string;
      icon: typeof Upload;
      destructive?: boolean;
      onClick: () => void;
    }> = [];
    if (entry.kind === "dir") {
      actions.push({
        label: "Upload files…",
        icon: Upload,
        onClick: () => triggerUpload(entry.path),
      });
    } else {
      actions.push({ label: "Download", icon: Download, onClick: () => handleDownload(entry) });
    }
    actions.push({
      label: entry.kind === "dir" ? "Delete folder…" : "Delete file…",
      icon: Trash2,
      destructive: true,
      onClick: () => void handleDelete(entry),
    });
    return actions;
  }, [menu, triggerUpload, handleDownload, handleDelete]);

  const busy = uploading > 0;

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
