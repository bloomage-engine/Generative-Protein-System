"use client";

import { useEffect, useState } from "react";
import { fetchProjectsOverview, fetchProjectSessions, fetchSettings, fetchWorktrees } from "@science-studio/transport-client";
import { readScopeMemory, resolveProject, resolveSession, resolveWorktree } from "@/lib/scope-memory";
import { SETTINGS_API } from "./settings-dialog";
import { StudioHost } from "./host";
import { useStudioStore } from "@/store/studio-store";

const PROJECTS_API = process.env.NEXT_PUBLIC_PROJECTS_URL ?? "/api/projects";
const WORKTREES_API = process.env.NEXT_PUBLIC_WORKTREES_URL ?? "/api/worktrees";

/**
 * Seeds the store's scope (Project/Session), then renders the workbench. Both
 * entry surfaces run through here:
 *
 *  - The session deep-link passes
 *    `routeProjectId`/`routeWorktreeId`/`routeSessionId`.
 *  - The SPA home passes nothing, and falls back to the scope this browser left
 *    behind (`readScopeMemory` — docs/adr/0009).
 *
 * Either way the scope is a CLAIM until the record answers: the workbench opens
 * the URL's Project when the record lists it, else the remembered one, else the
 * first Project; then the URL's Worktree when that Project's list holds it, else
 * the remembered one, else `main`; then a Session from that `(Project, Worktree)`
 * pair's own list (else its newest). An id the record does not list is never
 * opened, let alone remembered — the
 * transport route MINTS a Project/Session row for an unknown key rather than
 * refusing it, so the probe for a stale id would fabricate the very row it
 * claims to resume (docs/adr/0009).
 *
 * That is also why the scope is resolved BEFORE the shell renders: `useTransport`
 * must never mount on an unvalidated Session, since its mount probe is itself the
 * minting request. A record that does not answer shows the error instead — it
 * proves nothing, so the memory is left exactly as it was.
 *
 * Subsequent switches are store writes (`setScope`, which also moves the memory
 * and the URL); the Host reacts and re-keys `SessionView`, remounting
 * `useTransport` for the new scope. A scope that ends up with no Session lands on
 * the Projects pane — the conversation pane has nothing to converse with, and
 * that pane is where a Session is created.
 */
export function StudioPage({
  routeProjectId = null,
  routeWorktreeId = null,
  routeSessionId = null,
}: {
  routeProjectId?: string | null;
  routeWorktreeId?: string | null;
  routeSessionId?: string | null;
}) {
  const api = PROJECTS_API;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const s = () => useStudioStore.getState();

    // The persisted thread settings (e.g. visibleMessageCount) are applied
    // AFTER the boot scope commit: the commit's "new Session → default window"
    // reset would otherwise wipe a persisted value that arrived first (both are
    // async at mount, and the record round-trip is the slower one — so the
    // persisted value always won the race and was then erased).
    const applyThreadSettings = () => {
      void fetchSettings(SETTINGS_API)
        .then((view) => {
          if (cancelled) return;
          const count = view.thread?.visibleMessageCount;
          if (count !== undefined && count > 0) {
            useStudioStore.setState({ visibleMessageCount: count });
          }
        })
        .catch(() => {});
    };

    void (async () => {
      try {
        const { projects, defaultProjectId } = await fetchProjectsOverview(api);
        if (cancelled) return;
        s().setProjects(projects);
        s().setDefaultProjectId(defaultProjectId);

        const project = resolveProject({
          claimedProjectId: routeProjectId,
          claimedSessionId: routeSessionId,
          memory: readScopeMemory(),
          projects,
        });

        if (!project.projectId) {
          // A fresh install: the Projects pane is where the first one is created.
          s().setScope({ projectId: null, worktreeId: null, sessionId: null }, project.memory);
          s().setLeftView("project");
          applyThreadSettings();
          setReady(true);
          return;
        }

        // Resolve the Worktree against the Project's OWN list (docs/adr/0025):
        // the URL's claim wins when the record lists it, else the Project's
        // remembered worktree, else `main`. A claim the record does not list is
        // never opened — the transport route would fabricate it — and
        // `resolveWorktree` returns a memory whose `lastWorktreeId` is the
        // resolved one, so a deleted worktree is pruned as it falls back.
        const worktrees = await fetchWorktrees(WORKTREES_API, project.projectId);
        if (cancelled) return;
        const resolved = resolveWorktree({
          projectId: project.projectId,
          claimedWorktreeId: routeWorktreeId,
          memory: project.memory,
          worktrees,
        });

        const sessions = await fetchProjectSessions(api, project.projectId, {
          worktreeId: resolved.worktreeId,
        });
        if (cancelled) return;

        const session = resolveSession({
          projectId: project.projectId,
          worktreeId: resolved.worktreeId,
          hint: project.sessionHint,
          sessions,
          memory: resolved.memory,
        });
        s().setScope(
          {
            projectId: project.projectId,
            worktreeId: resolved.worktreeId,
            sessionId: session.sessionId,
          },
          session.memory,
        );
        // After the commit: `setScope` resets `worktrees` to null on a Project
        // switch, so the freshly-listed ones land here; `setSessions` is what
        // the pane shows while it is expanded on the active Project.
        s().setWorktrees(worktrees);
        s().setSessions(sessions);
        if (!session.sessionId) s().setLeftView("project");
        applyThreadSettings();
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        // The record did not answer: the remembered scope is not disproven.
        setError(err instanceof Error ? err.message : String(err));
        applyThreadSettings();
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) {
    return (
      <div className="flex h-svh items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-svh items-center justify-center p-8 text-xs text-destructive">
        {error}
      </div>
    );
  }

  return <StudioHost />;
}
