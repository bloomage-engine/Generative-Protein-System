"use client";

import { useEffect, type FC } from "react";
import {
  useWorkspaceApi,
  useWorkspaceBrowser,
  useWorkspaceFile,
  type ClientScope,
  type Entry,
} from "@gps/transport-client";
import {
  ChevronLeftIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  Loader2Icon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface WorkspacePanelProps {
  /** The Project whose workspace this panel browses. */
  project?: string | null;
  /** Controlled selection, so an agent file-link click can open the viewer. */
  selected: string | null;
  onSelect: (path: string | null) => void;
  /** Present when the panel is dismissible. */
  onClose?: () => void;
}

/**
 * The Project workspace browser + viewer.
 *
 * Browsing is one level at a time (`useWorkspaceBrowser`); selecting a file
 * opens a text preview (`useWorkspaceFile`) with a download escape hatch for
 * binaries and over-cap files. v1 shows text inline only — no binary preview.
 */
export const WorkspacePanel: FC<WorkspacePanelProps> = ({
  project = null,
  selected,
  onSelect,
  onClose,
}) => {
  const ctx = useWorkspaceApi();
  const scope: ClientScope = {
    projectId: project ?? ctx.scope.projectId,
    worktreeId: ctx.scope.worktreeId,
  };
  const { path: dir, listing, isLoading, error, unavailable, navigate, refresh } =
    useWorkspaceBrowser({ scope });

  // An externally selected file (an agent link) reveals its directory.
  useEffect(() => {
    if (!selected) return;
    const parent = selected.includes("/") ? selected.slice(0, selected.lastIndexOf("/")) : "";
    if (parent !== dir) navigate(parent);
  }, [selected, dir, navigate]);

  const openEntry = (entry: Entry) => {
    if (entry.kind === "dir") {
      navigate(entry.path);
      onSelect(null);
    } else {
      onSelect(entry.path);
    }
  };

  return (
    <aside className="flex h-full w-96 shrink-0 flex-col border-l border-border/70 bg-background">
      <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <button
          type="button"
          aria-label="Parent directory"
          disabled={dir === ""}
          onClick={() => {
            navigate(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "");
            onSelect(null);
          }}
          className="text-muted-foreground hover:text-foreground rounded p-1 disabled:opacity-30"
        >
          <ChevronLeftIcon className="size-4" />
        </button>
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {dir === "" ? "/" : `/${dir}`}
        </span>
        <button
          type="button"
          aria-label="Refresh"
          onClick={refresh}
          className="text-muted-foreground hover:text-foreground rounded p-1"
        >
          <RefreshCwIcon className={cn("size-4", isLoading && "animate-spin")} />
        </button>
        {onClose && (
          <button
            type="button"
            aria-label="Close workspace"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground rounded p-1"
          >
            <XIcon className="size-4" />
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error && (
          <p
            className={cn(
              "px-2 py-1 text-xs",
              unavailable ? "text-muted-foreground" : "text-destructive",
            )}
          >
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
                  selected === entry.path && "bg-muted",
                )}
              >
                {entry.kind === "dir" ? (
                  <FolderIcon className="text-muted-foreground size-4 shrink-0" />
                ) : (
                  <FileIcon className="text-muted-foreground size-4 shrink-0" />
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

      {selected && (
        <FilePreview path={selected} scope={scope} onClose={() => onSelect(null)} />
      )}
    </aside>
  );
};

const FilePreview: FC<{
  path: string;
  scope: ClientScope;
  onClose: () => void;
}> = ({ path, scope, onClose }) => {
  const { text, mime, isBinary, isLoading, error, downloadUrl } = useWorkspaceFile(path, {
    scope,
  });
  const name = path.slice(path.lastIndexOf("/") + 1);

  return (
    <section className="flex h-1/2 min-h-0 flex-col border-t border-border/70">
      <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={path}>
          {name}
        </span>
        <a
          href={downloadUrl}
          aria-label="Download"
          className="text-muted-foreground hover:text-foreground rounded p-1"
        >
          <DownloadIcon className="size-4" />
        </a>
        <button
          type="button"
          aria-label="Close preview"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground rounded p-1"
        >
          <XIcon className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {isLoading && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
        {error && <p className="text-destructive text-xs">{error}</p>}
        {!isLoading && !error && isBinary && (
          <p className="text-muted-foreground text-xs">
            {mime ?? "Binary file"} — preview is not available in v1. Use download.
          </p>
        )}
        {text !== null && (
          <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {text}
          </pre>
        )}
      </div>
    </section>
  );
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
