"use client";

/**
 * Composer with runtime slash commands (docs/adr/0003).
 *
 * The Thread's registry-generated `Composer` is extracted here so it can be
 * wrapped in an `Unstable_TriggerPopoverRoot`: typing "/" at a word start
 * opens a menu of the runtime adapter's command catalog. The catalog mapping,
 * the slash adapter and the enable rule live in the shared
 * `useRuntimeSlashMenu`; this file only skins the popover (icons + shadcn
 * styling) and the composer itself.
 */

import { ComposerAddAttachment, ComposerAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useRuntimeSlashMenu, useWorkspaceMentions } from "@science-studio/transport-client";
import {
  AuiIf,
  ComposerPrimitive,
} from "@assistant-ui/react";
import {
  ActivityIcon,
  ArrowUpIcon,
  BrainIcon,
  CircleHelpIcon,
  CpuIcon,
  FileIcon,
  FingerprintIcon,
  FolderIcon,
  ListTreeIcon,
  MessageSquareTextIcon,
  MicIcon,
  PanelTopIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { type FC } from "react";

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
  tools: WrenchIcon,
  help: CircleHelpIcon,
  whoami: FingerprintIcon,
  context: PanelTopIcon,
};

/**
 * Build the assistant-ui slash adapter from the runtime command catalog.
 * `execute` appends the command's invocation text as a user message through
 * the thread runtime (not the composer draft), so a partially typed draft is
 * preserved; `removeOnExecute` then strips the "/cmd" token the user typed.
 */
export const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  const slash = useRuntimeSlashMenu();
  const mentions = useWorkspaceMentions();

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
                className="bg-popover text-popover-foreground border-border/60 absolute bottom-full z-10 mb-2 max-h-80 w-72 overflow-y-auto rounded-2xl border p-1.5 shadow-xl"
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

      {/* `@` workspace mentions: picking one inserts a directive chip, which the
          service lifts back into a workspace AttachmentRef. */}
      {mentions.enabled && (
        <ComposerPrimitive.Unstable_TriggerPopover
          char="@"
          adapter={mentions.adapter}
          aria-label="Workspace files"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Directive
            formatter={mentions.directive.formatter}
            onInserted={mentions.directive.onInserted}
          />
          <ComposerPrimitive.Unstable_TriggerPopoverItems>
            {(items) => (
              <div
                className="bg-popover text-popover-foreground border-border/60 absolute bottom-full z-10 mb-2 max-h-80 w-80 overflow-y-auto rounded-2xl border p-1.5 shadow-xl"
                data-slot="aui-composer-mention-menu"
              >
                {items.map((item, index) => {
                  const isDir = item.type === "directory";
                  const Icon = isDir ? FolderIcon : FileIcon;
                  return (
                    <ComposerPrimitive.Unstable_TriggerPopoverItem
                      key={item.id}
                      item={item}
                      index={index}
                      className="data-highlighted:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-start outline-none"
                    >
                      <Icon className="text-muted-foreground size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                        {item.label}
                      </span>
                      <span className="text-muted-foreground/60 shrink-0 font-mono text-[11px]">
                        {isDir ? "dir" : "file"}
                      </span>
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
            <ComposerPrimitive.Input
              placeholder="Send a message..."
              className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
              rows={1}
              autoFocus={autoFocus}
              enterKeyHint="send"
              aria-label="Message input"
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
