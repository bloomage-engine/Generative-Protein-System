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
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, basename, posix, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type {
  DirListing,
  Entry,
  FileContent,
  FileStat,
  Workspace,
  WriteOptions,
} from "@gps/transport";
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
  /** Path as the AGENT sees the root (e.g. `/home/node/workspace` or `C:/projects/x`). */
  agentRoot: string;
  /** Default inline-read cap when `open` is called without `maxBytes`. */
  maxInlineBytes?: number;
  /** Entry names omitted from `list` results (e.g. `.git`, `.worktrees`). */
  hiddenEntries?: readonly string[];
}

const DEFAULT_MAX_INLINE_BYTES = 8 * 1024 * 1024;

export class FsWorkspace implements Workspace {
  private readonly agentRoot: string;
  private readonly maxInlineBytes: number;
  private readonly hidden: ReadonlySet<string>;

  constructor(
    private readonly root: string,
    options: FsWorkspaceOptions,
  ) {
    this.agentRoot = normalizeAgentRoot(options.agentRoot);
    this.maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
    this.hidden = new Set(options.hiddenEntries ?? []);
  }

  async list(relPath = "", _opts: { depth?: number } = {}): Promise<DirListing> {
    const rel = normalizeWorkspacePath(relPath);
    if (rel === "") await this.ensureRoot();
    const { abs } = await this.resolveExisting(rel);
    const dirents = await readdir(abs, { withFileTypes: true });

    const entries: Entry[] = [];
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue; // v1: symlinks are not exposed
      if (this.hidden.has(dirent.name)) continue;
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

  /**
   * Write a file. The bytes land in a temporary sibling first and are renamed on
   * success, so an over-cap or failed upload never truncates an existing file.
   */
  async write(
    relPath: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
    opts: WriteOptions = {},
  ): Promise<FileStat> {
    const rel = normalizeWorkspacePath(relPath);
    if (rel === "") throw new WorkspacePathError("write requires a file path");

    const rootReal = await this.rootReal();
    const abs = resolve(rootReal, rel);
    await this.prepareParent(abs, rel, opts.createParents ?? true);

    const existing = await lstatOrNull(abs);
    if (existing?.isSymbolicLink()) {
      throw new WorkspaceEscapeError(`symlinks are not allowed (${rel})`);
    }
    if (existing && opts.overwrite === false) {
      throw new WorkspacePathError(`already exists: ${rel}`);
    }

    const temporary = `${abs}.upload-${process.pid}-${Date.now().toString(36)}`;
    try {
      const handle = await open(temporary, "w");
      try {
        let written = 0;
        for await (const chunk of chunksOf(data)) {
          written += chunk.byteLength;
          if (opts.maxBytes !== undefined && written > opts.maxBytes) {
            throw new FileTooLargeError(rel, written, opts.maxBytes);
          }
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }
      await rename(temporary, abs);
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {});
      throw err;
    }
    return this.stat(rel);
  }

  /**
   * Ensure the workspace root directory exists. Called on `list("")` so a
   * Project whose `<PROJECT_ROOT>/<projectId>/` has never been touched —
   * e.g. freshly created via the record layer, agent-side not yet — still
   * yields an EMPTY listing, not a 404. `mkdir -p` is idempotent so a
   * subsequent call is a no-op. Sub-paths are intentionally NOT created here:
   * they remain 404 until a `write` (which does their own `prepareParent`)
   * materializes them.
   */
  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true });
    } catch (err) {
      // If the root can't be created (permissions, read-only fs, invalid
      // parent), surface it as the same WorkspaceNotFoundError that
      // `resolveExisting` would emit, so the caller's error handling stays
      // the single code path.
      throw new WorkspaceNotFoundError("");
    }
  }

  /** realpath the root (it may itself be a symlink, e.g. a macOS tmp dir). */
  private async rootReal(): Promise<string> {
    try {
      return await realpath(this.root);
    } catch {
      throw new WorkspaceNotFoundError("");
    }
  }

  /**
   * Ensure the target's parent exists and stays inside the root. The parent is
   * `realpath`'d AFTER creation, so a symlinked component that escapes is caught
   * even though the file itself does not exist yet.
   */
  private async prepareParent(abs: string, rel: string, create: boolean): Promise<void> {
    const parent = dirname(abs);
    const rootReal = await this.rootReal();
    if (create) {
      try {
        await mkdir(parent, { recursive: true });
      } catch {
        /* a racing creator is fine; the containment check below decides */
      }
    }
    let parentReal: string;
    try {
      parentReal = await realpath(parent);
    } catch {
      throw new WorkspaceNotFoundError(rel);
    }
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
      throw new WorkspaceEscapeError(rel);
    }
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
   * Remove a file or directory (recursively). `resolveExisting` applies the same
   * containment and symlink rules as every other path, so this can never touch
   * anything outside the root or follow a symlink out. A path that disappears
   * between the resolve and the `rm` is a clean 404, not a crash.
   */
  async delete(relPath: string): Promise<void> {
    const rel = normalizeWorkspacePath(relPath);
    if (rel === "") throw new WorkspacePathError("delete requires a file or directory path");
    const { abs } = await this.resolveExisting(rel);
    try {
      await rm(abs, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceNotFoundError(rel);
      throw err;
    }
  }

  /**
   * Move the whole workspace into a sibling `.recycle/` bin (docs/adr/0014):
   * delete is irreversible from the UI, but the bytes stay on disk for manual
   * recovery. A distinct agent root is moved alongside it; a root that does not
   * exist is already gone, so this is a no-op.
   */
  async recycle(): Promise<void> {
    await moveToRecycle(this.root);
    if (this.agentRoot !== this.root) await moveToRecycle(this.agentRoot);
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

/** `lstat` that reports a missing path as null instead of throwing. */
async function lstatOrNull(abs: string): Promise<Stats | null> {
  try {
    return await lstat(abs);
  } catch {
    return null;
  }
}

/**
 * Move `target` into `<parent>/.recycle/<name>-<ts>/`. A missing target is a
 * no-op (there is nothing to remove); the `.recycle` bin is created on demand.
 * Same-parent keeps the rename on one filesystem, which is what makes it a
 * cheap atomic move rather than a copy.
 */
async function moveToRecycle(target: string): Promise<void> {
  if (!(await lstatOrNull(target))) return;
  const bin = join(dirname(target), ".recycle");
  await mkdir(bin, { recursive: true });
  const dest = join(bin, `${basename(target)}-${Date.now().toString(36)}`);
  try {
    await rename(target, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Normalize bytes or a web stream into an async chunk sequence. */
async function* chunksOf(
  data: Uint8Array | ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (data instanceof Uint8Array) {
    if (data.byteLength > 0) yield data;
    return;
  }
  const reader = data.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
