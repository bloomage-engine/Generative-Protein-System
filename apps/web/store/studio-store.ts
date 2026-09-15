"use client";

import { create } from "zustand";
import type { Project, Session } from "@science-studio/transport-client";

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
  /** The install's Projects; `null` = not loaded yet (the panel loads lazily). */
  projects: Project[] | null;
  /** The ACTIVE Project's Sessions — never another Project's list. */
  sessions: Session[];
  activeSessionId: string | null;
  tabs: Tab[];
  activeTabPath: string | null;
  leftView: LeftView;
  leftPanel: boolean;
  rightPanel: boolean;

  setProjectId: (id: string | null) => void;
  setProjects: (list: Project[]) => void;
  setSessions: (list: Session[]) => void;
  setActiveSessionId: (id: string | null) => void;

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
  projects: null,
  sessions: [],
  activeSessionId: null,
  tabs: [],
  activeTabPath: null,
  leftView: "thread",
  leftPanel: true,
  rightPanel: true,

  setProjectId: (projectId) => set({ projectId }),
  setProjects: (projects) => set({ projects }),
  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),

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
