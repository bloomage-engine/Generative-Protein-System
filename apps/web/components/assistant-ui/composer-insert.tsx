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
 *
 * `toggleMention` tracks the text it appended by key, so a second click on the
 * same selection REMOVES the mention instead of appending it again. The
 * registry lives here (above the preview pane) so it survives the viewer
 * remounting on a file switch.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type FC,
  type PropsWithChildren,
} from "react";
import { useAui } from "@assistant-ui/react";

export interface ComposerInsert {
  /** Append `text` to the composer draft (never overwrites what the user typed). */
  insertText: (text: string) => void;
  /**
   * Append `mention` for `key`, or remove the mention previously appended for
   * that key. Each key tracks exactly one mention.
   */
  toggleMention: (key: string, mention: string) => void;
  /** Remove every mention this seam appended (e.g. Mol* cleared the selection). */
  clearMentions: () => void;
}

const ComposerInsertContext = createContext<ComposerInsert | null>(null);

export const ComposerInsertProvider: FC<PropsWithChildren> = ({ children }) => {
  const aui = useAui();
  const mentionsRef = useRef<Map<string, string>>(new Map());

  const insertText = useCallback(
    (text: string) => {
      const existing = aui.composer.getState().text;
      const trimmed = existing.trimEnd();
      aui.composer.setText(trimmed ? `${trimmed} ${text}` : text);
    },
    [aui],
  );

  const removeText = useCallback(
    (text: string) => {
      const existing = aui.composer.getState().text;
      if (!existing.includes(text)) return;
      aui.composer.setText(existing.split(text).join("").replace(/ {2,}/g, " ").trimEnd());
    },
    [aui],
  );

  const value = useMemo<ComposerInsert>(() => {
    const clearMentions = () => {
      for (const mention of mentionsRef.current.values()) removeText(mention);
      mentionsRef.current.clear();
    };
    return {
      insertText,
      toggleMention: (key, mention) => {
        const existing = mentionsRef.current.get(key);
        if (existing !== undefined) {
          removeText(existing);
          mentionsRef.current.delete(key);
          return;
        }
        insertText(mention);
        mentionsRef.current.set(key, mention);
      },
      clearMentions,
    };
  }, [aui, insertText, removeText]);

  return <ComposerInsertContext.Provider value={value}>{children}</ComposerInsertContext.Provider>;
};

/** The composer-insert seam, or `null` when there is no session runtime. */
export function useComposerInsert(): ComposerInsert | null {
  return useContext(ComposerInsertContext);
}
