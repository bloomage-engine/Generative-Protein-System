"use client";

import * as React from "react";
import { ChevronRight, FlaskConical, Loader2, MessagesSquare, Plus } from "lucide-react";
import {
  createProject,
  createSession,
  fetchProjects,
  fetchProjectSessions,
  type Project,
  type Session,
} from "@science-studio/transport-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useStudioStore } from "@/store/studio-store";

const PROJECTS_API = process.env.NEXT_PUBLIC_PROJECTS_URL ?? "/api/projects";

/**
 * The left slot's Project view: every Project, the active one expanded to its
 * Sessions — create and switch both scopes from here.
 *
 * This panel REPLACED the top bar's two pickers, so the lists are no longer
 * behind a dropdown: the install's Projects load on first mount (the store
 * keeps them, so switching the left view back and forth does not refetch), and
 * switching Project loads that Project's Sessions. Picking a Session also
 * brings the conversation back — the two views share one pane, so leaving the
 * panel up would hide the Session just picked.
 */
export function ProjectPanel() {
  const projects = useStudioStore((s) => s.projects);
  const setProjects = useStudioStore((s) => s.setProjects);
  const activeProjectId = useStudioStore((s) => s.projectId);
  const panelProjectId = useStudioStore((s) => s.panelProjectId);
  const sessions = useStudioStore((s) => s.panelSessions);
  const activeSessionId = useStudioStore((s) => s.activeSessionId);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");

  const loadProjects = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setProjects(await fetchProjects(PROJECTS_API));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [setProjects]);

  // List a Project's Sessions for the PANE. Expanding is browsing, not
  // switching: the scope moves only when a Session is double-clicked, so the
  // conversation and the file tree stay where the user left them.
  const loadSessions = React.useCallback(async (projectId: string) => {
    setBusy(true);
    setError(null);
    try {
      const list = await fetchProjectSessions(PROJECTS_API, projectId);
      const store = useStudioStore.getState();
      // A later expansion (or a scope change) owns the pane now.
      if (store.panelProjectId !== projectId) return;
      store.setPanelSessions(list);
      // The ACTIVE Project's list is also what the status bar and the top-bar
      // search read, so a load for it feeds both.
      if (store.projectId === projectId) store.setSessions(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    if (projects === null) void loadProjects();
  }, [projects, loadProjects]);

  // The pane re-lists whatever it is expanded on and has nothing to show for —
  // after an expansion, and after a commit moved it to another Project. This is
  // the ONE owner of that load, so expanding never fetches twice.
  React.useEffect(() => {
    if (!panelProjectId) return;
    if (useStudioStore.getState().panelSessions.length > 0) return;
    void loadSessions(panelProjectId);
  }, [panelProjectId, loadSessions]);

  /** Expand/collapse a Project — the conversation does NOT follow. */
  const toggleProject = (project: Project) => {
    const store = useStudioStore.getState();
    const expanding = store.panelProjectId !== project.id;
    // Collapsing stays here; expanding is listed by the effect above.
    store.setPanelProject(expanding ? project.id : null);
  };

  /** Double-clicking a Session is what commits the scope. */
  const switchSession = (sessionId: string) => {
    const store = useStudioStore.getState();
    if (!store.panelProjectId) return;
    store.setScope({ projectId: store.panelProjectId, sessionId });
    store.setLeftView("thread");
  };

  const addProject = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(PROJECTS_API, trimmed);
      const store = useStudioStore.getState();
      store.setProjects([...(store.projects ?? []), project]);
      store.setScope({ projectId: project.id, sessionId: null });
      store.setSessions([]);
      setName("");
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addSession = async () => {
    // The pane creates into the Project it is expanded on — the one the user is
    // looking at — and then commits to the new Session.
    if (!panelProjectId) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createSession(PROJECTS_API, panelProjectId);
      const store = useStudioStore.getState();
      if (store.panelProjectId !== panelProjectId) return;
      store.setPanelSessions([...store.panelSessions, session]);
      store.setScope({ projectId: panelProjectId, sessionId: session.id });
      store.setLeftView("thread");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const list = projects ?? [];

  return (
    <aside aria-label="Projects and sessions" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[10px] font-medium tracking-wider uppercase">
          Projects
        </span>
        {busy && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New project"
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          <Plus />
        </Button>
      </header>

      {creating && (
        <form
          className="flex items-center gap-1 border-b border-border/70 px-2 py-2"
          onSubmit={addProject}
        >
          <Input
            autoFocus
            className="h-7 text-xs"
            placeholder="Project name…"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" size="sm" className="h-7" disabled={busy || !name.trim()}>
            Create
          </Button>
        </form>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {projects === null && !error && (
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-1 text-xs">
            <Loader2 className="size-3.5 animate-spin" /> Loading projects…
          </div>
        )}
        {error && (
          <div className="px-2 py-1 text-xs">
            <p className="text-destructive">{error}</p>
            <button
              type="button"
              className="text-primary mt-1 underline-offset-2 hover:underline"
              onClick={() =>
                void (projects === null || !panelProjectId
                  ? loadProjects()
                  : loadSessions(panelProjectId))
              }
            >
              Retry
            </button>
          </div>
        )}
        {projects !== null && list.length === 0 && !error && (
          <p className="text-muted-foreground px-2 py-1 text-xs">
            No projects yet — create one above.
          </p>
        )}

        <ul className="flex flex-col gap-0.5">
          {list.map((project) => {
            const active = project.id === activeProjectId;
            const expanded = project.id === panelProjectId;
            return (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => toggleProject(project)}
                  aria-current={active ? "true" : undefined}
                  aria-expanded={expanded}
                  className={cn(
                    "hover:bg-muted flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-sm",
                    active && "bg-muted font-medium",
                  )}
                >
                  <ChevronRight
                    className={cn(
                      "text-muted-foreground size-3.5 shrink-0 transition-transform",
                      expanded && "rotate-90",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                </button>
                {expanded && (
                  <SessionList
                    sessions={sessions}
                    activeSessionId={activeSessionId}
                    busy={busy}
                    onPick={switchSession}
                    onCreate={() => void addSession()}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

/** The expanded Project's Sessions, indented under it, with its "new Session" row. */
function SessionList({
  sessions,
  activeSessionId,
  busy,
  onPick,
  onCreate,
}: {
  sessions: Session[];
  activeSessionId: string | null;
  busy: boolean;
  /** Commit the scope to this Session — bound to the DOUBLE click (see below). */
  onPick: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <ul className="border-border/70 ms-3 mb-1 flex flex-col gap-0.5 border-s ps-1">
      {sessions.map((session) => (
        <li key={session.id}>
          {/*
            A double click opens the Session: a single click only happens on the
            way there, and would otherwise steal the scope while the user is
            still choosing — which is exactly the Project-row bug this mirrors.
            Keyboard activation (Enter/Space) keeps the row operable without a
            pointer, since a button's own click is deliberately inert here.
          */}
          <button
            type="button"
            title="Double-click to open this Session"
            onDoubleClick={() => onPick(session.id)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onPick(session.id);
            }}
            className={cn(
              "hover:bg-muted flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs",
              session.id === activeSessionId && "bg-accent text-accent-foreground",
            )}
          >
            <MessagesSquare className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{session.title ?? session.id}</span>
          </button>
        </li>
      ))}
      {sessions.length === 0 && (
        <li className="text-muted-foreground flex items-center gap-2 px-2 py-1 text-xs">
          {busy ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Loading sessions…
            </>
          ) : (
            "No sessions yet."
          )}
        </li>
      )}
      <li>
        <button
          type="button"
          onClick={onCreate}
          disabled={busy}
          className="hover:bg-muted text-muted-foreground flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs disabled:opacity-50"
        >
          <Plus className="size-3.5 shrink-0" /> New session
        </button>
      </li>
    </ul>
  );
}
