/**
 * Path handling for the workspace module — the security-critical half.
 *
 * Every path a caller supplies is workspace-relative and POSIX. These helpers
 * reject the shapes that could address something outside the root BEFORE any
 * filesystem access, and the resolution helpers additionally verify containment
 * against `realpath`.
 *
 * The error classes themselves are part of the seam's interface contract and
 * live in `@science-studio/transport`; they are re-exported here so consumers of
 * this package keep a single import path.
 */
import { posix } from "node:path";
import { WorkspaceEscapeError, WorkspacePathError } from "@science-studio/transport";

export {
  FileTooLargeError,
  WorkspaceEscapeError,
  WorkspaceNotFoundError,
  WorkspacePathError,
} from "@science-studio/transport";

/**
 * Normalize a workspace-relative POSIX path, or throw.
 *
 * - absolute paths (`/…`), platform separators (`\`), and NUL are rejected;
 * - `.`/`..` are collapsed by `posix.normalize`, and any result that still
 *   escapes (`..`, `../…`) is rejected.
 *
 * The empty string denotes the workspace root itself.
 */
export function normalizeWorkspacePath(relPath: string): string {
  if (typeof relPath !== "string") throw new WorkspacePathError("path must be a string");
  if (relPath.includes("\0")) throw new WorkspacePathError("path must not contain NUL");
  if (relPath.includes("\\")) throw new WorkspacePathError("path must use POSIX separators");
  if (relPath.startsWith("/")) throw new WorkspacePathError("path must be workspace-relative");

  const normalized = posix.normalize(relPath);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new WorkspaceEscapeError(relPath);
  }
  return normalized === "." ? "" : normalized;
}

/** Normalize the agent-visible root: absolute POSIX, no trailing slash. */
export function normalizeAgentRoot(agentRoot: string): string {
  if (typeof agentRoot !== "string" || agentRoot.length === 0) {
    throw new WorkspacePathError("agentRoot must be a non-empty string");
  }
  const normalized = posix.normalize(agentRoot.startsWith("/") ? agentRoot : `/${agentRoot}`);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}
