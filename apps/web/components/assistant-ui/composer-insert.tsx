"use client";

/**
 * Cross-pane seam: the center structure preview appends text to the composer in
 * the left conversation pane.
 *
 * A React context is the seam (same shape as `WorkspaceOpenProvider`) because
 * the two panes are siblings — the preview cannot import the composer element.
 * The provider sits inside `AssistantRuntimeProvider`, where assistant-ui's
 * `useAui()` resolves the thread's composer; a consumer outside a session gets
 * `null` and simply does nothing.
 */

import {
  createContext,
  useCallback,
  useContext,
  type FC,
  type PropsWithChildren,
} from "react";
import { useAui } from "@assistant-ui/react";

/** Append `text` to the composer draft (never overwrites what the user typed). */
export type ComposerInsertHandler = (text: string) => void;

const ComposerInsertContext = createContext<ComposerInsertHandler | null>(null);

export const ComposerInsertProvider: FC<PropsWithChildren> = ({ children }) => {
  const aui = useAui();

  const insert = useCallback<ComposerInsertHandler>(
    (text) => {
      const existing = aui.composer.getState().text;
      const trimmed = existing.trimEnd();
      aui.composer.setText(trimmed ? `${trimmed} ${text}` : text);
    },
    [aui],
  );

  return <ComposerInsertContext.Provider value={insert}>{children}</ComposerInsertContext.Provider>;
};

/** The composer-insert handler, or `null` when there is no session runtime. */
export function useComposerInsert(): ComposerInsertHandler | null {
  return useContext(ComposerInsertContext);
}
