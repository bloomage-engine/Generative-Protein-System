"use client";

import { create } from "zustand";
import type { Project, Session } from "@science-studio/transport-client";
import {
  readScopeMemory,
  rememberScope,
  syncScopeUrl,
  writeScopeMemory,
  type Scope,
  type ScopeMemory,
} from "@/lib/scope-memory";

/** One open file tab, keyed by its workspace path (its identity). */
export interface Tab {
  id: string;
  path: string;
  name: string;
}

/**
 * What the left slot of the workbench shows. The slot is ONE piece of real
 * estate shared by the conversation and the Project/Session panel, and the top
 * bar's two switch buttons pick which one owns it (`selectLeftView`).
 */
export type LeftView = "thread" | "project";

/** The right pane's three collapsible modules. */
export type RightSectionId = "files" | "subagents" | "cron";

type State = {
  projectId: string | null;
  /**
   * The Project the Projects pane is EXPANDED on — the one whose Sessions it
   * lists. Browsing moves this alone; the active scope (`projectId`) only moves
   * when a Session is double-clicked, so listing another Project's Sessions does
   * not drag the conversation (and the workspace) with it.
   */
  panelProjectId: string | null;
  /** The install's Projects; `null` = not loaded yet (the panel loads lazily). */
  projects: Project[] | null;
  /**
   * The bootstrap Project's id — the one the record auto-ensures and every
   * unscoped request lands on. It cannot be renamed, archived or deleted
   * (docs/adr/0014), so the panel locks those actions on it. `null` until the
   * overview has answered.
   */
  defaultProjectId: string | null;
  /** The ACTIVE Project's Sessions — never another Project's list. */
  sessions: Session[];
  /** The PANE's Project's Sessions — the same list as `sessions` while the pane shows the active Project. */
  panelSessions: Session[];
  activeSessionId: string | null;
  tabs: Tab[];
  activeTabPath: string | null;
  leftView: LeftView;
  leftPanel: boolean;
  rightPanel: boolean;
  /** Which right-pane modules are expanded (in memory; reload returns to defaults). */
  rightSections: Record<RightSectionId, boolean>;
  /**
   * Pixel heights the user has dragged for the two non-Files modules, kept
   * across a collapse. Files itself is the flexible filler (it grows to fill),
   * so it has no stored height.
   */
  rightHeights: { subagents: number; cron: number };
  /** The deployment settings dialog. Chrome state: never keyed into SessionView. */
  settingsOpen: boolean;
  /**
   * Bumped when a run finishes, so the status bar refetches its Session metrics
   * from the record. A counter, not the metrics themselves: the record stays the
   * source and the hook owns the fetch.
   */
  runsRevision: number;

  setProjects: (list: Project[]) => void;
  setDefaultProjectId: (id: string | null) => void;
  /** Replace a Project in place (rename), or append it (an unarchived/resurrected row). */
  upsertProject: (project: Project) => void;
  /** Drop an archived/deleted Project; clears the pane and the active list for it. */
  removeProject: (id: string) => void;
  setSessions: (list: Session[]) => void;
  /** Replace a Session in whichever list holds it (rename). */
  upsertSession: (session: Session) => void;
  /** Drop an archived/deleted Session from both lists. */
  removeSession: (id: string) => void;
  /** Expand the pane on a Project (or `null` for none); a real move drops the previous list. */
  setPanelProject: (id: string | null) => void;
  setPanelSessions: (list: Session[]) => void;
  /**
   * Commit the effective scope. The store, the remembered scope (docs/adr/0009)
   * and the URL move together — this is the only way the scope changes, so none
   * of the three can drift. Pass the memory the caller resolved against (it
   * carries what the record answered, pruned entries included); omit it only
   * when nothing was resolved, which keeps the Project's own remembered Session.
   */
  setScope: (scope: Scope, memory?: ScopeMemory) => void;

  openFile: (path: string, name: string) => void;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;

  /** The switch button's action: show `view`, or collapse the slot if it already owns it. */
  selectLeftView: (view: LeftView) => void;
  /** Pure assignment — for seeding the shell (a fresh install lands on the panel). */
  setLeftView: (view: LeftView) => void;
  toggleRight: () => void;
  toggleRightSection: (id: RightSectionId) => void;
  setRightSectionHeight: (id: "subagents" | "cron", height: number) => void;
  /**
   * Atomically set both stored heights in one update — the edge between the two
   * fixed modules redistributes space between them, and a single set keeps the
   * pair consistent (no half-applied frame).
   */
  setRightHeights: (heights: { subagents: number; cron: number }) => void;
  openSettings: () => void;
  closeSettings: () => void;
  /** Signal that a run finished; the status bar's metrics hook depends on it. */
  bumpRunsRevision: () => void;
};

