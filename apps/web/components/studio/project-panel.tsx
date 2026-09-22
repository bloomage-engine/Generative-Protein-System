"use client";

import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  archiveProject,
  archiveSession,
  createProject,
  createSession,
  DEFAULT_HPC_API,
  deleteProject,
  deleteSession,
  fetchProjectsOverview,
  fetchProjectSessions,
  isOpenComputeJobState,
  listHpcJobs,
  renameProject,
  renameSession,
  unarchiveProject,
  unarchiveSession,
  type Project,
  type Session,
} from "@science-studio/transport-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fallbackProject, fallbackSession } from "@/lib/scope-fallback";
import { useStudioStore } from "@/store/studio-store";

const PROJECTS_API = process.env.NEXT_PUBLIC_PROJECTS_URL ?? "/api/projects";

/**
 * The inline rename target (a Project's `name` or a Session's `title`).
 * `projectId` is present for a Session — the path needs both halves.
 */
type Renaming =
  | { kind: "project"; id: string; value: string }
  | { kind: "session"; projectId: string; id: string; value: string }
  | null;

/** The delete-confirmation target. */
type Deleting =
  | { kind: "project"; id: string; name: string }
  | { kind: "session"; projectId: string; id: string; name: string }
  | null;

/**
 * The left slot's Project view: every Project, the active one expanded to its
 * Sessions — create, switch, rename, archive and delete both scopes from here.
 *
 * Archiving is reversible and lives behind the header's archive toggle; deleting
 * is not (docs/adr/0014). The bootstrap Project (`defaultProjectId`) is
 * immutable, so its row carries no menu at all. Archiving or deleting the ACTIVE
 * scope re-resolves the workbench through `setScope`, the one path the store,
 * the remembered scope and the URL move along (docs/adr/0009).
 */
