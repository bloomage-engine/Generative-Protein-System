"use client";

import { createHighlighter, type BundledLanguage } from "shiki";

/**
 * The one shiki instance for the whole pane: CodeRenderer (stand-alone code
 * files) and MarkdownRenderer (fenced blocks inside markdown) both render
 * through it so a token never gets two colors.
 *
 * Only languages in `HIGHLIGHT_LANGUAGES` are preloaded; shiki hard-fails on
 * anything else, and the callers fall back to a plain `<pre>` in that case.
 */
export const HIGHLIGHT_LANGUAGES: BundledLanguage[] = [
  "python",
  "typescript",
  "javascript",
  "json",
  "bash",
  "markdown",
];

/** What `createHighlighter` resolves to (shiki's aliases drift between versions; infer). */
export type HighlighterInstance = Awaited<ReturnType<typeof createHighlighter>>;

let highlighterCache: HighlighterInstance | null = null;
let loadingPromise: Promise<HighlighterInstance> | null = null;

export function getHighlighter(): Promise<HighlighterInstance> {
  if (highlighterCache) return Promise.resolve(highlighterCache);
  if (!loadingPromise) {
    loadingPromise = createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: HIGHLIGHT_LANGUAGES,
    }).then((h) => {
      highlighterCache = h;
      return h;
    });
  }
  return loadingPromise;
}

/** Highlight `code` as `lang`; throws when `lang` is not preloaded. */
export function highlightToHtml(code: string, lang: BundledLanguage, dark: boolean) {
  return getHighlighter().then((h) =>
    h.codeToHtml(code, { lang, theme: dark ? "github-dark" : "github-light" }),
  );
}
