"use client";

/**
 * Composer with runtime slash commands (docs/adr/0003) and `@` workspace
 * mentions.
 *
 * The Thread's registry-generated `Composer` is extracted here so it can be
 * wrapped in an `Unstable_TriggerPopoverRoot`: typing "/" at a word start
 * opens a menu of the runtime adapter's command catalog, and "@" opens a
 * browsable workspace picker. The catalog / mention mappings and the enable
 * rules live in the shared `useRuntimeSlashMenu` / `useWorkspaceMentions`; this
 * file skins the popovers and the composer itself.
 *
 * The input is assistant-ui's `LexicalComposerInput` (docs/adr/0023) instead of
 * the plain `<textarea>`: a mention is an inline chip (icon + name) rather than
 * the raw `:directory[…]` directive text, while the wire still carries that
 * directive (the chip's `getTextContent()`).
 */
import { ComposerAddAttachment, ComposerAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { useRuntimeSlashMenu, useWorkspaceMentions } from "@science-studio/transport-client";
import {
  AuiIf,
  ComposerPrimitive,
  unstable_useTriggerPopoverScopeContext,
} from "@assistant-ui/react";
import {
  LexicalComposerInput,
  type DirectiveChipProps,
} from "@assistant-ui/react-lexical";
import {
  ActivityIcon,
  ArrowUpIcon,
  BrainIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  CornerLeftUpIcon,
  CpuIcon,
  FileIcon,
  FingerprintIcon,
  FolderIcon,
  ListTreeIcon,
  MessageSquareTextIcon,
  MicIcon,
  PanelTopIcon,
  PlusIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, type FC } from "react";

/**
 * Icons for known runtime commands, keyed by command id; unknown commands
 * (other runtimes, or ids the catalog gains later) fall back to the terminal
 * glyph. Cosmetic only — the row always shows the exact invocation text.
 */
const COMMAND_ICONS: Record<string, LucideIcon> = {
  model: CpuIcon,
  think: BrainIcon,
  fast: ZapIcon,
  reasoning: SparklesIcon,
  verbose: MessageSquareTextIcon,
  trace: ListTreeIcon,
  elevated: ShieldCheckIcon,
  status: ActivityIcon,
  new: PlusIcon,
  tools: WrenchIcon,
  help: CircleHelpIcon,
  whoami: FingerprintIcon,
  context: PanelTopIcon,
};

/**
 * The inline `@` mention token: an icon chosen from the directive's type plus
 * the entry's name. The raw directive text stays the node's content (what the
 * wire and the service's `parseWorkspaceMentions` see); only its rendering is a
 * chip. Kept at module scope so the Lexical chip provider gets a stable
 * component identity.
 */
const WorkspaceDirectiveChip: FC<DirectiveChipProps> = ({ directiveType, label }) => {
  const Icon = directiveType === "directory" ? FolderIcon : FileIcon;
  return (
    <span
      className="aui-mention-chip border-border/60 bg-accent text-accent-foreground mx-0.5 inline-flex max-w-[18rem] items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline text-[13px] leading-5 font-medium"
      data-directive-type={directiveType}
    >
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
};

/**
 * Directories are NAVIGATED, not inserted: register a selection override on
 * the `@` trigger that walks into the picked directory and consumes the
 * selection. Everything else (files) falls through to the normal insert.
 *
 * The trigger must therefore use a `TriggerPopover.Action` (not `.Directive`):
 * a directive trigger is wired by the Lexical `DirectivePlugin`, which owns the
 * single selection-override slot — an action trigger leaves that slot to us.
 */
const MentionDirectoryNavigation: FC<{ navigate: (path: string) => void }> = ({
  navigate,
}) => {
  const scope = unstable_useTriggerPopoverScopeContext();
  useEffect(
    () =>
      scope.registerSelectItemOverride((item) => {
        if (item.type !== "directory") return false;
        navigate(item.id);
        return true;
      }),
    [scope, navigate],
  );
  return null;
};

/** Breadcrumb over the directory currently listed (`project / a / b`). */
const MentionBreadcrumb: FC<{ path: string; navigate: (path: string) => void }> = ({
  path,
  navigate,
}) => {
  if (path === "") return null;
  const segments = path.split("/").filter(Boolean);
  return (
    <div
      className="text-muted-foreground border-border/50 mb-1 flex flex-wrap items-center gap-0.5 border-b px-1.5 pb-1.5 text-[11px]"
      data-slot="aui-composer-mention-breadcrumb"
    >
      <button
        type="button"
        className="hover:bg-accent hover:text-foreground rounded-md px-1.5 py-0.5"
        onClick={() => navigate("")}
      >
        project
      </button>
      {segments.map((segment, index) => {
        const target = segments.slice(0, index + 1).join("/");
        const isLast = index === segments.length - 1;
        return (
          <span key={target} className="flex items-center gap-0.5">
            <ChevronRightIcon className="size-3 shrink-0 opacity-60" />
            {isLast ? (
              <span className="text-foreground px-1.5 py-0.5 font-medium">{segment}</span>
            ) : (
              <button
                type="button"
                className="hover:bg-accent hover:text-foreground rounded-md px-1.5 py-0.5"
                onClick={() => navigate(target)}
              >
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
};

/** A stable no-op: the `@` action only exists to free the selection-override slot. */
const noop = () => {};

/**
 * Build the assistant-ui slash adapter from the runtime command catalog.
 * `execute` appends the command's invocation text as a user message through
 * the thread runtime (not the composer draft), so a partially typed draft is
 * preserved; `removeOnExecute` then strips the "/cmd" token the user typed.
 */
export const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  const slash = useRuntimeSlashMenu();
  const mentions = useWorkspaceMentions({ withParent: true });

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      {slash.enabled && (
        <ComposerPrimitive.Unstable_TriggerPopover
          char="/"
          adapter={slash.adapter}
          aria-label="Runtime commands"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Action
            onExecute={slash.action.onExecute}
            removeOnExecute={slash.action.removeOnExecute}
          />
          <ComposerPrimitive.Unstable_TriggerPopoverItems>
            {(items) => (
              <div
                // The cap is viewport-aware on purpose: a fixed `max-h-80`
                // (320px) is shorter than this runtime's own menu (7 rows ≈
                // 456px), so the LAST rows — /permission, /plan — sat below the
                // fold of an internally scrolling box and looked missing.
                className="bg-popover text-popover-foreground border-border/60 absolute bottom-full z-10 mb-2 max-h-[min(70vh,32rem)] w-72 overflow-y-auto rounded-2xl border p-1.5 shadow-xl"
                data-slot="aui-composer-slash-menu"
              >
                {items.map((item, index) => {
                  const Icon = COMMAND_ICONS[item.id] ?? TerminalIcon;
                  return (
                    <ComposerPrimitive.Unstable_TriggerPopoverItem
                      key={item.id}
                      item={item}
                      index={index}
                      className="data-highlighted:bg-accent flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-xl px-2.5 py-2 text-start outline-none"
                    >
                      <span className="flex w-full items-center gap-1.5 text-[13.5px] font-medium">
                        <Icon className="text-muted-foreground size-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </span>
                      {item.description !== undefined && (
                        <span className="text-muted-foreground/75 line-clamp-2 pl-5.5 text-xs">
                          {item.description}
                        </span>
                      )}
                    </ComposerPrimitive.Unstable_TriggerPopoverItem>
                  );
                })}
              </div>
            )}
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>
      )}

      {/* `@` workspace mentions: the picker BROWSEs directories (a pick there
          navigates) and only a FILE inserts the directive the service lifts
          back into a workspace AttachmentRef. */}
      {mentions.enabled && (
        <ComposerPrimitive.Unstable_TriggerPopover
          char="@"
          adapter={mentions.adapter}
          aria-label="Workspace files"
        >
          {/* An Action (not a Directive) deliberately: it leaves the selection
              override to `MentionDirectoryNavigation` for directory browsing,
              and still inserts the directive chip for everything else. */}
          <ComposerPrimitive.Unstable_TriggerPopover.Action
            formatter={mentions.directive.formatter}
            onExecute={noop}
          />
          <MentionDirectoryNavigation navigate={mentions.navigate} />
          <ComposerPrimitive.Unstable_TriggerPopoverItems>
            {(items) => (
              <div
                className="bg-popover text-popover-foreground border-border/60 absolute bottom-full z-10 mb-2 max-h-80 w-80 overflow-y-auto rounded-2xl border p-1.5 shadow-xl"
                data-slot="aui-composer-mention-menu"
              >
                <MentionBreadcrumb path={mentions.path} navigate={mentions.navigate} />
                {items.map((item, index) => {
                  const isDir = item.type === "directory";
                  const isParent = item.label === "..";
                  const Icon = isParent ? CornerLeftUpIcon : isDir ? FolderIcon : FileIcon;
                  return (
                    <ComposerPrimitive.Unstable_TriggerPopoverItem
                      key={item.id || "__parent__"}
                      item={item}
                      index={index}
                      className="data-highlighted:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-start outline-none"
                    >
                      <Icon className="text-muted-foreground size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                        {item.label}
                      </span>
                      {isDir ? (
                        <ChevronRightIcon className="text-muted-foreground/60 size-3.5 shrink-0" />
                      ) : (
                        <span className="text-muted-foreground/60 shrink-0 font-mono text-[11px]">
                          file
                        </span>
                      )}
                    </ComposerPrimitive.Unstable_TriggerPopoverItem>
                  );
                })}
              </div>
            )}
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>
      )}

      <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div
            data-slot="aui_composer-shell"
            className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
          >
            <ComposerAttachments />
            <LexicalComposerInput
              placeholder="Send a message..."
              className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
              autoFocus={autoFocus}
              aria-label="Message input"
              directiveChip={WorkspaceDirectiveChip}
              formatter={mentions.directive.formatter}
            />
            <ComposerAction />
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <ComposerAddAttachment />
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="Send message"
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              aria-label="Send message"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-7 rounded-full"
              aria-label="Stop generating"
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};
