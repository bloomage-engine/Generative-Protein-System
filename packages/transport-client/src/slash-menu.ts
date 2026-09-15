"use client";

import {
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
  type Unstable_SlashCommand,
} from "@assistant-ui/react";
import { useMemo } from "react";
import type { CommandDescriptor } from "@science-studio/transport";
import { useRuntimeCommands } from "./catalog.js";

/**
 * The slash-menu rule shared by every composer: mount the "/" trigger only
 * while a NON-EMPTY command catalog is loaded and the thread is idle — an
 * open popover over an empty list would swallow Enter, and running research
 * turns disable runtime commands (docs/adr/0003).
 */
export function slashMenuEnabled(
  commands: readonly CommandDescriptor[] | null,
  isRunning: boolean,
): boolean {
  return commands !== null && commands.length > 0 && !isRunning;
}

export interface RuntimeSlashMenu {
  /** Mount the "/" trigger only when true (see `slashMenuEnabled`). */
  enabled: boolean;
  adapter: ReturnType<typeof unstable_useSlashCommandAdapter>["adapter"];
  action: ReturnType<typeof unstable_useSlashCommandAdapter>["action"];
}

/**
 * Runtime slash commands (docs/adr/0003), ready for a composer's
 * `Unstable_TriggerPopover`. Maps the runtime command catalog to assistant-ui
 * slash items and builds the slash adapter; picking a command appends its
 * invocation text ("/status", …) as a user message via the thread runtime (not
 * the composer draft), so a partially typed draft is preserved, and
 * `removeOnExecute` strips the "/cmd" token the user typed. `enabled` tells the
 * app whether to mount the trigger at all. The unstable assistant-ui adapter
 * knowledge lives here, not in each app.
 */
export function useRuntimeSlashMenu(): RuntimeSlashMenu {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  // A run finishing is exactly when a runtime that only knows its commands once
  // warm (the dsh harness child — docs/adr/0011) can report them, so the catalog
  // is re-read on that edge rather than only on mount.
  const commands = useRuntimeCommands(isRunning);
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
  const slash = unstable_useSlashCommandAdapter({ commands: items, removeOnExecute: true });
  return { enabled: slashMenuEnabled(commands, isRunning), adapter: slash.adapter, action: slash.action };
}
