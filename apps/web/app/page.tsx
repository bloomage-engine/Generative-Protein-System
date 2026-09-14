"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MessageSquarePlusIcon, PlusIcon } from "lucide-react";
import {
  createProject,
  createSession,
  fetchProjects,
  fetchProjectSessions,
  type Project,
  type Session,
} from "@science-studio/transport-client";
import { cn } from "@/lib/utils";

const PROJECTS_API = process.env.NEXT_PUBLIC_PROJECTS_URL ?? "/api/projects";

/**
 * The Project / Session picker — the landing route.
 *
 * A Project owns one workspace and any number of Sessions, and its Sessions
 * share what they produce (docs/adr/0006). The conversation itself lives at
 * `/projects/<projectId>/sessions/<sessionId>`; this page only lists, creates and
 * links, so all identity still comes from the record layer.
 */
export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSessions = useCallback(async (projectId: string) => {
    setSessions(await fetchProjectSessions(PROJECTS_API, projectId));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchProjects(PROJECTS_API);
        if (cancelled) return;
        setProjects(list);
        const first = list[0]?.id ?? null;
        setSelected(first);
        if (first) await loadSessions(first);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  const select = async (projectId: string) => {
    setSelected(projectId);
    setError(null);
    try {
      await loadSessions(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addProject = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(PROJECTS_API, name.trim());
      setName("");
      setProjects((prev) => [...prev, project]);
      await select(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addSession = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createSession(PROJECTS_API, selected);
      await loadSessions(selected);
      window.location.href = `/projects/${encodeURIComponent(selected)}/sessions/${encodeURIComponent(session.id)}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex h-svh max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight">Science Studio</h1>
        <p className="text-muted-foreground text-sm">
          One workspace per project; every session under it shares the files and
          results. Pick a session or start a new one.
        </p>
      </header>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex min-h-0 flex-1 gap-6">
        <section className="flex w-64 shrink-0 flex-col gap-2">
          <h2 className="text-muted-foreground text-xs font-medium uppercase">Projects</h2>
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => void select(project.id)}
                  className={cn(
                    "hover:bg-muted w-full rounded-md px-2 py-1.5 text-start text-sm",
                    selected === project.id && "bg-muted",
                  )}
                >
                  {project.name}
                </button>
              </li>
            ))}
            {projects.length === 0 && (
              <li className="text-muted-foreground px-2 py-1 text-sm">No projects yet.</li>
            )}
          </ul>
          <div className="flex items-center gap-1">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addProject();
              }}
              placeholder="New project name"
              className="border-input min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={() => void addProject()}
              disabled={busy || name.trim() === ""}
              aria-label="Create project"
              className="hover:bg-muted rounded-md p-1.5 disabled:opacity-40"
            >
              <PlusIcon className="size-4" />
            </button>
          </div>
        </section>

        <section className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-muted-foreground text-xs font-medium uppercase">Sessions</h2>
            <button
              type="button"
              onClick={() => void addSession()}
              disabled={busy || !selected}
              className="hover:bg-muted ms-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm disabled:opacity-40"
            >
              <MessageSquarePlusIcon className="size-4" />
              New session
            </button>
          </div>
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {sessions.map((session) => (
              <li key={session.id}>
                <Link
                  href={`/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`}
                  className="hover:bg-muted block rounded-md px-2 py-1.5 text-sm"
                >
                  {session.title ?? session.id}
                </Link>
              </li>
            ))}
            {sessions.length === 0 && (
              <li className="text-muted-foreground px-2 py-1 text-sm">
                No sessions in this project yet.
              </li>
            )}
          </ul>
        </section>
      </div>
    </main>
  );
}
