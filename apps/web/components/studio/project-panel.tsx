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
  archiveWorktree,
  createProject,
  createSession,
  DEFAULT_HPC_API,
  DEFAULT_WORKTREE_ID,
  deleteProject,
  deleteSession,
  deleteWorktree,
  fetchProjectsOverview,
  fetchProjectSessions,
  fetchWorktrees,
  isOpenComputeJobState,
  listHpcJobs,
  renameProject,
  renameSession,
  renameWorktree,
  unarchiveProject,
  unarchiveSession,
  unarchiveWorktree,
  type Project,
  type Session,
  type Worktree,
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
import { WorktreeCreateDialog } from "./worktree-create-dialog";

const PROJECTS_API = process.env.NEXT_PUBLIC_PROJECTS_URL ?? "/api/projects";
const WORKTREES_API = process.env.NEXT_PUBLIC_WORKTREES_URL ?? "/api/worktrees";

/**
 * The inline rename target (a Project's `name`, a Worktree's `name`, or a
 * Session's `title`). `projectId` is present for a Worktree/Session — the path
 * needs both halves.
 */
type Renaming =
  | { kind: "project"; id: string; value: string }
  | { kind: "worktree"; projectId: string; id: string; value: string }
  | { kind: "session"; projectId: string; id: string; value: string }
  | null;

/** The delete-confirmation target. */
type Deleting =
  | { kind: "project"; id: string; name: string }
  | { kind: "worktree"; projectId: string; id: string; name: string }
  | { kind: "session"; projectId: string; id: string; name: string }
  | null;

/**
 * The left slot's Project view: every Project, the active one expanded to its
 * Worktrees (a `Project → Worktree → Session` tree) — create, switch, rename,
 * archive and delete all three scopes from here.
 *
 * A Project expands to its Worktrees; a Worktree expands to its Sessions.
 * Single-clicking a Worktree SELECTS it (`setScope` with no Session), so browsing
 * a checkout's files needs no conversation — and a Session is only created under
 * the Worktree it is expanded on. The reserved `main` Worktree is the Project
 * root and cannot be renamed/archived/deleted, so its row carries no menu.
 *
 * Archiving is reversible and lives behind the header's archive toggle; deleting
 * is not (docs/adr/0014, 0025). The bootstrap Project (`defaultProjectId`) is
 * immutable, so its row carries no menu at all. Archiving or deleting the ACTIVE
 * scope re-resolves the workbench through `setScope`, the one path the store,
 * the remembered scope and the URL move along (docs/adr/0009).
 */
