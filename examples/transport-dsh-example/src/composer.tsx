import {
  ComposerPrimitive,
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
  type Unstable_SlashCommand,
} from "@assistant-ui/react";
import type { CommandDescriptor } from "@science-studio/transport";
import { useRuntimeCommands } from "@science-studio/transport-client";
import { useMemo } from "react";

/**
 * Composer with runtime slash commands (docs/adr/0003).
 *
 * Runtime commands are plain "/"-prefixed user messages end-to-end, so this is
 * pure UI on top of the normal send path: typing "/" opens a menu of the
 * runtime adapter's command catalog (`GET /api/transport/commands`, fetched by
 * `useRuntimeCommands`), and picking a command appends its invocation text
 * ("/status", …) as a user message via `aui.thread.append` — the composer
 * draft (if any) is left untouched.
 *
 * The "/" trigger only mounts while a non-empty catalog is loaded and the
 * thread is idle — an open popover over an empty list would swallow Enter, and
 * running research turns disable runtime commands.
 */
function useSlashCommands(commands: readonly CommandDescriptor[] | null) {
  const aui = useAui();
  const items = useMemo<Unstable_SlashCommand[]>(
    () =>
      (commands ?? []).map((c) => ({
        id: c.id,
        // The row shows the exact text that will be sent.
        label: c.invocationText,
        description: c.description,
        execute: () => {
          aui.thread.append(c.invocationText);
        },
      })),
    [commands, aui],
  );
  return unstable_useSlashCommandAdapter({ commands: items, removeOnExecute: true });
}

export function Composer() {
  const commands = useRuntimeCommands();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const slash = useSlashCommands(commands);
  const showSlashMenu = commands !== null && commands.length > 0 && !isRunning;

  return (
    <div className="composer-anchor">
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        {showSlashMenu && (
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
              {(items) =>
                items.length === 0 ? null : (
                  <div className="slash-menu">
                    {items.map((item, index) => (
                      <ComposerPrimitive.Unstable_TriggerPopoverItem
                        key={item.id}
                        item={item}
                        index={index}
                        className="slash-item"
                      >
                        <span className="slash-item-name">{item.label}</span>
                        {item.description !== undefined && (
                          <span className="slash-item-desc">{item.description}</span>
                        )}
                      </ComposerPrimitive.Unstable_TriggerPopoverItem>
                    ))}
                  </div>
                )
              }
            </ComposerPrimitive.Unstable_TriggerPopoverItems>
          </ComposerPrimitive.Unstable_TriggerPopover>
        )}

        <ComposerPrimitive.Root className="composer">
          <ComposerPrimitive.Input
            className="composer-input"
            placeholder={'Message the agent… (type "/" for commands)'}
            enterKeyHint="send"
            aria-label="Message input"
          />
          <ComposerPrimitive.Send className="composer-send">Send</ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </div>
  );
}
