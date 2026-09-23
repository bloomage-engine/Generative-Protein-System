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

/**
 * A Project id that is safe to join onto the workspace root as ONE path
 * segment. The claim is client-supplied, so `../..` must never reach `mkdir`,
 * `git init`, `git worktree` or a workspace root as a path segment — and the
 * `records.getProject` gate cannot stop it, because a probe first-use records
 * the claimed id. Project ids are minted as slugs (docs/adr/0006), so this only
 * rejects nonsense.
 *
 * This lives at the bottom of the worktree-path vocabulary because it validates
 * the SAME derived layout `worktreeRelPath` produces, and it is enforced
 * CENTRALLY in `project-scope.ts` (every acquiring route answers 400) plus as a
 * belt-and-braces guard in `composition.localWorkspace`. Routes keep their own
 * call only to avoid ever joining an unvalidated id.
 */
export function isSafeProjectId(id: string): boolean {
  return id !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}
