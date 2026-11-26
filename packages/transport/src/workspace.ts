/**
 * The workspace seam: the ONLY way anything reads a session's files.
 *
 * This is a seam *interface* — it lives in the seam package (`transport`) so all
 * implementations (local filesystem, a fleet cell's bind-mount, a gateway-proxied
 * filesystem) depend on `transport`, never the reverse. Implementations live in
 * `@gps/workspace`.
 *
 * Interface invariants (part of the interface, NOT implementation detail):
 *
 * - `relPath` is always workspace-relative and POSIX. Absolute paths, `..`
 *   segments, NUL bytes and platform separators are rejected before any
 *   filesystem access.
 * - Resolution `realpath`s BOTH the root and the target; the target must stay
 *   under the root. v1 rejects symlinks entirely.
 * - `open` enforces a byte cap; larger files are a streaming download.
 * - v1 is read-only; `write` arrives with the upload path.
 */
import type { Id } from "@gps/record";

/** One directory entry, addressed by its workspace-relative path. */
export interface Entry {
  /** Workspace-relative, POSIX-style (never absolute, never `..`). */
  path: string;
  name: string;
  kind: "file" | "dir";
  size?: number;
  mime?: string;
}

export interface DirListing {
  path: string;
  entries: Entry[];
}

export interface FileStat extends Entry {
  modifiedAt?: string;
}

export interface FileContent {
  /** Streamed; callers never hold a whole large file in memory. */
  body: ReadableStream<Uint8Array>;
  size: number;
  mime: string;
}

export interface Workspace {
  list(relPath: string, opts?: { depth?: number }): Promise<DirListing>;
  stat(relPath: string): Promise<FileStat>;
  open(relPath: string, opts?: { maxBytes?: number }): Promise<FileContent>;
  /**
   * Write a file from bytes or a stream (uploads). Implementations write to a
   * temporary sibling and rename, so a failed or over-cap upload never truncates
   * an existing file. v1 uploads go through this.
   */
  write(
    relPath: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
    opts?: WriteOptions,
  ): Promise<FileStat>;

  /** Browser/workspace path -> the path the AGENT sees (adapter-specific root). */
  toAgentPath(relPath: string): string;
  /** Agent-emitted path -> workspace-relative path, or null if outside. */
  toWorkspacePath(agentPath: string): string | null;

  /**
   * Remove a file or directory (recursively) under the workspace root. The
   * bytes are destroyed — the product offers no restore. Enforces the same
   * containment and symlink rules as every other path. Optional: a read-only
   * or `NullWorkspace` deployment omits it and the delete route answers 501.
   */
  delete?(relPath: string): Promise<void>;

  /**
   * Move the whole workspace out of the way when its Project is deleted
   * (docs/adr/0014). The bytes are NOT destroyed — an implementation moves them
   * to a recycle bin (a sibling `.recycle/` for `FsWorkspace`) so they remain
   * recoverable by hand, but the product offers no restore. Optional: a
   * deployment with no filesystem surface omits it, and the delete is then a
   * no-op for files. Returns once the move has settled.
   */
  recycle?(): Promise<void>;
}

/** Options for `Workspace.write`. */
export interface WriteOptions {
  /** Max bytes accepted; a longer stream is refused (`FileTooLargeError`). */
  maxBytes?: number;
  /** Create missing parent directories. @default true */
  createParents?: boolean;
  /** Replace an existing file. @default true */
  overwrite?: boolean;
}

/** Configurable workspace limits (§5). */
export interface WorkspaceLimits {
  /** Max bytes a single upload may carry. */
  maxUploadBytes?: number;
  /** Total bytes a principal/tenant may store. */
  quotaBytes?: number;
}

export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_QUOTA_BYTES = 2 * 1024 ** 3; // 2 GB

/** Thrown by workspace implementations when no workspace is configured/enabled. */
export class WorkspaceUnavailableError extends Error {
  constructor(relPath: string) {
    super(`workspace is not available (requested ${relPath})`);
    this.name = "WorkspaceUnavailableError";
  }
}

/**
 * The caller supplied a malformed path: absolute, non-POSIX, or NUL-bearing.
 * Part of the interface's error contract, so it lives with the seam.
 */
export class WorkspacePathError extends Error {
  constructor(readonly detail: string) {
    super(`invalid workspace path: ${detail}`);
    this.name = "WorkspacePathError";
  }
}

/**
 * The path escapes the workspace root (traversal, or a symlink pointing out).
 * A kind of `WorkspacePathError`, so callers can catch the base for a 400 while
 * still distinguishing escape attempts when they care.
 */
export class WorkspaceEscapeError extends WorkspacePathError {
  constructor(detail: string) {
    super(detail);
    this.name = "WorkspaceEscapeError";
    this.message = `path escapes the workspace: ${detail}`;
  }
}

/** The path does not exist under the root. */
export class WorkspaceNotFoundError extends Error {
  constructor(relPath: string) {
    super(`not found in workspace: ${relPath}`);
    this.name = "WorkspaceNotFoundError";
  }
}

/** The file exceeds the caller's inline-read cap; stream it as a download instead. */
export class FileTooLargeError extends Error {
  constructor(
    readonly relPath: string,
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`file ${relPath} is ${size} bytes, over the ${maxBytes}-byte inline cap`);
    this.name = "FileTooLargeError";
  }
}

/**
 * A workspace that exposes nothing. Used until the file service lands (Phase 1)
 * and by deployments with no filesystem surface. Path mapping is identity so an
 * attachment reference still renders; IO is refused loudly rather than
 * pretending to return empty content.
 */
export class NullWorkspace implements Workspace {
  async list(relPath: string): Promise<DirListing> {
    throw new WorkspaceUnavailableError(relPath);
  }

  async stat(relPath: string): Promise<FileStat> {
    throw new WorkspaceUnavailableError(relPath);
  }

  async open(relPath: string): Promise<FileContent> {
    throw new WorkspaceUnavailableError(relPath);
  }

  async write(relPath: string): Promise<FileStat> {
    throw new WorkspaceUnavailableError(relPath);
  }

  async delete(relPath: string): Promise<void> {
    throw new WorkspaceUnavailableError(relPath);
  }

  toAgentPath(relPath: string): string {
    return relPath;
  }

  toWorkspacePath(): string | null {
    return null;
  }
}

/** Reserved seam for upload quota accounting; a no-op single-user default. */
export interface QuotaPolicy {
  /** Throws when `additionalBytes` would exceed the principal's quota. */
  check(principal: import("./principal.js").Principal, additionalBytes: number): Promise<void>;
}

/** A quota policy that never rejects. */
export class NoopQuotaPolicy implements QuotaPolicy {
  async check(): Promise<void> {
    /* single-user: no accounting */
  }
}
