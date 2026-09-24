"use client";

/**
 * The client half of the workspace file service.
 *
 * One API base (`WorkspaceApiProvider`, default `/api/workspace`) and the Project
 * whose files it browses, the fetch helpers every consumer shares, a
 * directory-browsing hook, a text-preview hook, and the open-file context that
 * lets a markdown link or a file chip hand a `FileRef` to whatever viewer the app
 * mounts.
 *
 * The API base is separate from the transport base: the workspace routes are a
 * different surface (`@science-studio/transport-service`'s `/api/workspace/*`),
 * even though the same service serves both.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FC,
  type PropsWithChildren,
} from "react";
import type { DirListing, Entry, FileStat } from "@science-studio/transport";
import type { FileRef } from "./file-reference.js";
import { scopedUrl, type ClientScope } from "./scope.js";

/** Re-exported so apps consume workspace shapes without depending on transport. */
export type { DirListing, Entry, FileStat };

export const DEFAULT_WORKSPACE_API = "/api/workspace";

/**
 * What a workspace subtree is scoped to: the API base plus the Project whose
 * files should be browsed (`null` → the service's default Project) and the
 * Worktree that selects WHICH checkout of it (docs/adr/0025; `null` → the
 * service's `main`). The scope rides in context so registry components (the
 * composer's `@` picker) and the panel agree without prop-drilling through the
 * app shell.
 */
export interface WorkspaceScope {
  api: string;
  scope: ClientScope;
}

const WorkspaceApiContext = createContext<WorkspaceScope>({
  api: DEFAULT_WORKSPACE_API,
  scope: { projectId: null },
});

/** Provide the workspace API base (and Project/Worktree) to the subtree. */
export const WorkspaceApiProvider: FC<
  PropsWithChildren<{ api: string; project?: string | null; worktree?: string | null }>
> = ({ api, project = null, worktree = null, children }) => {
  const value = useMemo<WorkspaceScope>(
    () => ({ api, scope: { projectId: project, worktreeId: worktree } }),
    [api, project, worktree],
  );
  return <WorkspaceApiContext.Provider value={value}>{children}</WorkspaceApiContext.Provider>;
};

export function useWorkspaceApi(): WorkspaceScope {
  return useContext(WorkspaceApiContext);
}

/** The claim a workspace call defaults to when its caller names no scope. */
const ROOT_SCOPE: ClientScope = { projectId: null };

/**
 * The parent of a workspace-relative directory path: `"a/b"` → `"a"`, `"a"` →
 * `""` (the root). Workspace paths are POSIX-style with no leading slash.
 */
export function workspaceParentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? "" : trimmed.slice(0, slash);
}

/**
 * A workspace request that failed with an HTTP status. The status is kept
 * because it is meaningful: `503` means this deployment exposes NO workspace
 * (the service's `NullWorkspace`), which is a configuration state, not an error
 * the user can act on by retrying.
 */
export class WorkspaceRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRequestError";
  }
}

/** True when the failure means "no workspace is configured on this server". */
export function isWorkspaceUnavailable(err: unknown): boolean {
  return err instanceof WorkspaceRequestError && err.status === 503;
}

/** Friendly copy shown wherever browsing is disabled (never the raw 503 body). */
export const WORKSPACE_UNAVAILABLE_REASON =
  "File browsing is not enabled on this server.";

