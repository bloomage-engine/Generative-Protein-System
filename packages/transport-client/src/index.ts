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
  useWorkspaceBrowser,
  type WorkspaceBrowser,
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
  createProject,
  fetchProjectSessions,
  createSession,
  fetchProjectRuns,
  type Project,
  type Run,
  type Session,
} from "./projects.js";
