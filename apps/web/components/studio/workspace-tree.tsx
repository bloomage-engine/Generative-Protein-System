"use client";

import { useEffect } from "react";
import {
  useWorkspaceBrowser,
  type Entry,
} from "@science-studio/transport-client";
import { ChevronLeft, File, Folder, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStudioStore } from "@/store/studio-store";

/**
 * The right-hand file tree: one level at a time. Clicking a directory
 * navigates into it; clicking a file opens it in the center viewer.
 */
export function WorkspaceTree({ project }: { project?: string | null }) {
  const { path, listing, isLoading, error, unavailable, navigate, refresh } =
    useWorkspaceBrowser({ project });
  const openFile = useStudioStore((s) => s.openFile);
  const activeTabPath = useStudioStore((s) => s.activeTabPath);

  // An externally selected file (an agent link) reveals its directory.
  useEffect(() => {
    if (!activeTabPath) return;
    const parent = activeTabPath.includes("/")
      ? activeTabPath.slice(0, activeTabPath.lastIndexOf("/"))
      : "";
    if (parent !== path) navigate(parent);
  }, [activeTabPath, path, navigate]);

  const openEntry = (entry: Entry) => {
    if (entry.kind === "dir") navigate(entry.path);
    else openFile(entry.path, entry.name);
  };

  return (
    <aside className="flex h-full flex-col border-l border-border/70 bg-background">
      <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <button
          type="button"
          aria-label="Parent directory"
          disabled={path === ""}
          onClick={() => navigate(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")}
          className="text-muted-foreground hover:text-foreground rounded p-1 disabled:opacity-30"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {path === "" ? "/" : `/${path}`}
        </span>
        <button
          type="button"
          aria-label="Refresh"
          onClick={refresh}
          className="text-muted-foreground hover:text-foreground rounded p-1"
        >
          <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error && (
          <p className={cn("px-2 py-1 text-xs", unavailable ? "text-muted-foreground" : "text-destructive")}>
            {error}
          </p>
        )}
        {!error && listing?.entries.length === 0 && (
          <p className="text-muted-foreground px-2 py-1 text-xs">Empty directory.</p>
        )}
        <ul className="flex flex-col">
          {listing?.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => openEntry(entry)}
                className={cn(
                  "hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm",
                  activeTabPath === entry.path && "bg-muted",
                )}
              >
                {entry.kind === "dir" ? (
                  <Folder className="text-muted-foreground size-4 shrink-0" />
                ) : (
                  <File className="text-muted-foreground size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.size !== undefined && (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {formatSize(entry.size)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
