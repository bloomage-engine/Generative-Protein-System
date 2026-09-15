"use client";

import { useEffect, useState } from "react";
import {
  fetchProjects,
  fetchProjectSessions,
  type Project,
  type Session,
} from "@science-studio/transport-client";
import { StudioHost } from "./host";
import { useStudioStore } from "@/store/studio-store";

const PROJECTS_API = process.env.NEXT_PUBLIC_PROJECTS_URL ?? "/api/projects";

/**
 * Seeds the store's scope (Project/Session), then renders the workbench. Both
 * entry surfaces run through here:
 *
 *  - The session deep-link passes `routeProjectId`/`routeSessionId`; we write
 *    them to the store immediately (so the Host can show its `SessionView`),
 *    then hydrate the Project's sessions for the Projects pane.
 *
 *  - The SPA home passes nothing: on first open we adopt the first Project and
 *    its first Session if any exist, leaving the store alone otherwise. New
 *    Sessions are created via the Projects pane (not auto-created here).
 *
 * Subsequent switches are pure store writes; the Host reacts and re-keys
 * `SessionView`, remounting `useTransport` for the new scope. A mount that ends
 * up with no Session lands on the Projects pane — the conversation pane has
 * nothing to converse with, and that pane is where a Session is created.
 */
export function StudioPage({
  routeProjectId = null,
  routeSessionId = null,
}: {
  routeProjectId?: string | null;
  routeSessionId?: string | null;
}) {
  const api = PROJECTS_API;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const s = () => useStudioStore.getState();

    // Route-scoped deep-link: seed scope synchronously and hydrate the list.
    if (routeProjectId) {
      s().setProjectId(routeProjectId);
      if (routeSessionId) s().setActiveSessionId(routeSessionId);
      else s().setLeftView("project");
      setReady(true);
      void (async () => {
        try {
          const list = await fetchProjectSessions(api, routeProjectId);
          // The route is authoritative for this mount, but only while it still
          // owns the scope — a Project switch from the pane wins.
          if (!cancelled && s().projectId === routeProjectId) s().setSessions(list);
        } catch {
          /* the pane still shows the active Session and reloads on demand */
        }
      })();
      return;
    }

    // SPA home: adopt the first Project; if it has sessions, use the first.
    void (async () => {
      try {
        const projects: Project[] = await fetchProjects(api);
        if (cancelled) return;
        s().setProjects(projects);
        const first = projects[0];
        if (first) s().setProjectId(first.id);
        if (first) {
          const list: Session[] = await fetchProjectSessions(api, first.id);
          if (cancelled) return;
          s().setSessions(list);
          const firstSession = list[0];
          if (firstSession) s().setActiveSessionId(firstSession.id);
          else s().setLeftView("project");
        } else {
          s().setLeftView("project");
        }
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
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
