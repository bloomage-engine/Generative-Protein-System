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
 * The typewriter reveal is TUNED here, not per app: the runtime delivers
 * tokens in bursts (the harness forwards a cluster per socket read, then the
 * model pauses), and the default options let `useSmooth` drain a whole burst
 * within its window with no per-frame cap — so a burst above ~40 chars painted
 * as one visible gulp. `maxCharsPerFrame` is the hard cap that keeps every
 * frame's reveal small; `drainMs` stretches a burst over a longer, even ramp.
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
        drainMs: 600,          // Spread a burst over ~0.6s instead of ~0.3s
        maxCharIntervalMs: 8,  // Slowest reveal when the backlog is short (~125 chars/s)
        maxCharsPerFrame: 4,   // Hard cap: a burst can never gulp 100+ chars in one frame
        minCommitMs: 16,       // Commit at most once per frame (60fps)
      }}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
