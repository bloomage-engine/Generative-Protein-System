import { posix } from "node:path";
import { DEFAULT_WORKTREE_ID, type Id } from "@science-studio/record";

/** The directory under a Project root that holds linked worktree checkouts. */
export const WORKTREES_DIR = ".worktrees";

/**
 * The workspace-relative path of a worktree under its Project root: the empty
 * string for `main` (the Project root itself), else `.worktrees/<id>`. Derived,
 * never stored (docs/adr/0025).
 */
export function worktreeRelPath(worktreeId: Id): string {
  return worktreeId === DEFAULT_WORKTREE_ID ? "" : posix.join(WORKTREES_DIR, worktreeId);
}