export function ProjectPanel() {
  const projects = useStudioStore((s) => s.projects);
  const defaultProjectId = useStudioStore((s) => s.defaultProjectId);
  const activeProjectId = useStudioStore((s) => s.projectId);
  const panelProjectId = useStudioStore((s) => s.panelProjectId);
  const sessions = useStudioStore((s) => s.panelSessions);
  const activeSessionId = useStudioStore((s) => s.activeSessionId);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [renaming, setRenaming] = React.useState<Renaming>(null);
  const [deleting, setDeleting] = React.useState<Deleting>(null);
  // The delete dialog counts the Project's non-terminal Compute Jobs so it can
  // warn that deleting does NOT stop them (docs/adr/0024). A failed count is
  // silence, not an error — the delete must not wedge on the HPC hop.
  const [openJobCount, setOpenJobCount] = React.useState(0);

  React.useEffect(() => {
    if (deleting?.kind !== "project") {
      setOpenJobCount(0);
      return;
    }
    let active = true;
    const controller = new AbortController();
    listHpcJobs(DEFAULT_HPC_API, deleting.id, controller.signal)
      .then((jobs) => {
        if (active) setOpenJobCount(jobs.filter((job) => isOpenComputeJobState(job.state)).length);
      })
      .catch(() => {
        if (active) setOpenJobCount(0);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [deleting]);

  const [archiveView, setArchiveView] = React.useState(false);
  const [archiveProjects, setArchiveProjects] = React.useState<Project[] | null>(null);
  const [archiveActive, setArchiveActive] = React.useState<Project[]>([]);
  const [archiveSessions, setArchiveSessions] = React.useState<Record<string, Session[]>>({});
  const [expandedArchive, setExpandedArchive] = React.useState<Set<string>>(new Set());

  // `submitRename` runs from both Enter and blur; the ref lets `cancelRename`
  // (Escape) make the later blur a no-op without a second state read.
  const renamingRef = React.useRef<Renaming>(null);
  renamingRef.current = renaming;

  const loadProjects = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { projects, defaultProjectId } = await fetchProjectsOverview(PROJECTS_API);
      const store = useStudioStore.getState();
      store.setProjects(projects);
      store.setDefaultProjectId(defaultProjectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // List a Project's Sessions for the PANE. Expanding is browsing, not
  // switching: the scope moves only when a Session is double-clicked.
  const loadSessions = React.useCallback(async (projectId: string) => {
    setBusy(true);
    setError(null);
    try {
      const list = await fetchProjectSessions(PROJECTS_API, projectId);
      const store = useStudioStore.getState();
      if (store.panelProjectId !== projectId) return;
      store.setPanelSessions(list);
      if (store.projectId === projectId) store.setSessions(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Refresh a Project's active Sessions wherever it is currently shown. */
  const refreshSessions = React.useCallback(async (projectId: string) => {
    try {
      const list = await fetchProjectSessions(PROJECTS_API, projectId);
      const store = useStudioStore.getState();
      if (store.panelProjectId === projectId) store.setPanelSessions(list);
      if (store.projectId === projectId) store.setSessions(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadArchive = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { projects } = await fetchProjectsOverview(PROJECTS_API, { includeArchived: true });
      setArchiveProjects(projects.filter((p) => p.archivedAt !== undefined));
      setArchiveActive(projects.filter((p) => p.archivedAt === undefined));
      setArchiveSessions({});
      setExpandedArchive(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    if (projects === null) void loadProjects();
  }, [projects, loadProjects]);

  // The pane re-lists whatever it is expanded on and has nothing to show for.
  React.useEffect(() => {
    if (!panelProjectId) return;
    if (useStudioStore.getState().panelSessions.length > 0) return;
    void loadSessions(panelProjectId);
  }, [panelProjectId, loadSessions]);

  /** Expand/collapse a Project — the conversation does NOT follow. */
  const toggleProject = (project: Project) => {
    const store = useStudioStore.getState();
    const expanding = store.panelProjectId !== project.id;
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
      store.upsertProject(project);
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

  const startProjectRename = (project: Project) =>
    setRenaming({ kind: "project", id: project.id, value: project.name });
  const startSessionRename = (session: Session) =>
    setRenaming({ kind: "session", projectId: session.projectId, id: session.id, value: session.title ?? "" });
  const cancelRename = () => {
    renamingRef.current = null;
    setRenaming(null);
  };

  const submitRename = async () => {
    const current = renamingRef.current;
    if (!current) return;
    renamingRef.current = null;
    setRenaming(null);
    const value = current.value.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      if (current.kind === "project") {
        useStudioStore.getState().upsertProject(await renameProject(PROJECTS_API, current.id, value));
      } else {
        const updated = await renameSession(PROJECTS_API, current.projectId, current.id, value);
        useStudioStore.getState().upsertSession(updated);
        setArchiveSessions((map) =>
          map[current.projectId]
            ? {
                ...map,
                [current.projectId]: map[current.projectId]!.map((s) => (s.id === updated.id ? updated : s)),
              }
            : map,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Reopen a Project/Session (or land on the Projects pane) after the active one goes. */
  const commitProjectFallback = React.useCallback(async (remaining: Project[]) => {
    const nextId = fallbackProject(remaining);
    const store = useStudioStore.getState();
    if (!nextId) {
      store.setScope({ projectId: null, sessionId: null });
      store.setLeftView("project");
      return;
    }
    try {
      const list = await fetchProjectSessions(PROJECTS_API, nextId);
      const s = useStudioStore.getState();
      s.setScope({ projectId: nextId, sessionId: fallbackSession(nextId, list) });
      s.setSessions(list);
      if (list.length === 0) s.setLeftView("project");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const commitSessionFallback = (projectId: string, remaining: Session[]) => {
    const store = useStudioStore.getState();
    const nextId = fallbackSession(projectId, remaining);
    store.setScope({ projectId, sessionId: nextId });
    if (!nextId) store.setLeftView("project");
  };

  const doArchiveProject = async (project: Project) => {
    setBusy(true);
    setError(null);
    try {
      await archiveProject(PROJECTS_API, project.id);
      const store = useStudioStore.getState();
      const wasActive = store.projectId === project.id;
      store.removeProject(project.id);
      if (wasActive) await commitProjectFallback(useStudioStore.getState().projects ?? []);
      if (archiveView) await loadArchive();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDeleteProject = async (projectId: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteProject(PROJECTS_API, projectId);
      const store = useStudioStore.getState();
      const wasActive = store.projectId === projectId;
      store.removeProject(projectId);
      if (wasActive) await commitProjectFallback(useStudioStore.getState().projects ?? []);
      if (archiveView) await loadArchive();
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doArchiveSession = async (session: Session) => {
    setBusy(true);
    setError(null);
    try {
      await archiveSession(PROJECTS_API, session.projectId, session.id);
      const store = useStudioStore.getState();
      const wasActive = store.activeSessionId === session.id;
      store.removeSession(session.id);
      if (wasActive) commitSessionFallback(session.projectId, useStudioStore.getState().sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDeleteSession = async (session: { projectId: string; id: string }) => {
    setBusy(true);
    setError(null);
    try {
      await deleteSession(PROJECTS_API, session.projectId, session.id);
      const store = useStudioStore.getState();
      const wasActive = store.activeSessionId === session.id;
      store.removeSession(session.id);
      // The archive view holds its own list; drop the row there too.
      setArchiveSessions((map) =>
        map[session.projectId]
          ? { ...map, [session.projectId]: map[session.projectId]!.filter((s) => s.id !== session.id) }
          : map,
      );
      if (wasActive) commitSessionFallback(session.projectId, useStudioStore.getState().sessions);
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRestoreProject = async (project: Project) => {
    setBusy(true);
    setError(null);
    try {
      useStudioStore.getState().upsertProject(await unarchiveProject(PROJECTS_API, project.id));
      setArchiveProjects((prev) => (prev ?? []).filter((p) => p.id !== project.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRestoreSession = async (session: Session) => {
    setBusy(true);
    setError(null);
    try {
      await unarchiveSession(PROJECTS_API, session.projectId, session.id);
      setArchiveSessions((map) => ({
        ...map,
        [session.projectId]: (map[session.projectId] ?? []).filter((s) => s.id !== session.id),
      }));
      await refreshSessions(session.projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleArchiveProject = (projectId: string) => {
    setExpandedArchive((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    if (archiveSessions[projectId]) return;
    void (async () => {
      setBusy(true);
      try {
        const list = await fetchProjectSessions(PROJECTS_API, projectId, { includeArchived: true });
        setArchiveSessions((map) => ({ ...map, [projectId]: list }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  const openArchive = () => {
    setArchiveView(true);
    // Always re-list on open: archiving happens in the OTHER view, so a cached
    // list would be stale (the bug this replaces).
    void loadArchive();
  };
  const closeArchive = () => setArchiveView(false);

  const confirmDelete = async () => {
    const target = deleting;
    if (!target) return;
    if (target.kind === "project") await doDeleteProject(target.id);
    else await doDeleteSession(target);
  };

  const list = projects ?? [];

  return (
    <aside aria-label="Projects and sessions" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[10px] font-medium tracking-wider uppercase">
          {archiveView ? "Archive" : "Projects"}
        </span>
        {busy && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
        {archiveView ? (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={closeArchive}>
            返回
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="icon-xs" aria-label="Archive" onClick={openArchive}>
              <Archive />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="New project"
              aria-expanded={creating}
              onClick={() => setCreating((open) => !open)}
            >
              <Plus />
            </Button>
          </>
        )}
      </header>

      {creating && !archiveView && (
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
        {error && (
          <div className="px-2 py-1 text-xs">
            <p className="text-destructive">{error}</p>
            <button
              type="button"
              className="text-primary mt-1 underline-offset-2 hover:underline"
              onClick={() => void (archiveView ? loadArchive() : loadProjects())}
            >
              Retry
            </button>
          </div>
        )}

        {archiveView ? (
          <ArchiveList
            archived={archiveProjects}
            active={archiveActive}
            sessionsFor={(id) => archiveSessions[id] ?? null}
            expanded={expandedArchive}
            busy={busy}
            onToggle={toggleArchiveProject}
            onRestoreProject={doRestoreProject}
            onRestoreSession={doRestoreSession}
            onDeleteProject={(project) =>
              setDeleting({ kind: "project", id: project.id, name: project.name })
            }
            onDeleteSession={(session) =>
              setDeleting({
                kind: "session",
                projectId: session.projectId,
                id: session.id,
                name: session.title ?? session.id,
              })
            }
            onStartRename={startSessionRename}
            renamer={renaming}
            onRenameChange={(value) => setRenaming((r) => (r ? { ...r, value } : r))}
            onSubmitRename={() => void submitRename()}
            onCancelRename={cancelRename}
          />
        ) : (
          <>
            {projects === null && !error && (
              <div className="text-muted-foreground flex items-center gap-2 px-2 py-1 text-xs">
                <Loader2 className="size-3.5 animate-spin" /> Loading projects…
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
                const locked = project.id === defaultProjectId;
                const editing = renaming?.kind === "project" && renaming.id === project.id;
                return (
                  <li key={project.id}>
                    <div
                      className={cn(
                        "group hover:bg-muted flex items-center gap-1.5 rounded-md px-2 py-1.5",
                        active && "bg-muted font-medium",
                      )}
                    >
                      {editing ? (
                        <RenameField
                          value={renaming.value}
                          onChange={(value) =>
                            setRenaming({ kind: "project", id: project.id, value })
                          }
                          onSubmit={() => void submitRename()}
                          onCancel={cancelRename}
                        />
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleProject(project)}
                            aria-current={active ? "true" : undefined}
                            aria-expanded={expanded}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-start text-sm"
                          >
                            <ChevronRight
                              className={cn(
                                "text-muted-foreground size-3.5 shrink-0 transition-transform",
                                expanded && "rotate-90",
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate">{project.name}</span>
                          </button>
                          {!locked && (
                            <RowMenu
                              label={`Project actions: ${project.name}`}
                              onRename={() => startProjectRename(project)}
                              onArchive={() => void doArchiveProject(project)}
                              onDelete={() =>
                                setDeleting({ kind: "project", id: project.id, name: project.name })
                              }
                            />
                          )}
                        </>
                      )}
                    </div>
                    {expanded && !editing && (
                      <SessionList
                        sessions={sessions}
                        activeSessionId={activeSessionId}
                        busy={busy}
                        renaming={renaming}
                        onPick={switchSession}
                        onCreate={() => void addSession()}
                        onStartRename={startSessionRename}
                        onRenameChange={(value) =>
                          setRenaming((r) => (r ? { ...r, value } : r))
                        }
                        onSubmitRename={() => void submitRename()}
                        onCancelRename={cancelRename}
                        onArchive={(session) => void doArchiveSession(session)}
                        onDelete={(session) =>
                          setDeleting({
                            kind: "session",
                            projectId: session.projectId,
                            id: session.id,
                            name: session.title ?? session.id,
                          })
                        }
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <Dialog open={deleting !== null} onOpenChange={(open) => (!open ? setDeleting(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deleting?.kind === "session" ? "删除会话？" : "删除项目？"}
            </DialogTitle>
            <DialogDescription>
              {deleting?.kind === "session"
                ? `「${deleting.name}」及其所有运行记录都会被删除，且无法恢复。`
                : `「${deleting?.name ?? ""}」连同它的会话、运行记录与全部历史文件都会被删除，且无法恢复。`}
            </DialogDescription>
            {deleting?.kind === "project" && openJobCount > 0 ? (
              <p className="text-destructive text-xs">
                {`注意：该项目还有 ${openJobCount} 个运行中的 HPC 计算任务，删除不会停止它们，需要到集群上自行处理。`}
              </p>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={busy}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

/** The expanded Project's Sessions, with its rename/archive/delete affordances. */
function SessionList({
  sessions,
  activeSessionId,
  busy,
  renaming,
  onPick,
  onCreate,
  onStartRename,
  onRenameChange,
  onSubmitRename,
  onCancelRename,
  onArchive,
  onDelete,
}: {
  sessions: Session[];
  activeSessionId: string | null;
  busy: boolean;
  renaming: Renaming;
  /** Commit the scope to this Session — bound to the DOUBLE click. */
  onPick: (id: string) => void;
  onCreate: () => void;
  onStartRename: (session: Session) => void;
  onRenameChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onArchive: (session: Session) => void;
  onDelete: (session: Session) => void;
}) {
  return (
    <ul className="border-border/70 ms-3 mb-1 flex flex-col gap-0.5 border-s ps-1">
      {sessions.map((session) => {
        const editing = renaming?.kind === "session" && renaming.id === session.id;
        return (
          <li key={session.id}>
            {editing ? (
              <div className="flex items-center gap-1.5 rounded-md px-2 py-1">
                <RenameField
                  value={renaming.value}
                  onChange={onRenameChange}
                  onSubmit={onSubmitRename}
                  onCancel={onCancelRename}
                />
              </div>
            ) : (
              <div
                className={cn(
                  "group hover:bg-muted flex items-center gap-1.5 rounded-md px-2 py-1.5",
                  session.id === activeSessionId && "bg-accent text-accent-foreground",
                )}
              >
                {/*
                  A double click opens the Session: a single click only happens on
                  the way there. Keyboard activation (Enter/Space) keeps the row
                  operable without a pointer.
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
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-start text-xs"
                >
                  <MessagesSquare className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{session.title ?? session.id}</span>
                </button>
                <RowMenu
                  label={`Session actions: ${session.title ?? session.id}`}
                  onRename={() => onStartRename(session)}
                  onArchive={() => onArchive(session)}
                  onDelete={() => onDelete(session)}
                />
              </div>
            )}
          </li>
        );
      })}
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

/** The archive view: archived Projects and archived Sessions, both restorable. */
function ArchiveList({
  archived,
  active,
  sessionsFor,
  expanded,
  busy,
  onToggle,
  onRestoreProject,
  onRestoreSession,
  onDeleteProject,
  onDeleteSession,
  onStartRename,
  renamer,
  onRenameChange,
  onSubmitRename,
  onCancelRename,
}: {
  archived: Project[] | null;
  active: Project[];
  sessionsFor: (projectId: string) => Session[] | null;
  expanded: Set<string>;
  busy: boolean;
  onToggle: (projectId: string) => void;
  onRestoreProject: (project: Project) => void;
  onRestoreSession: (session: Session) => void;
  onDeleteProject: (project: Project) => void;
  onDeleteSession: (session: Session) => void;
  onStartRename: (session: Session) => void;
  renamer: Renaming;
  onRenameChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
}) {
  if (archived === null) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 px-2 py-1 text-xs">
        <Loader2 className="size-3.5 animate-spin" /> Loading archive…
      </div>
    );
  }
  if (archived.length === 0 && active.length === 0) {
    return <p className="text-muted-foreground px-2 py-1 text-xs">Nothing archived.</p>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {[...archived, ...active].map((project) => {
        const isArchived = project.archivedAt !== undefined;
        const isOpen = expanded.has(project.id);
        const all = sessionsFor(project.id);
        // An archived Project shows all its Sessions; an active one only its
        // archived ones (that is the point of listing it here).
        const shown = all === null ? null : isArchived ? all : all.filter((s) => s.archivedAt);
        return (
          <li key={project.id}>
            <div className="group hover:bg-muted flex items-center gap-1.5 rounded-md px-2 py-1.5">
              <button
                type="button"
                onClick={() => onToggle(project.id)}
                aria-expanded={isOpen}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-start text-sm"
              >
                <ChevronRight
                  className={cn(
                    "text-muted-foreground size-3.5 shrink-0 transition-transform",
                    isOpen && "rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {isArchived && (
                  <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 text-[10px]">
                    已归档
                  </span>
                )}
              </button>
              {isArchived && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Restore project ${project.name}`}
                    onClick={() => onRestoreProject(project)}
                  >
                    <ArchiveRestore />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive"
                    aria-label={`Delete project ${project.name} permanently`}
                    onClick={() => onDeleteProject(project)}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </div>
            {isOpen && (
              <ul className="border-border/70 ms-3 mb-1 flex flex-col gap-0.5 border-s ps-1">
                {shown === null && (
                  <li className="text-muted-foreground flex items-center gap-2 px-2 py-1 text-xs">
                    <Loader2 className="size-3.5 animate-spin" /> Loading sessions…
                  </li>
                )}
                {shown !== null && shown.length === 0 && (
                  <li className="text-muted-foreground px-2 py-1 text-xs">No archived sessions.</li>
                )}
                {shown?.map((session) => {
                  const editing = renamer?.kind === "session" && renamer.id === session.id;
                  return (
                    <li
                      key={session.id}
                      className="group hover:bg-muted flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs"
                    >
                      {editing ? (
                        <RenameField
                          value={renamer.value}
                          onChange={onRenameChange}
                          onSubmit={onSubmitRename}
                          onCancel={onCancelRename}
                        />
                      ) : (
                        <>
                          <MessagesSquare className="text-muted-foreground size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">
                            {session.title ?? session.id}
                          </span>
                          {session.archivedAt !== undefined && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`Rename session ${session.title ?? session.id}`}
                                onClick={() => onStartRename(session)}
                              >
                                <Pencil />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`Restore session ${session.title ?? session.id}`}
                                onClick={() => onRestoreSession(session)}
                              >
                                <ArchiveRestore />
                              </Button>
                            </>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="text-destructive"
                            aria-label={`Delete session ${session.title ?? session.id} permanently`}
                            onClick={() => onDeleteSession(session)}
                          >
                            <Trash2 />
                          </Button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
      {busy && (
        <li className="text-muted-foreground flex items-center gap-2 px-2 py-1 text-xs">
          <Loader2 className="size-3.5 animate-spin" />
        </li>
      )}
    </ul>
  );
}

/** A rename/archive/delete menu that only shows on hover/focus of its row. */
function RowMenu({
  label,
  onRename,
  onArchive,
  onDelete,
}: {
  label: string;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32">
        <DropdownMenuItem onSelect={onRename}>
          <Pencil /> 重命名
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onArchive}>
          <Archive /> 归档
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 /> 删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** An inline rename field: Enter/blur commits, Escape cancels. */
function RenameField({
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="flex min-w-0 flex-1 items-center"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Input
        autoFocus
        aria-label="Rename"
        className="h-6 text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={onSubmit}
      />
    </form>
  );
}