export function ProjectPanel() {
  const projects = useStudioStore((s) => s.projects);
  const defaultProjectId = useStudioStore((s) => s.defaultProjectId);
  const activeProjectId = useStudioStore((s) => s.projectId);
  const activeWorktreeId = useStudioStore((s) => s.activeWorktreeId);
  const panelProjectId = useStudioStore((s) => s.panelProjectId);
  const sessions = useStudioStore((s) => s.panelSessions);
  const activeSessionId = useStudioStore((s) => s.activeSessionId);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [renaming, setRenaming] = React.useState<Renaming>(null);
  const [deleting, setDeleting] = React.useState<Deleting>(null);
  // The Project whose "New worktree" dialog is open (`null` = closed).
  const [creatingWorktreeFor, setCreatingWorktreeFor] = React.useState<string | null>(null);
  /**
   * Each expanded Project's Worktrees, cached so re-expanding does not refetch.
   * The store holds only the ACTIVE Project's list (`worktrees`); the pane can
   * browse another Project, so it keeps its own per-Project map (docs/adr/0025).
   */
  const [worktreesFor, setWorktreesFor] = React.useState<Record<string, Worktree[]>>({});
  /**
   * The `(Project, Worktree)` the pane has expanded to its Sessions. One at a
   * time, matching the single `panelSessions` list; `null` means "follow the
   * effective worktree" (the active one, else `main`) — which is the state the
   * pane boots into.
   */
  const [expandedWorktree, setExpandedWorktree] = React.useState<{
    projectId: string;
    worktreeId: string;
  } | null>(null);
  // Read by `effectiveWorktreeId` from inside stable callbacks; the state drives
  // rendering, the ref keeps those callbacks from closing over a stale value.
  const expandedWorktreeRef = React.useRef(expandedWorktree);
  expandedWorktreeRef.current = expandedWorktree;
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
  // Archived Worktrees per Project, loaded with the archive view (docs/adr/0025).
  const [archiveWorktrees, setArchiveWorktrees] = React.useState<Record<string, Worktree[]>>({});
  const [expandedArchive, setExpandedArchive] = React.useState<Set<string>>(new Set());

  // `submitRename` runs from both Enter and blur; the ref lets `cancelRename`
  // (Escape) make the later blur a no-op without a second state read.
  const renamingRef = React.useRef<Renaming>(null);
  renamingRef.current = renaming;

  /**
   * The Worktree the pane's target Project is expanded on. A Project can hold
   * several Worktrees, and the pane expands ONE at a time (`expandedWorktree`);
   * when it has not picked one it follows the effective default — the ACTIVE
   * worktree while the pane shows the active Project, else `main` (a Project the
   * pane merely browses has no active worktree of its own: a Worktree id is only
   * unique within a Project). That default is what keeps a Session created or
   * listed while browsing another Project from landing on the active Project's
   * checkout behind its back.
   */
  const effectiveWorktreeId = React.useCallback((targetProjectId: string | null): string => {
    if (targetProjectId === null) return DEFAULT_WORKTREE_ID;
    const expanded = expandedWorktreeRef.current;
    if (expanded && expanded.projectId === targetProjectId) return expanded.worktreeId;
    const store = useStudioStore.getState();
    return targetProjectId === store.projectId
      ? (store.activeWorktreeId ?? DEFAULT_WORKTREE_ID)
      : DEFAULT_WORKTREE_ID;
  }, []);

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

  /** List a Project's Worktrees into the pane's per-Project cache (docs/adr/0025). */
  const loadWorktrees = React.useCallback(async (projectId: string) => {
    setBusy(true);
    setError(null);
    try {
      const list = await fetchWorktrees(WORKTREES_API, projectId);
      setWorktreesFor((map) => ({ ...map, [projectId]: list }));
      const store = useStudioStore.getState();
      if (store.projectId === projectId) store.setWorktrees(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // List a Worktree's Sessions for the PANE. Expanding is browsing, not
  // switching: the scope moves only when a Session is double-clicked or a
  // Worktree is selected. The list is scoped to the expanded worktree so the
  // pane and the active scope never disagree about which checkout's Sessions are
  // on screen; a stale response (the pane moved on) is dropped.
  const loadSessions = React.useCallback(async (projectId: string, worktreeId: string) => {
    setBusy(true);
    setError(null);
    try {
      const list = await fetchProjectSessions(PROJECTS_API, projectId, { worktreeId });
      const store = useStudioStore.getState();
      if (store.panelProjectId !== projectId) return;
      if (effectiveWorktreeId(projectId) !== worktreeId) return;
      store.setPanelSessions(list);
      if (
        store.projectId === projectId &&
        (store.activeWorktreeId ?? DEFAULT_WORKTREE_ID) === worktreeId
      ) {
        store.setSessions(list);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [effectiveWorktreeId]);

  /** Refresh the pane's expanded Worktree wherever the Project is currently shown. */
  const refreshSessions = React.useCallback(async (projectId: string) => {
    try {
      const list = await fetchProjectSessions(PROJECTS_API, projectId, {
        worktreeId: effectiveWorktreeId(projectId),
      });
      const store = useStudioStore.getState();
      if (store.panelProjectId === projectId) store.setPanelSessions(list);
      if (store.projectId === projectId) store.setSessions(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [effectiveWorktreeId]);

  const loadArchive = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { projects } = await fetchProjectsOverview(PROJECTS_API, { includeArchived: true });
      setArchiveProjects(projects.filter((p) => p.archivedAt !== undefined));
      setArchiveActive(projects.filter((p) => p.archivedAt === undefined));
      setArchiveSessions({});
      setArchiveWorktrees({});
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

  // The pane re-lists whatever it is expanded on and has nothing to show for:
  // its Worktrees when they are not cached, else its expanded Worktree's
  // Sessions.
  React.useEffect(() => {
    if (!panelProjectId) return;
    const cached = worktreesFor[panelProjectId];
    if (cached === undefined) {
      void loadWorktrees(panelProjectId);
    } else if (
      useStudioStore.getState().projectId === panelProjectId &&
      useStudioStore.getState().worktrees === null
    ) {
      // A cached list still has to reach the store after a Project switch reset it.
      useStudioStore.getState().setWorktrees(cached);
    }
    if (useStudioStore.getState().panelSessions.length > 0) return;
    void loadSessions(panelProjectId, effectiveWorktreeId(panelProjectId));
  }, [panelProjectId, worktreesFor, loadWorktrees, loadSessions, effectiveWorktreeId]);

  /** Expand/collapse a Project — the conversation does NOT follow. */
  const toggleProject = (project: Project) => {
    const store = useStudioStore.getState();
    const expanding = store.panelProjectId !== project.id;
    store.setPanelProject(expanding ? project.id : null);
    // Collapsing a Project drops its expanded Worktree; expanding one re-lists
    // its Worktrees afresh (an agent may have created one between expands).
    expandedWorktreeRef.current = null;
    setExpandedWorktree(null);
    if (!expanding) return;
    setWorktreesFor((map) => {
      if (!(project.id in map)) return map;
      const next = { ...map };
      delete next[project.id];
      return next;
    });
  };

  /** Double-clicking a Session is what commits the conversation scope. */
  const switchSession = (projectId: string, worktreeId: string, sessionId: string) => {
    const store = useStudioStore.getState();
    store.setScope({ projectId, worktreeId, sessionId });
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
      store.setScope({ projectId: project.id, worktreeId: DEFAULT_WORKTREE_ID, sessionId: null });
      store.setSessions([]);
      setName("");
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addSession = async (worktreeId: string) => {
    if (!panelProjectId) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createSession(PROJECTS_API, panelProjectId, { worktreeId });
      const store = useStudioStore.getState();
      if (store.panelProjectId !== panelProjectId) return;
      store.setPanelSessions([...store.panelSessions, session]);
      store.setScope({
        projectId: panelProjectId,
        worktreeId,
        sessionId: session.id,
      });
      store.setLeftView("thread");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startProjectRename = (project: Project) =>
    setRenaming({ kind: "project", id: project.id, value: project.name });
  const startWorktreeRename = (worktree: Worktree) =>
    setRenaming({
      kind: "worktree",
      projectId: worktree.projectId,
      id: worktree.id,
      value: worktree.name,
    });
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
      } else if (current.kind === "worktree") {
        const updated = await renameWorktree(WORKTREES_API, current.projectId, current.id, value);
        setWorktreesFor((map) =>
          map[current.projectId]
            ? {
                ...map,
                [current.projectId]: map[current.projectId]!.map((w) =>
                  w.id === updated.id ? updated : w,
                ),
              }
            : map,
        );
        const store = useStudioStore.getState();
        if (store.projectId === current.projectId) store.upsertWorktree(updated);
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
      store.setScope({ projectId: null, worktreeId: null, sessionId: null });
      store.setLeftView("project");
      return;
    }
    try {
      // A fallback Project has no expanded worktree of its own yet: land on the
      // one the scope rule would pick (`main`, since `nextId` is not active).
      const worktreeId = effectiveWorktreeId(nextId);
      const list = await fetchProjectSessions(PROJECTS_API, nextId, { worktreeId });
      const s = useStudioStore.getState();
      s.setScope({
        projectId: nextId,
        worktreeId,
        sessionId: fallbackSession(nextId, list),
      });
      s.setSessions(list);
      if (list.length === 0) s.setLeftView("project");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [effectiveWorktreeId]);

  const commitSessionFallback = (projectId: string, remaining: Session[]) => {
    const store = useStudioStore.getState();
    const nextId = fallbackSession(projectId, remaining);
    store.setScope({ projectId, worktreeId: effectiveWorktreeId(projectId), sessionId: nextId });
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
      // Fall back within the pane's worktree list, which is what the removed
      // Session was listed under (a Project-wide list could pick another
      // checkout's Session).
      if (wasActive) commitSessionFallback(session.projectId, useStudioStore.getState().panelSessions);
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
      if (wasActive) commitSessionFallback(session.projectId, useStudioStore.getState().panelSessions);
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Expand one Worktree in the pane and list its Sessions. `commitScope` is set
   * when the click should also move the ACTIVE scope (browsing a checkout's
   * files); removal handlers that only need the pane to re-list pass `false`.
   */
  const focusWorktree = (
    projectId: string,
    worktreeId: string,
    opts: { commitScope: boolean; worktrees?: Worktree[] },
  ) => {
    const store = useStudioStore.getState();
    const next = { projectId, worktreeId };
    expandedWorktreeRef.current = next;
    setExpandedWorktree(next);
    if (opts.commitScope) {
      store.setScope({ projectId, worktreeId, sessionId: null });
      // Keep the store's active Worktree list in step with the pane's cache
      // (`setScope` resets it to null only on a Project switch). Re-read the
      // store: the snapshot above predates the commit.
      const live = useStudioStore.getState();
      const cached = opts.worktrees ?? worktreesFor[projectId] ?? live.worktrees ?? [];
      if (live.projectId === projectId) live.setWorktrees(cached);
    }
    store.setPanelSessions([]);
    void loadSessions(projectId, worktreeId);
  };

  /** Select a Worktree (no Session required) and expand its Sessions. */
  const selectWorktree = (projectId: string, worktree: Worktree, list?: Worktree[]) =>
    focusWorktree(projectId, worktree.id, { commitScope: true, worktrees: list });

  /** A freshly created Worktree lands in the cache and opens straight away. */
  const handleWorktreeCreated = (worktree: Worktree) => {
    const projectId = worktree.projectId;
    const nextList = [...(worktreesFor[projectId] ?? []), worktree];
    setWorktreesFor((map) => ({ ...map, [projectId]: nextList }));
    const store = useStudioStore.getState();
    if (store.projectId === projectId) store.upsertWorktree(worktree);
    selectWorktree(projectId, worktree, nextList);
  };

  /** Re-list a Project's Worktrees after a mutation; the server is authoritative. */
  const reloadWorktrees = async (projectId: string) => {
    try {
      const list = await fetchWorktrees(WORKTREES_API, projectId);
      setWorktreesFor((map) => ({ ...map, [projectId]: list }));
      const store = useStudioStore.getState();
      if (store.projectId === projectId) store.setWorktrees(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Reconcile the pane after a Worktree is archived or deleted. If it was the
   * ACTIVE one the scope re-resolves to the Project root (`main`) — which clears
   * the tabs, a Worktree switch — otherwise only the pane's expansion moves.
   */
  const afterWorktreeGone = async (projectId: string, id: string) => {
    const store = useStudioStore.getState();
    const activeWorktree = store.activeWorktreeId ?? DEFAULT_WORKTREE_ID;
    const wasActive = store.projectId === projectId && activeWorktree === id;
    const wasExpanded = effectiveWorktreeId(projectId) === id;
    const remaining = (worktreesFor[projectId] ?? []).filter((w) => w.id !== id);
    setWorktreesFor((map) => ({ ...map, [projectId]: remaining }));
    // `store.worktrees` is the ACTIVE Project's list only; a worktree id is
    // unique only WITHIN a Project, so dropping the id while the pane browses
    // another Project would remove that Project's same-slug entry. Guard to the
    // active Project (both the archive and the delete path reach here).
    if (store.projectId === projectId) store.removeWorktree(id);
    if (wasActive) {
      focusWorktree(projectId, DEFAULT_WORKTREE_ID, { commitScope: true, worktrees: remaining });
    } else if (wasExpanded) {
      const next = store.projectId === projectId ? activeWorktree : DEFAULT_WORKTREE_ID;
      focusWorktree(projectId, next, { commitScope: false });
    }
    await reloadWorktrees(projectId);
  };

  const doArchiveWorktree = async (worktree: Worktree) => {
    setBusy(true);
    setError(null);
    try {
      await archiveWorktree(WORKTREES_API, worktree.projectId, worktree.id);
      await afterWorktreeGone(worktree.projectId, worktree.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDeleteWorktree = async (projectId: string, id: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteWorktree(WORKTREES_API, projectId, id);
      // The archive view may be showing the row; drop it there too.
      setArchiveWorktrees((map) =>
        map[projectId] ? { ...map, [projectId]: map[projectId]!.filter((w) => w.id !== id) } : map,
      );
      await afterWorktreeGone(projectId, id);
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRestoreWorktree = async (worktree: Worktree) => {
    setBusy(true);
    setError(null);
    try {
      await unarchiveWorktree(WORKTREES_API, worktree.projectId, worktree.id);
      setArchiveWorktrees((map) => ({
        ...map,
        [worktree.projectId]: (map[worktree.projectId] ?? []).filter((w) => w.id !== worktree.id),
      }));
      await reloadWorktrees(worktree.projectId);
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
    if (archiveSessions[projectId] && archiveWorktrees[projectId]) return;
    void (async () => {
      setBusy(true);
      try {
        if (!archiveSessions[projectId]) {
          const list = await fetchProjectSessions(PROJECTS_API, projectId, { includeArchived: true });
          setArchiveSessions((map) => ({ ...map, [projectId]: list }));
        }
        if (!archiveWorktrees[projectId]) {
          const worktrees = await fetchWorktrees(WORKTREES_API, projectId, { includeArchived: true });
          setArchiveWorktrees((map) => ({ ...map, [projectId]: worktrees }));
        }
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
    else if (target.kind === "worktree") await doDeleteWorktree(target.projectId, target.id);
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
            worktreesFor={(id) => archiveWorktrees[id] ?? null}
            expanded={expandedArchive}
            busy={busy}
            onToggle={toggleArchiveProject}
            onRestoreProject={doRestoreProject}
            onRestoreSession={doRestoreSession}
            onRestoreWorktree={doRestoreWorktree}
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
            onDeleteWorktree={(worktree) =>
              setDeleting({
                kind: "worktree",
                projectId: worktree.projectId,
                id: worktree.id,
                name: worktree.name,
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
                      <WorktreeList
                        projectId={project.id}
                        worktrees={worktreesFor[project.id] ?? null}
                        activeProjectId={activeProjectId}
                        activeWorktreeId={activeWorktreeId}
                        expandedWorktreeId={effectiveWorktreeId(project.id)}
                        sessions={sessions}
                        activeSessionId={activeSessionId}
                        busy={busy}
                        renaming={renaming}
                        onSelect={(worktree) => selectWorktree(project.id, worktree)}
                        onCreate={() => setCreatingWorktreeFor(project.id)}
                        onPickSession={(worktreeId, sessionId) =>
                          switchSession(project.id, worktreeId, sessionId)
                        }
                        onCreateSession={(worktreeId) => void addSession(worktreeId)}
                        onStartRename={startWorktreeRename}
                        onRenameChange={(value) =>
                          setRenaming((r) => (r ? { ...r, value } : r))
                        }
                        onSubmitRename={() => void submitRename()}
                        onCancelRename={cancelRename}
                        onArchive={(worktree) => void doArchiveWorktree(worktree)}
                        onDelete={(worktree) =>
                          setDeleting({
                            kind: "worktree",
                            projectId: worktree.projectId,
                            id: worktree.id,
                            name: worktree.name,
                          })
                        }
                        onStartSessionRename={startSessionRename}
                        onArchiveSession={(session) => void doArchiveSession(session)}
                        onDeleteSession={(session) =>
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

      <WorktreeCreateDialog
        open={creatingWorktreeFor !== null}
        projectId={creatingWorktreeFor ?? ""}
        onOpenChange={(open) => (!open ? setCreatingWorktreeFor(null) : undefined)}
        onCreated={handleWorktreeCreated}
      />

      <Dialog open={deleting !== null} onOpenChange={(open) => (!open ? setDeleting(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deleting?.kind === "session"
                ? "删除会话？"
                : deleting?.kind === "worktree"
                  ? "删除工作树？"
                  : "删除项目？"}
            </DialogTitle>
            <DialogDescription>
              {deleting?.kind === "session"
                ? `「${deleting.name}」及其所有运行记录都会被删除，且无法恢复。`
                : deleting?.kind === "worktree"
                  ? `「${deleting.name}」及其所有会话、运行记录都会被删除；该 checkout 与分支也会一并移除，且无法恢复。`
                  : `「${deleting?.name ?? ""}」连同它的会话、工作树、运行记录与全部历史文件都会被删除，且无法恢复。`}
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

/**
 * The expanded Project's Worktrees (`Project → Worktree → Session`). A Worktree
 * row selects that checkout and expands its Sessions; `main` is the Project root
 * and carries no menu (docs/adr/0025).
 */
function WorktreeList({
  projectId,
  worktrees,
  activeProjectId,
  activeWorktreeId,
  expandedWorktreeId,
  sessions,
  activeSessionId,
  busy,
  renaming,
  onSelect,
  onCreate,
  onPickSession,
  onCreateSession,
  onStartRename,
  onRenameChange,
  onSubmitRename,
  onCancelRename,
  onArchive,
  onDelete,
  onStartSessionRename,
  onArchiveSession,
  onDeleteSession,
}: {
  projectId: string;
  worktrees: Worktree[] | null;
  activeProjectId: string | null;
  activeWorktreeId: string | null;
  /** The one Worktree whose Sessions are listed (only one at a time). */
  expandedWorktreeId: string;
  sessions: Session[];
  activeSessionId: string | null;
  busy: boolean;
  renaming: Renaming;
  /** Select the checkout (no Session) and expand its Sessions. */
  onSelect: (worktree: Worktree) => void;
  onCreate: () => void;
  onPickSession: (worktreeId: string, sessionId: string) => void;
  onCreateSession: (worktreeId: string) => void;
  onStartRename: (worktree: Worktree) => void;
  onRenameChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onArchive: (worktree: Worktree) => void;
  onDelete: (worktree: Worktree) => void;
  onStartSessionRename: (session: Session) => void;
  onArchiveSession: (session: Session) => void;
  onDeleteSession: (session: Session) => void;
}) {
  if (worktrees === null) {
    return (
      <div className="border-border/70 text-muted-foreground ms-3 mb-1 flex items-center gap-2 border-s px-2 py-1 text-xs">
        <Loader2 className="size-3.5 animate-spin" /> Loading worktrees…
      </div>
    );
  }
  return (
    <ul className="border-border/70 ms-3 mb-1 flex flex-col gap-0.5 border-s ps-1">
      {worktrees.map((worktree) => {
        const active = projectId === activeProjectId && worktree.id === activeWorktreeId;
        const expanded = worktree.id === expandedWorktreeId;
        const editing = renaming?.kind === "worktree" && renaming.id === worktree.id;
        return (
          <li key={worktree.id}>
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
                  active && "bg-muted font-medium",
                )}
              >
                <button
                  type="button"
                  title={`Open worktree ${worktree.name}`}
                  aria-current={active ? "true" : undefined}
                  aria-expanded={expanded}
                  onClick={() => onSelect(worktree)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-start text-xs"
                >
                  <ChevronRight
                    className={cn(
                      "text-muted-foreground size-3.5 shrink-0 transition-transform",
                      expanded && "rotate-90",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{worktree.name}</span>
                  <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 font-mono text-[10px]">
                    {worktree.branch}
                  </span>
                </button>
                {worktree.id !== DEFAULT_WORKTREE_ID && (
                  <RowMenu
                    label={`Worktree actions: ${worktree.name}`}
                    onRename={() => onStartRename(worktree)}
                    onArchive={() => onArchive(worktree)}
                    onDelete={() => onDelete(worktree)}
                  />
                )}
              </div>
            )}
            {expanded && !editing && (
              <SessionList
                sessions={sessions}
                activeSessionId={activeSessionId}
                busy={busy}
                renaming={renaming}
                onPick={(id) => onPickSession(worktree.id, id)}
                onCreate={() => onCreateSession(worktree.id)}
                onStartRename={onStartSessionRename}
                onRenameChange={onRenameChange}
                onSubmitRename={onSubmitRename}
                onCancelRename={onCancelRename}
                onArchive={onArchiveSession}
                onDelete={onDeleteSession}
              />
            )}
          </li>
        );
      })}
      <li>
        <button
          type="button"
          onClick={onCreate}
          disabled={busy}
          className="hover:bg-muted text-muted-foreground flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs disabled:opacity-50"
        >
          <Plus className="size-3.5 shrink-0" /> New worktree
        </button>
      </li>
    </ul>
  );
}

/** The expanded Worktree's Sessions, with its rename/archive/delete affordances. */
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

/** The archive view: archived Projects, their archived Worktrees and Sessions, all restorable. */
function ArchiveList({
  archived,
  active,
  sessionsFor,
  worktreesFor,
  expanded,
  busy,
  onToggle,
  onRestoreProject,
  onRestoreSession,
  onRestoreWorktree,
  onDeleteProject,
  onDeleteSession,
  onDeleteWorktree,
  onStartRename,
  renamer,
  onRenameChange,
  onSubmitRename,
  onCancelRename,
}: {
  archived: Project[] | null;
  active: Project[];
  sessionsFor: (projectId: string) => Session[] | null;
  worktreesFor: (projectId: string) => Worktree[] | null;
  expanded: Set<string>;
  busy: boolean;
  onToggle: (projectId: string) => void;
  onRestoreProject: (project: Project) => void;
  onRestoreSession: (session: Session) => void;
  onRestoreWorktree: (worktree: Worktree) => void;
  onDeleteProject: (project: Project) => void;
  onDeleteSession: (session: Session) => void;
  onDeleteWorktree: (worktree: Worktree) => void;
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
        const allWorktrees = worktreesFor(project.id);
        const archivedWorktrees =
          allWorktrees === null ? null : allWorktrees.filter((w) => w.archivedAt !== undefined);
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
                {archivedWorktrees !== null && archivedWorktrees.length > 0 && (
                  <li>
                    <ul className="flex flex-col gap-0.5">
                      {archivedWorktrees.map((worktree) => (
                        <li
                          key={worktree.id}
                          className="group hover:bg-muted flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs"
                        >
                          <span className="min-w-0 flex-1 truncate">{worktree.name}</span>
                          <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 font-mono text-[10px]">
                            {worktree.branch}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Restore worktree ${worktree.name}`}
                            onClick={() => onRestoreWorktree(worktree)}
                          >
                            <ArchiveRestore />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="text-destructive"
                            aria-label={`Delete worktree ${worktree.name} permanently`}
                            onClick={() => onDeleteWorktree(worktree)}
                          >
                            <Trash2 />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
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
