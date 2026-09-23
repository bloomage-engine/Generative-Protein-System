import type { Id, Session } from "./types.js";

/** The auto-ensured default worktree (its path IS the Project root). */
export const DEFAULT_WORKTREE_ID: Id = "main";
/** The default branch a `main` worktree checks out. */
export const MAIN_BRANCH = "main";

/** The worktree a Session belongs to; a legacy row with none is `main`. */
export function sessionWorktreeId(session: Session): Id {
  return session.worktreeId ?? DEFAULT_WORKTREE_ID;
}
