"use client";

export { useTransport, type UseTransportOptions } from "./use-transport.js";
export {
  fetchCommandCatalog,
  TransportApiProvider,
  useRuntimeCommands,
  useTransportApi,
} from "./catalog.js";
export { slashMenuEnabled, useRuntimeSlashMenu, type RuntimeSlashMenu } from "./slash-menu.js";
export {
  buildReasoningTrace,
  useMessageReasoningTrace,
  type ReasoningStep,
  type ReasoningTrace,
} from "./reasoning.js";
export {
  MarkdownText,
  type MarkdownComponents,
  type MarkdownTextProps,
} from "./markdown.js";
export {
  resolveFileReference,
  type FileRef,
  type FileReferenceContext,
} from "./file-reference.js";
export {
  DEFAULT_WORKSPACE_API,
  WorkspaceApiProvider,
  useWorkspaceApi,
  WorkspaceRequestError,
  isWorkspaceUnavailable,
  WORKSPACE_UNAVAILABLE_REASON,
  fetchWorkspaceEntries,
  fetchWorkspaceStat,
  workspaceFileUrl,
  uploadWorkspaceFile,
  deleteWorkspaceEntry,
  useWorkspaceBrowser,
  type WorkspaceBrowser,
  useWorkspaceRoot,
  type WorkspaceRoot,
  useWorkspaceAvailability,
  type WorkspaceAvailability,
  useWorkspaceFile,
  type WorkspaceFilePreview,
  WorkspaceOpenProvider,
  useWorkspaceOpen,
  type WorkspaceOpenHandler,
} from "./workspace.js";
export type { DirListing, Entry, FileStat } from "./workspace.js";
export { useWorkspaceMentions, type WorkspaceMentions } from "./mentions.js";
export {
  DEFAULT_PROJECTS_API,
  RecordRequestError,
  fetchProjects,
  fetchProjectsOverview,
  createProject,
  renameProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
  fetchProjectSessions,
  createSession,
  renameSession,
  archiveSession,
  unarchiveSession,
  deleteSession,
  fetchProjectRuns,
  fetchSessionRuns,
  type Project,
  type Run,
  type Session,
} from "./projects.js";
export {
  formatTokens,
  summarizeSessionRuns,
  type SessionMetrics,
  type TokenUsage,
} from "./session-metrics.js";
export { useSessionMetrics, type UseSessionMetricsOptions } from "./use-session-metrics.js";
export {
  DEFAULT_SETTINGS_API,
  SettingsRequestError,
  fetchSettings,
  updateSettings,
} from "./settings.js";
export type {
  ModelSettings,
  ModelSettingsPatch,
  RuntimeSettings,
  RuntimeSettingsView,
  RuntimeSettingsPatch,
} from "@science-studio/transport";
