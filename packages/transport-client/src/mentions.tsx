"use client";

/**
 * `@` mentions over the session workspace.
 *
 * Reuses assistant-ui's mention mechanism rather than re-inventing a picker:
 * `unstable_useMentionAdapter` builds the trigger adapter AND the directive
 * formatter, so an inserted mention is serialized to text the wire already
 * understands (`:file[label]{name=id}` / `:directory[...]`) and the service's
 * `parseWorkspaceMentions` turns it back into an `AttachmentRef`.
 *
 * The listing is one directory at a time (the same `useWorkspaceBrowser` the
 * panel uses); a mention inserts a reference, never the file's contents.
 */
import { useMemo } from "react";
import { unstable_useMentionAdapter, type Unstable_Mention } from "@assistant-ui/react";
import { useWorkspaceBrowser, type WorkspaceBrowser } from "./workspace.js";

type MentionBundle = ReturnType<typeof unstable_useMentionAdapter>;

export interface WorkspaceMentions {
  /** Spread onto `ComposerPrimitive.Unstable_TriggerPopover char="@"`. */
  adapter: MentionBundle["adapter"];
  /** `{ formatter, onInserted }` for `TriggerPopover.Directive`. */
  directive: MentionBundle["directive"];
  /** Mount the trigger only when the listing has something to offer. */
  enabled: boolean;
  /** The directory currently listed. */
  path: string;
  navigate: WorkspaceBrowser["navigate"];
  refresh: WorkspaceBrowser["refresh"];
  isLoading: boolean;
  error: string | null;
}

export function useWorkspaceMentions(
  opts: { threadId?: string | null; initialPath?: string } = {},
): WorkspaceMentions {
  const browser = useWorkspaceBrowser({
    threadId: opts.threadId ?? null,
    ...(opts.initialPath !== undefined ? { initialPath: opts.initialPath } : {}),
  });

  const items = useMemo<Unstable_Mention[]>(
    () =>
      (browser.listing?.entries ?? []).map((entry) => ({
        id: entry.path,
        // The directive type drives the server-side lift: `directory` mentions
        // stay references and never get a preview chip.
        type: entry.kind === "dir" ? "directory" : "file",
        label: entry.name,
        description: entry.path,
      })),
    [browser.listing],
  );

  const mention = unstable_useMentionAdapter({ items });

  return {
    adapter: mention.adapter,
    directive: mention.directive,
    enabled: items.length > 0,
    path: browser.path,
    navigate: browser.navigate,
    refresh: browser.refresh,
    isLoading: browser.isLoading,
    error: browser.error,
  };
}
