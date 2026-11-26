import {
  ComposerPrimitive,
} from "@assistant-ui/react";
import { useRuntimeSlashMenu } from "@gps/transport-client";

/**
 * Composer with runtime slash commands (docs/adr/0003).
 *
 * Runtime commands are plain "/"-prefixed user messages end-to-end, so this is
 * pure UI on top of the normal send path: typing "/" opens a menu of the
 * runtime adapter's command catalog. The catalog mapping, the slash adapter
 * and the enable rule live in the shared `useRuntimeSlashMenu`; this file only
 * skins the popover with the example's plain CSS.
 */
export function Composer() {
  const slash = useRuntimeSlashMenu();

  return (
    <div className="composer-anchor">
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
