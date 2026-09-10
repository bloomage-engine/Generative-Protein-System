"use client";

/**
 * The client half of the workspace file service.
 *
 * One API base (`WorkspaceApiProvider`, default `/api/workspace`), the fetch
 * helpers every consumer shares, a directory-browsing hook, a text-preview hook,
 * and the open-file context that lets a markdown link or a file chip hand a
 * `FileRef` to whatever viewer the app mounts.
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
  useState,
  type FC,
  type PropsWithChildren,
} from "react";
import type { DirListing, Entry, FileStat } from "@science-studio/transport";
import type { FileRef } from "./file-reference.js";

/** Re-exported so apps consume workspace shapes without depending on transport. */
export type { DirListing, Entry, FileStat };

export const DEFAULT_WORKSPACE_API = "/api/workspace";

const WorkspaceApiContext = createContext<string>(DEFAULT_WORKSPACE_API);

/** Provide the workspace API base to the subtree's hooks and components. */
export const WorkspaceApiProvider: FC<PropsWithChildren<{ api: string }>> = ({
  api,
  children,
}) => <WorkspaceApiContext.Provider value={api}>{children}</WorkspaceApiContext.Provider>;

export function useWorkspaceApi(): string {
  return useContext(WorkspaceApiContext);
}

/** Trim trailing slashes so `${api}/entries` is always well-formed. */
function base(api: string): string {
  return api.replace(/\/+$/, "");
}

function sessionParam(threadId: string | null | undefined): string {
  return threadId ? `&session=${encodeURIComponent(threadId)}` : "";
}

/** Fetch a directory listing. Throws on transport/HTTP failure. */
export async function fetchWorkspaceEntries(
  api: string,
  path: string,
  threadId: string | null = null,
): Promise<DirListing> {
  const res = await fetch(
    `${base(api)}/entries?path=${encodeURIComponent(path)}${sessionParam(threadId)}`,
    { headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as DirListing;
}

/** Fetch one entry's metadata. Throws on transport/HTTP failure. */
export async function fetchWorkspaceStat(
  api: string,
  path: string,
  threadId: string | null = null,
): Promise<FileStat> {
  const res = await fetch(
    `${base(api)}/stat?path=${encodeURIComponent(path)}${sessionParam(threadId)}`,
    { headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as FileStat;
}

/** The URL a browser navigates to for a file: inline preview or download. */
export function workspaceFileUrl(
  api: string,
  path: string,
  opts: { download?: boolean; threadId?: string | null } = {},
): string {
  const download = opts.download ? "&download=1" : "";
  return `${base(api)}/file?path=${encodeURIComponent(path)}${sessionParam(opts.threadId)}${download}`;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `workspace request failed: ${res.status}`;
  } catch {
    return `workspace request failed: ${res.status}`;
  }
}

// -- Browsing ----------------------------------------------------------------

export interface WorkspaceBrowser {
  /** Current directory (workspace-relative; "" is the root). */
  path: string;
  listing: DirListing | null;
  isLoading: boolean;
  error: string | null;
  /** Descend into (or up to) a directory. */
  navigate: (path: string) => void;
  /** Re-fetch the current directory. */
  refresh: () => void;
}

/** Directory listing state for one browse session (root by default). */
export function useWorkspaceBrowser(opts: {
  threadId?: string | null;
  initialPath?: string;
} = {}): WorkspaceBrowser {
  const api = useWorkspaceApi();
  const threadId = opts.threadId ?? null;
  const [path, setPath] = useState(opts.initialPath ?? "");
  const [listing, setListing] = useState<DirListing | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetchWorkspaceEntries(api, path, threadId)
      .then((next) => {
        if (!cancelled) setListing(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, path, threadId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { path, listing, isLoading, error, navigate: setPath, refresh };
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
  opts: { threadId?: string | null } = {},
): WorkspaceFilePreview {
  const api = useWorkspaceApi();
  const threadId = opts.threadId ?? null;
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
        const res = await fetch(workspaceFileUrl(api, path, { threadId }), {
          headers: { accept: "*/*" },
        });
        if (!res.ok) throw new Error(await errorText(res));
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
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, path, threadId]);

  return {
    ...state,
    downloadUrl: path
      ? workspaceFileUrl(api, path, { download: true, threadId })
      : "",
  };
}

function looksTextual(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/yaml" ||
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