/** Fetch a directory listing. Throws on transport/HTTP failure. */
export async function fetchWorkspaceEntries(
  api: string,
  path: string,
  scope: ClientScope = ROOT_SCOPE,
): Promise<DirListing> {
  const res = await fetch(scopedUrl(api, "/entries", scope, { path }), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await requestError(res);
  return (await res.json()) as DirListing;
}

/** Fetch one entry's metadata. Throws on transport/HTTP failure. */
export async function fetchWorkspaceStat(
  api: string,
  path: string,
  scope: ClientScope = ROOT_SCOPE,
): Promise<FileStat> {
  const res = await fetch(scopedUrl(api, "/stat", scope, { path }), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await requestError(res);
  return (await res.json()) as FileStat;
}

/** The URL a browser navigates to for a file: inline preview or download. */
export function workspaceFileUrl(
  api: string,
  path: string,
  opts: { download?: boolean; scope?: ClientScope } = {},
): string {
  return scopedUrl(api, "/file", opts.scope ?? ROOT_SCOPE, { path, download: opts.download });
}

/**
 * Upload a file's bytes to `path` (a raw body — the service has no multipart
 * parser, so the file's bytes ARE the request body and the target path rides in
 * the query). Throws a `WorkspaceRequestError` on a non-2xx answer.
 */
export async function uploadWorkspaceFile(
  api: string,
  path: string,
  file: Blob,
  scope: ClientScope = ROOT_SCOPE,
): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const res = await fetch(scopedUrl(api, "/upload", scope, { path }), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!res.ok) throw await requestError(res);
}

/** Remove a file or directory (recursively) at `path`. Throws on failure. */
export async function deleteWorkspaceEntry(
  api: string,
  path: string,
  scope: ClientScope = ROOT_SCOPE,
): Promise<void> {
  const res = await fetch(scopedUrl(api, "/delete", scope, { path }), {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await requestError(res);
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `workspace request failed: ${res.status}`;
  } catch {
    return `workspace request failed: ${res.status}`;
  }
}

/** A status-bearing error for a non-2xx response, ready to `throw`. */
async function requestError(res: Response): Promise<WorkspaceRequestError> {
  return new WorkspaceRequestError(res.status, await errorText(res));
}

// -- Browsing ----------------------------------------------------------------

export interface WorkspaceBrowser {
  /** Current directory (workspace-relative; "" is the root). */
  path: string;
  listing: DirListing | null;
  isLoading: boolean;
  error: string | null;
  /** True when the server exposes no workspace at all (HTTP 503). */
  unavailable: boolean;
  /** Descend into (or up to) a directory. */
  navigate: (path: string) => void;
  /** Re-fetch the current directory. */
  refresh: () => void;
}

/** Directory listing state for one (Project, Worktree) workspace (root by default). */
export function useWorkspaceBrowser(opts: {
  scope?: ClientScope;
  initialPath?: string;
} = {}): WorkspaceBrowser {
  const ctx = useWorkspaceApi();
  const api = ctx.api;
  const scope = opts.scope ?? ctx.scope;
  const { projectId, worktreeId = null } = scope;
  const [path, setPath] = useState(opts.initialPath ?? "");
  const root = useWorkspaceRoot({ scope });
  const [sub, setSub] = useState<{
    listing: DirListing | null;
    isLoading: boolean;
    error: string | null;
    unavailable: boolean;
  }>({ listing: null, isLoading: false, error: null, unavailable: false });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // The ROOT is the one directory several surfaces want at once, so it comes
    // from the shared listing; only deeper paths are per-hook state.
    if (path === "") return;
    let cancelled = false;
    setSub({ listing: null, isLoading: true, error: null, unavailable: false });
    fetchWorkspaceEntries(api, path, { projectId, worktreeId })
      .then((next) => {
        if (!cancelled) setSub({ listing: next, isLoading: false, error: null, unavailable: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A 503 is a deployment state, not a failure to retry: show friendly copy.
        const off = isWorkspaceUnavailable(err);
        setSub({
          listing: null,
          isLoading: false,
          unavailable: off,
          error: off ? WORKSPACE_UNAVAILABLE_REASON : err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api, path, projectId, worktreeId, nonce]);

  const refresh = useCallback(() => {
    if (path === "") root.refresh();
    else setNonce((n) => n + 1);
  }, [path, root]);

  return path === ""
    ? {
        path,
        listing: root.listing,
        isLoading: root.isLoading,
        error: root.error,
        unavailable: root.unavailable,
        navigate: setPath,
        refresh,
      }
    : { path, ...sub, navigate: setPath, refresh };
}

// -- The shared root listing -------------------------------------------------

/**
 * The root directory is what EVERY workspace surface wants: the file tree, the
 * status bar's availability chip and the top-bar search all list it, and each
 * used to fetch it on its own. Three requests (six under dev StrictMode) for one
 * directory is not just waste — they queue behind the browser's ~6 connections
 * per origin, and the tree sat empty for seconds after a Project switch while
 * its duplicates drained.
 *
 * So one listing is kept per (api, Project, Worktree): consumers SHARE the
 * in-flight request, read the last answer immediately (no empty flash on
 * remount) and revalidate in the background. A scope's listing is revalidated
 * when the last consumer of it mounts again; `refresh()` forces one.
 */
interface RootSnapshot {
  listing: DirListing | null;
  isLoading: boolean;
  error: string | null;
  unavailable: boolean;
}

const ROOT_PENDING: RootSnapshot = { listing: null, isLoading: true, error: null, unavailable: false };
const rootSnapshots = new Map<string, RootSnapshot>();
const rootInflight = new Map<string, Promise<void>>();
const rootWatchers = new Map<string, Set<() => void>>();

function rootKey(api: string, project: string | null, worktree: string | null): string {
  return `${api}|${project ?? ""}|${worktree ?? ""}`;
}

function rootWatchersFor(key: string): Set<() => void> {
  let watchers = rootWatchers.get(key);
  if (!watchers) {
    watchers = new Set();
    rootWatchers.set(key, watchers);
  }
  return watchers;
}

function publishRoot(key: string, snapshot: RootSnapshot): void {
  rootSnapshots.set(key, snapshot);
  for (const notify of rootWatchersFor(key)) notify();
}

/** Fetch the root once, unless a request for it is already in flight. */
function loadRoot(api: string, scope: ClientScope): void {
  const project = scope.projectId;
  const worktree = scope.worktreeId ?? null;
  const key = rootKey(api, project, worktree);
  if (rootInflight.has(key)) return;

  const cached = rootSnapshots.get(key);
  publishRoot(key, {
    listing: cached?.listing ?? null,
    isLoading: cached?.listing == null,
    error: null,
    unavailable: false,
  });

  const pending = fetchWorkspaceEntries(api, "", scope)
    .then((listing) => publishRoot(key, { listing, isLoading: false, error: null, unavailable: false }))
    .catch((err: unknown) => {
      const off = isWorkspaceUnavailable(err);
      publishRoot(key, {
        // A failed revalidation keeps the last good listing on screen.
        listing: rootSnapshots.get(key)?.listing ?? null,
        isLoading: false,
        unavailable: off,
        error: off ? WORKSPACE_UNAVAILABLE_REASON : err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => rootInflight.delete(key));
  rootInflight.set(key, pending);
}

export interface WorkspaceRoot {
  listing: DirListing | null;
  isLoading: boolean;
  error: string | null;
  /** True when the server exposes no workspace at all (HTTP 503). */
  unavailable: boolean;
  /** Re-fetch the root now. */
  refresh: () => void;
}

/** The shared root listing of one (Project, Worktree) workspace. */
export function useWorkspaceRoot(opts: { scope?: ClientScope } = {}): WorkspaceRoot {
  const ctx = useWorkspaceApi();
  const api = ctx.api;
  const scope = opts.scope ?? ctx.scope;
  const { projectId, worktreeId = null } = scope;
  const key = rootKey(api, projectId, worktreeId);

  const subscribe = useCallback(
    (onChange: () => void) => {
      const watchers = rootWatchersFor(key);
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
    [key],
  );
  const getSnapshot = useCallback(() => rootSnapshots.get(key) ?? ROOT_PENDING, [key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => ROOT_PENDING);

  useEffect(() => {
    loadRoot(api, { projectId, worktreeId });
  }, [api, projectId, worktreeId]);

  const refresh = useCallback(() => {
    const cached = rootSnapshots.get(key);
    publishRoot(key, { listing: cached?.listing ?? null, isLoading: true, error: null, unavailable: false });
    loadRoot(api, { projectId, worktreeId });
  }, [api, key, projectId, worktreeId]);

  return { ...snapshot, refresh };
}

// -- Availability ------------------------------------------------------------

export interface WorkspaceAvailability {
  /**
   * `true` once the probe lists the root; `false` when the server answers 503
   * (no workspace configured); `null` while probing or on any other failure (the
   * surface exists but is unreachable right now).
   */
  available: boolean | null;
  isLoading: boolean;
  /** Friendly explanation when `available === false`; else null. */
  reason: string | null;
}

/**
 * Probe whether this deployment exposes a workspace, so the UI can hide or
 * disable file affordances instead of letting the user open a panel that only
 * ever shows a 503. The probe is the CHEAPEST workspace call (a root listing) —
 * and the very one the file tree needs, so it reads the shared root listing
 * rather than issuing a second request for the same directory.
 */
export function useWorkspaceAvailability(opts: {
  scope?: ClientScope;
} = {}): WorkspaceAvailability {
  const root = useWorkspaceRoot(opts);
  return {
    available: root.unavailable ? false : root.listing ? true : null,
    isLoading: root.isLoading,
    reason: root.unavailable ? root.error : null,
  };
}

// -- Preview -----------------------------------------------------------------

export interface WorkspaceFilePreview {
  /** Text content when the file is textual and within the inline cap; else null. */
  text: string | null;
  mime: string | null;
  isBinary: boolean;
  isLoading: boolean;
  error: string | null;
  /** URL for a full download (always available). */
  downloadUrl: string;
}

/** Text preview for one file; binaries and over-cap files surface as download. */
export function useWorkspaceFile(
  path: string | null,
  opts: { scope?: ClientScope } = {},
): WorkspaceFilePreview {
  const ctx = useWorkspaceApi();
  const api = ctx.api;
  const scope = opts.scope ?? ctx.scope;
  const { projectId, worktreeId = null } = scope;
  const [state, setState] = useState<Omit<WorkspaceFilePreview, "downloadUrl">>({
    text: null,
    mime: null,
    isBinary: false,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!path) {
      setState({ text: null, mime: null, isBinary: false, isLoading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ text: null, mime: null, isBinary: false, isLoading: true, error: null });

    void (async () => {
      try {
        const res = await fetch(workspaceFileUrl(api, path, { scope: { projectId, worktreeId } }), {
          headers: { accept: "*/*" },
        });
        if (!res.ok) throw await requestError(res);
        const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
        if (!looksTextual(mime)) {
          if (!cancelled) setState({ text: null, mime, isBinary: true, isLoading: false, error: null });
          return;
        }
        const text = await res.text();
        if (!cancelled) setState({ text, mime, isBinary: false, isLoading: false, error: null });
      } catch (err) {
        if (!cancelled) {
          setState({
            text: null,
            mime: null,
            isBinary: false,
            isLoading: false,
            error: isWorkspaceUnavailable(err)
              ? WORKSPACE_UNAVAILABLE_REASON
              : err instanceof Error
                ? err.message
                : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, path, projectId, worktreeId]);

  return {
    ...state,
    downloadUrl: path
      ? workspaceFileUrl(api, path, { download: true, scope: { projectId, worktreeId } })
      : "",
  };
}

function looksTextual(mime: string): boolean {
  // Must admit every mime `mimeFor` (packages/workspace) yields for a text
  // file the preview pane renders — keep the two lists in sync.
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/yaml" ||
    mime === "application/xml" ||
    mime === "application/toml" ||
    mime.endsWith("+json")
  );
}

// -- Open-file plumbing ------------------------------------------------------

export type WorkspaceOpenHandler = (ref: FileRef) => void;

const WorkspaceOpenContext = createContext<WorkspaceOpenHandler | null>(null);

/**
 * Lets the app own the viewer while the shared markdown renderer and file chips
 * only dispatch a `FileRef`. Absent (e.g. in a plain chat embed), references
 * fall back to a normal link.
 */
export const WorkspaceOpenProvider: FC<
  PropsWithChildren<{ onOpen: WorkspaceOpenHandler }>
> = ({ onOpen, children }) => (
  <WorkspaceOpenContext.Provider value={onOpen}>{children}</WorkspaceOpenContext.Provider>
);

export function useWorkspaceOpen(): WorkspaceOpenHandler | null {
  return useContext(WorkspaceOpenContext);
}
