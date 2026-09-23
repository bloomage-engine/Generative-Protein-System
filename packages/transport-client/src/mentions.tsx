"use client";

/**
 * `@` mentions over a Project's workspace.
 *
 * Reuses assistant-ui's mention mechanism rather than re-inventing a picker:
 * `unstable_useMentionAdapter` builds the trigger adapter AND the directive
 * formatter, so an inserted mention is serialized to text the wire already
 * understands (`:file[label]{name=id}` / `:directory[...]`) and the service's
 * `parseWorkspaceMentions` turns it back into an `AttachmentRef`.
 *
 * The listing is one directory at a time (the same `useWorkspaceBrowser` the
 * panel uses); a mention inserts a reference, never the file's contents.
 *
 * `withParent` prepends a synthetic `..` entry so a picker can walk UP a level
 * as well as down. It is typed `directory` with the parent path as its id, so a
 * consumer's selection override routes it through the same navigate branch as a
 * real directory. It is opt-in: a consumer that does NOT intercept directory
 * selection would serialize `..` as an (empty-id) directive.
 */
import { useMemo } from "react";
import { unstable_useMentionAdapter, type Unstable_Mention } from "@assistant-ui/react";
import {
  useWorkspaceBrowser,
  workspaceParentPath,
  type WorkspaceBrowser,
} from "./workspace.js";

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
  opts: {
    project?: string | null;
    worktree?: string | null;
    initialPath?: string;
    withParent?: boolean;
  } = {},
): WorkspaceMentions {
  const browser = useWorkspaceBrowser({
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
    ...(opts.initialPath !== undefined ? { initialPath: opts.initialPath } : {}),
  });
  const withParent = opts.withParent ?? false;

  const items = useMemo<Unstable_Mention[]>(() => {
    const entries = (browser.listing?.entries ?? []).map((entry) => ({
      id: entry.path,
      // The directive type drives the server-side lift: `directory` mentions
      // stay references and never get a preview chip.
      type: entry.kind === "dir" ? "directory" : "file",
      label: entry.name,
      description: entry.path,
    }));
    if (!withParent || browser.path === "") return entries;
    const parent = workspaceParentPath(browser.path);
    return [
      // A synthetic `..` that walks UP one level. Its id is the parent path and
      // its type stays `directory`, so a selection override routes it through
      // the same navigation branch as a real directory.
      { id: parent, type: "directory", label: "..", description: parent || "/" },
      ...entries,
    ];
  }, [browser.listing, browser.path, withParent]);

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
