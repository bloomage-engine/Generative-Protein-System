/**
 * `FsWorkspace` — the filesystem implementation of the `Workspace` seam.
 *
 * Security core (interface invariants):
 * - every path is workspace-relative and normalized by `normalizeWorkspacePath`;
 * - resolution `realpath`s the root AND the target, and the target must stay
 *   under the root, so a symlink pointing out can never be read;
 * - a symlink target is rejected outright (v1 policy) and symlink entries are
 *   omitted from listings;
 * - `open` enforces a byte cap — larger files are a streaming download.
 *
 * Read-only in v1 (`write` arrives with the upload path).
 */
import { createReadStream, type Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { DirListing, Entry, FileContent, FileStat, Workspace } from "@science-studio/transport";
import { mimeFor } from "./mime.js";
import {
  FileTooLargeError,
  WorkspaceEscapeError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  normalizeAgentRoot,
  normalizeWorkspacePath,
} from "./paths.js";

export interface FsWorkspaceOptions {
  /** Path as the AGENT sees the root (e.g. `/home/node/.openclaw/workspace`). */
  agentRoot: string;
  /** Default inline-read cap when `open` is called without `maxBytes`. */
  maxInlineBytes?: number;
}

const DEFAULT_MAX_INLINE_BYTES = 8 * 1024 * 1024;

export class FsWorkspace implements Workspace {
  private readonly agentRoot: string;
  private readonly maxInlineBytes: number;

  constructor(
    private readonly root: string,
    options: FsWorkspaceOptions,
  ) {
    this.agentRoot = normalizeAgentRoot(options.agentRoot);
    this.maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  }

  async list(relPath = "", _opts: { depth?: number } = {}): Promise<DirListing> {
    const rel = normalizeWorkspacePath(relPath);
    const { abs } = await this.resolveExisting(rel);
    const dirents = await readdir(abs, { withFileTypes: true });

    const entries: Entry[] = [];
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue; // v1: symlinks are not exposed
      const childRel = rel === "" ? dirent.name : posix.join(rel, dirent.name);
      const stats = await lstat(join(abs, dirent.name));
      const isDir = stats.isDirectory();
      entries.push({
        path: childRel,
        name: dirent.name,
        kind: isDir ? "dir" : "file",
        ...(isDir ? {} : { size: stats.size, mime: mimeFor(dirent.name) }),
      });
    }
    entries.sort(compareEntries);

    return { path: rel, entries };
  }

  async stat(relPath: string): Promise<FileStat> {
    const rel = normalizeWorkspacePath(relPath);
    if (rel === "") throw new WorkspacePathError("stat requires a file or directory path");
    const { abs, st } = await this.resolveExisting(rel);
    const isDir = st.isDirectory();
    return {
      path: rel,
      name: posix.basename(rel),
      kind: isDir ? "dir" : "file",
      ...(isDir ? {} : { size: (await lstat(abs)).size, mime: mimeFor(rel) }),
      modifiedAt: st.mtime.toISOString(),
    };
  }

  async open(relPath: string, opts: { maxBytes?: number } = {}): Promise<FileContent> {
    const rel = normalizeWorkspacePath(relPath);
    if (rel === "") throw new WorkspacePathError("open requires a file path");
    const { abs, st } = await this.resolveExisting(rel);
    if (st.isDirectory()) throw new WorkspacePathError(`not a file: ${rel}`);

    const cap = opts.maxBytes ?? this.maxInlineBytes;
    if (st.size > cap) throw new FileTooLargeError(rel, st.size, cap);

    const body = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream<Uint8Array>;
    return { body, size: st.size, mime: mimeFor(rel) };
  }

  toAgentPath(relPath: string): string {
    const rel = normalizeWorkspacePath(relPath);
    return rel === "" ? this.agentRoot : posix.join(this.agentRoot, rel);
  }

  toWorkspacePath(agentPath: string): string | null {
    if (typeof agentPath !== "string" || agentPath.length === 0) return null;
    if (agentPath === this.agentRoot) return "";
    if (!agentPath.startsWith(`${this.agentRoot}/`)) return null;
    try {
      return normalizeWorkspacePath(agentPath.slice(this.agentRoot.length + 1));
    } catch {
      return null;
    }
  }

  /**
   * Resolve a workspace path to the real filesystem location, enforcing
   * containment. Both the root and the target are `realpath`'d (the root matters
   * on platforms where the temp/state dir is itself a symlink), and a symlink
   * target is refused.
   */
  private async resolveExisting(rel: string): Promise<{ abs: string; st: Stats }> {
    let rootReal: string;
    try {
      rootReal = await realpath(this.root);
    } catch {
      throw new WorkspaceNotFoundError(rel);
    }

    const abs = rel === "" ? rootReal : resolve(rootReal, rel);
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch {
      throw new WorkspaceNotFoundError(rel);
    }
    if (st.isSymbolicLink()) throw new WorkspaceEscapeError(`symlinks are not allowed (${rel})`);

    const targetReal = await realpath(abs);
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
      throw new WorkspaceEscapeError(rel);
    }
    return { abs, st };
  }
}

/** Directories first, then case-insensitive alphabetical, ties by code unit. */
function compareEntries(a: Entry, b: Entry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  const al = a.name.toLowerCase();
  const bl = b.name.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