export const useStudioStore = create<State>()((set) => ({
  projectId: null,
  panelProjectId: null,
  projects: null,
  defaultProjectId: null,
  sessions: [],
  panelSessions: [],
  activeSessionId: null,
  tabs: [],
  activeTabPath: null,
  leftView: "thread",
  leftPanel: true,
  rightPanel: true,
  rightSections: { files: true, subagents: false, cron: false },
  rightHeights: { subagents: 200, cron: 200 },
  settingsOpen: false,
  runsRevision: 0,

  setProjects: (projects) => set({ projects }),
  setDefaultProjectId: (defaultProjectId) => set({ defaultProjectId }),
  upsertProject: (project) =>
    set((s) => {
      const list = s.projects;
      if (!list) return { projects: [project] };
      return {
        projects: list.some((p) => p.id === project.id)
          ? list.map((p) => (p.id === project.id ? project : p))
          : [...list, project],
      };
    }),
  removeProject: (id) =>
    set((s) => ({
      projects: (s.projects ?? []).filter((p) => p.id !== id),
      // The pane must not stay expanded on a row that is gone; a scope move is
      // the caller's `setScope` (the only way scope changes).
      ...(s.panelProjectId === id ? { panelProjectId: null, panelSessions: [] } : {}),
      ...(s.projectId === id ? { sessions: [] } : {}),
    })),
  setSessions: (sessions) =>
    set((state) => ({
      sessions,
      // The pane shows the active Project's list while it is expanded on it.
      ...(state.panelProjectId === state.projectId ? { panelSessions: sessions } : {}),
    })),
  upsertSession: (session) =>
    set((s) => ({
      panelSessions: s.panelSessions.some((x) => x.id === session.id)
        ? s.panelSessions.map((x) => (x.id === session.id ? session : x))
        : s.panelSessions,
      sessions: s.sessions.some((x) => x.id === session.id)
        ? s.sessions.map((x) => (x.id === session.id ? session : x))
        : s.sessions,
    })),
  removeSession: (id) =>
    set((s) => ({
      panelSessions: s.panelSessions.filter((x) => x.id !== id),
      sessions: s.sessions.filter((x) => x.id !== id),
    })),
  setPanelProject: (panelProjectId) =>
    set((state) =>
      state.panelProjectId === panelProjectId
        ? {}
        : { panelProjectId, panelSessions: [] },
    ),
  setPanelSessions: (panelSessions) => set({ panelSessions }),
  setScope: ({ projectId, sessionId }, memory) => {
    set((state) => {
      // The pane's list IS the committed Project's list whenever the pane was
      // already expanded on it (that is how a Session gets picked).
      const paneHoldsTarget = state.panelProjectId === projectId;
      return {
        projectId,
        activeSessionId: sessionId,
        // A committed scope is what the pane shows.
        panelProjectId: projectId,
        ...(state.projectId === projectId
          ? {}
          : {
              // A Project switch swaps the workspace under the tabs: every open
              // file belongs to the previous Project's tree. The new Project's
              // Sessions are the ones the pane was showing, or unknown.
              tabs: [],
              activeTabPath: null,
              sessions: paneHoldsTarget ? state.panelSessions : [],
            }),
        // The pane's list only belongs to it while it is expanded on that
        // Project; expanding elsewhere drops it and the pane re-lists what it
        // shows (its own effect owns that load).
        ...(paneHoldsTarget ? {} : { panelSessions: [] }),
      };
    });
    writeScopeMemory(memory ?? rememberScope(readScopeMemory(), { projectId, sessionId }));
    syncScopeUrl({ projectId, sessionId });
  },

  openFile: (path, name) =>
    set((s) => {
      const exists = s.tabs.some((t) => t.path === path);
      const tabs = exists ? s.tabs : [...s.tabs, { id: path, path, name }];
      return { tabs, activeTabPath: path };
    }),
  closeTab: (path) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.path === path);
      if (idx === -1) return {};
      const tabs = s.tabs.filter((t) => t.path !== path);
      let activeTabPath = s.activeTabPath;
      if (s.activeTabPath === path) {
        const next = tabs[idx] ?? tabs[idx - 1] ?? null;
        activeTabPath = next?.path ?? null;
      }
      return { tabs, activeTabPath };
    }),
  setActiveTab: (activeTabPath) => set({ activeTabPath }),

  selectLeftView: (view) =>
    set((s) =>
      s.leftPanel && s.leftView === view
        ? { leftPanel: false }
        : { leftView: view, leftPanel: true },
    ),
  setLeftView: (leftView) => set({ leftView }),

  toggleRight: () => set((s) => ({ rightPanel: !s.rightPanel })),
  toggleRightSection: (id) =>
    set((s) => ({ rightSections: { ...s.rightSections, [id]: !s.rightSections[id] } })),
  setRightSectionHeight: (id, height) =>
    set((s) => ({ rightHeights: { ...s.rightHeights, [id]: height } })),
  setRightHeights: (heights) => set({ rightHeights: heights }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  bumpRunsRevision: () => set((s) => ({ runsRevision: s.runsRevision + 1 })),
}));
