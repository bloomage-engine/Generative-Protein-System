/**
 * Where the workbench scopes next after the active Project or Session is
 * archived or deleted (docs/adr/0014). Pure, so the decision table is testable
 * without a browser; the caller performs the fetch and the `setScope` commit.
 */
import type { Project, Session } from "@science-studio/transport-client";

/**
 * The Project to open once `removedProjectId` is gone: the first Project still
 * in the active list, else none (the caller then shows the Projects pane).
 */
export function fallbackProject(remaining: Project[]): string | null {
  return remaining[0]?.id ?? null;
}

/**
 * The Session to open inside `projectId` once the active one is gone: the
 * Project's NEWEST remaining Session (Sessions list in creation order), else
 * none (the caller keeps the Project and shows the Projects pane).
 */
export function fallbackSession(projectId: string, remaining: Session[]): string | null {
  return remaining[remaining.length - 1]?.id ?? null;
}
