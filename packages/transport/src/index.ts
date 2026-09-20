/**
 * `@science-studio/transport` — the shared transport package, in three tiers:
 *
 * 1. the CONTRACT surface (re-exported from `./seams.js`): every seam interface
 *    plus its error classes and limit constants. Import it alone via
 *    `@science-studio/transport/seams`.
 * 2. the KIT: behavior adapters share rather than re-implement (`SessionRuntime`
 *    + its `SessionBehavior`, `foldState`, the attachment rendering/mention
 *    helpers).
 * 3. the pure SINGLE-USER DEFAULTS: the constant principal, the local
 *    environment, `NullWorkspace`, `NoopQuotaPolicy`.
 *
 * The exports are listed explicitly (no `export *`) so this file IS the public
 * surface: adding a symbol to an internal module does not silently widen the
 * package's interface.
 *
 * Keep the package React-free (the assistant-ui boundary lives in
 * `@science-studio/transport-client`).
 */

// -- 1. Contract surface -----------------------------------------------------
export type {
  SessionState,
  Message,
  AttachmentRef,
  MessagePart,
  WatchSnapshot,
  StateDelta,
  TransportCommand,
  CommandDescriptor,
  SubagentRun,
  SubagentTranscript,
  RuntimeAdapter,
  RuntimeInitOptions,
  ProjectContext,
  RecordStoreLike,
} from "./seams.js";
export type { Principal, PrincipalResolver, RequestContext, Role } from "./seams.js";
export type { Environment, EnvironmentProvider } from "./seams.js";
export type {
  DirListing,
  Entry,
  FileContent,
  FileStat,
  QuotaPolicy,
  Workspace,
  WorkspaceLimits,
  WriteOptions,
} from "./seams.js";
export type {
  RuntimeBinding,
  RuntimeCapabilities,
  RuntimeFactory,
  RuntimePlugin,
} from "./seams.js";
export { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_QUOTA_BYTES } from "./seams.js";
export {
  FileTooLargeError,
  WorkspaceEscapeError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  WorkspaceUnavailableError,
} from "./seams.js";
export { RuntimeBindingError } from "./seams.js";
export type {
  ModelSettings,
  ModelSettingsPatch,
  RuntimeSettings,
  RuntimeSettingsView,
  RuntimeSettingsPatch,
  SubagentSettings,
  SubagentSettingsPatch,
} from "./settings.js";
export type {
  SkillInfo,
  SkillInstallInput,
  SkillInvocationPolicy,
  SkillScope,
} from "./skills.js";
export {
  SkillExistsError,
  SkillInvalidError,
  SkillNameInvalidError,
  SkillNotFoundError,
} from "./skills.js";

// -- 2. Kit ------------------------------------------------------------------
export { foldState, sameMessages, sameConversation } from "./fold.js";
export type { DeltaEffect, FoldState } from "./fold.js";
// `RunFlow` stays a public kit primitive: the service's wire regression test
// replays the fold-and-fan-out pipeline with it (unlike `Transcript`, retired
// in docs/adr/0005).
export { RunFlow } from "./run-flow.js";
export { createApplyContext } from "./apply-context.js";
export type { ApplyContextOptions } from "./apply-context.js";
export { SessionRuntime, textOutput, mergeToolResult } from "./session-runtime.js";
export type {
  ApplyContext,
  ApplyResult,
  DispatchMessage,
  DispatchRequest,
  RunControl,
  RunSink,
  RunSpec,
  Scheduler,
  SessionBehavior,
  SessionRuntimeDeps,
  SettleContext,
  SettleDirective,
  ToolCallUpdate,
  TranscriptHandle,
  WatchPolicy,
} from "./session-runtime.js";
export {
  attachmentsFromMentions,
  parseWorkspaceMentions,
  promptWithAttachments,
  renderAttachments,
  userMessageParts,
} from "./attachments.js";
export type { AttachmentRenderingOptions, MentionRef } from "./attachments.js";
export { bindingOptionalString, bindingString } from "./runtime.js";
export { isCommandText } from "./commands.js";

// -- 3. Pure single-user defaults --------------------------------------------
export { LocalPrincipalResolver } from "./principal.js";
export { LocalEnvironmentProvider } from "./environment.js";
export { NoopQuotaPolicy, NullWorkspace } from "./workspace.js";
