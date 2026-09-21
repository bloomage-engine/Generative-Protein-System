"use client";

import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
} from "@assistant-ui/react-markdown";
import type { TextMessagePartProps } from "@assistant-ui/react";
import { memo, useMemo, useRef, type FC } from "react";
import remarkGfm from "remark-gfm";

/**
 * The markdown mechanism every app's text renderer is built on: renders
 * `MarkdownTextPrimitive` with GitHub-flavored markdown, shallow-stable
 * component maps and the streaming caret (`defer`). Each app supplies ONLY
 * its styled component map (the skin) via `components` — the memoization
 * wiring, the plugin and the element itself live here, not in every app.
 *
 * Consumers keep `import "@assistant-ui/react-markdown/styles/dot.css"` in
 * their own file (the streaming-caret CSS is a per-bundle concern).
 */

/** An app's styled component map (keyed by markdown element). */
export type MarkdownComponents = Parameters<typeof memoizeMarkdownComponents>[0];

export interface MarkdownTextProps extends Partial<TextMessagePartProps> {
  /** The app's styled component map (skin). */
  components: MarkdownComponents;
  /** Root className; defaults to the assistant-ui markdown hook. */
  className?: string;
}

const useShallowStable = <T extends Record<string, unknown> | undefined>(
  value: T,
): T => {
  const ref = useRef(value);
  if (value !== ref.current) {
    const prev = ref.current;
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key]);
    if (!stable) ref.current = value;
  }
  return ref.current;
};

const MarkdownTextImpl: FC<MarkdownTextProps> = ({ components, className = "aui-md" }) => {
  const stableComponents = useShallowStable(components);
  const markdownComponents = useMemo(
    () => memoizeMarkdownComponents(stableComponents),
    [stableComponents],
  );

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className={className}
      components={markdownComponents}
      defer
      smooth={{
        drainMs: 300,          // Slightly longer drain time for smoother appearance
        maxCharIntervalMs: 8,  // Slower reveal when backlog is short
        minCommitMs: 16,       // Commit at most every ~1 frame (60fps)
      }}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
