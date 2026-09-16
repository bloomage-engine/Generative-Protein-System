/**
 * The CONTRACT surface: every seam interface, plus the error classes and limit
 * constants that are *part of a seam's contract* (error modes and defaults are
 * facts an implementer must know, not implementation details — see the
 * `codebase-design` vocabulary).
 *
 * Use this entry (`@science-studio/transport/seams`) when you implement or
 * consume a seam and want nothing else. It deliberately excludes the shared kit
 * (`SessionRuntime`, `RunFlow`, `foldState`, the attachment helpers) and the pure
 * single-user defaults (`LocalPrincipalResolver`, `LocalEnvironmentProvider`,
 * `NullWorkspace`, `NoopQuotaPolicy`); the package root re-exports all three
 * surfaces together.
 */
export type {
  SessionState,
  Message,
  AttachmentRef,
  MessagePart,
  WatchSnapshot,
  StateDelta,
  TransportCommand,
  CommandDescriptor,
  RuntimeAdapter,
  RuntimeInitOptions,
  ProjectContext,
  RecordStoreLike,
} from "./types.js";

export type { Principal, PrincipalResolver, RequestContext, Role } from "./principal.js";
export type { Environment, EnvironmentProvider } from "./environment.js";
export type {
  DirListing,
  Entry,
  FileContent,
  FileStat,
  QuotaPolicy,
  Workspace,
  WorkspaceLimits,
  WriteOptions,
} from "./workspace.js";
export type {
  RuntimeBinding,
  RuntimeCapabilities,
  RuntimeFactory,
  RuntimePlugin,
} from "./runtime.js";

export { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_QUOTA_BYTES } from "./workspace.js";
export {
  FileTooLargeError,
  WorkspaceEscapeError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  WorkspaceUnavailableError,
} from "./workspace.js";
export { RuntimeBindingError } from "./runtime.js";
