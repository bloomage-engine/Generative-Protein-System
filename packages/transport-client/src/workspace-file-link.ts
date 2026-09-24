"use client";

/**
 * Inline-code file mentions: turn a backtick-wrapped workspace file path an
 * agent writes (e.g. `` `boltz_input.pdb` ``) into something the markdown skin
 * can render as a link — but ONLY after the workspace confirms the file really
 * exists.
 *
 * The grammar is deliberately conservative. Agents put many things in inline
 * code (`project_update`, `True`, `git status`) and only a token that already
 * resolves through {@link resolveFileReference} AND ends in a letter-leading
 * extension is even a candidate. Existence is then a `GET /api/workspace/stat`
 * check; a path that is a directory, a 404, or a request failure stays plain
 * code. Positive results are cached for the page session (a path that exists
 * keeps existing), while a missing result is only de-duplicated in flight so a
 * file created later in the conversation can still become a link on a rerender.
 */
import { useEffect, useState } from "react";
import { resolveFileReference, type FileRef } from "./file-reference.js";
import { fetchWorkspaceStat, useWorkspaceApi } from "./workspace.js";
import type { ClientScope } from "./scope.js";

/** A trailing file extension, letter-led (`file.pdb`, `plot.svg`, but not `v1.2`). */
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** `scheme:` at the start means an external URL, never a workspace path. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve one inline-code span to a workspace file reference, or `null` when it
 * is not a plausible file path. Single-line, whitespace-free, extension-led;
 * schemes, absolute paths and `@`-mentions are excluded.
 */
export function resolveInlineFileReference(text: string): FileRef | null {
  const raw = text.trim();
  if (raw === "" || /\s/.test(raw)) return null;
  if (SCHEME.test(raw) || raw.startsWith("/") || raw.startsWith("@")) return null;
  const ref = resolveFileReference(raw, {});
  if (!ref) return null;
  return EXTENSION.test(ref.workspacePath) ? ref : null;
}

/** `checking` while the stat is in flight; `exists`/`missing` once it settles. */
export type WorkspaceFileLinkState = "checking" | "exists" | "missing";

/** Files the workspace has confirmed in this page session, keyed by scope+path. */
const exists = new Set<string>();

/** One in-flight stat per scope+path, so repeated mentions share a request. */
const inflight = new Map<string, Promise<boolean>>();

/** Coalesce the token-by-token rerenders of a streaming inline-code span. */
const DEBOUNCE_MS = 150;

function cacheKey(api: string, scope: ClientScope, path: string): string {
  return `${api}\u0000${scope.projectId ?? ""}\u0000${scope.worktreeId ?? ""}\u0000${path}`;
}

function checkExists(api: string, scope: ClientScope, path: string): Promise<boolean> {
  const key = cacheKey(api, scope, path);
  if (exists.has(key)) return Promise.resolve(true);
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = fetchWorkspaceStat(api, path, scope)
    .then((stat) => {
      const isFile = stat.kind === "file";
      if (isFile) exists.add(key);
      return isFile;
    })
    // A 404 / a disabled workspace is "not a file", not an error to surface.
    .catch(() => false)
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/**
 * Whether `path` is a real file in the active (Project, Worktree) workspace.
 * Reads the workspace scope from context, so it must render under
 * `WorkspaceApiProvider`.
 */
export function useWorkspaceFileLink(path: string | null): WorkspaceFileLinkState {
  const { api, scope } = useWorkspaceApi();
  const { projectId, worktreeId } = scope;
  const [state, setState] = useState<WorkspaceFileLinkState>(() => {
    if (!path) return "missing";
    return exists.has(cacheKey(api, { projectId, worktreeId }, path)) ? "exists" : "checking";
  });

  useEffect(() => {
    if (!path) {
      setState("missing");
      return;
    }
    if (exists.has(cacheKey(api, { projectId, worktreeId }, path))) {
      setState("exists");
      return;
    }
    setState("checking");
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkExists(api, { projectId, worktreeId }, path).then((isFile) => {
        if (!cancelled) setState(isFile ? "exists" : "missing");
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, projectId, worktreeId, path]);

  return state;
}
