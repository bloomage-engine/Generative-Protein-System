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

  setProjects: (list: Project[]) => void;
  setSessions: (list: Session[]) => void;
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
};

export const useStudioStore = create<State>()((set) => ({
  projectId: null,
  panelProjectId: null,
  projects: null,
  sessions: [],
  panelSessions: [],
  activeSessionId: null,
  tabs: [],
  activeTabPath: null,
  leftView: "thread",
  leftPanel: true,
  rightPanel: true,

  setProjects: (projects) => set({ projects }),
  setSessions: (sessions) =>
    set((state) => ({
      sessions,
      // The pane shows the active Project's list while it is expanded on it.
      ...(state.panelProjectId === state.projectId ? { panelSessions: sessions } : {}),
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
}));
