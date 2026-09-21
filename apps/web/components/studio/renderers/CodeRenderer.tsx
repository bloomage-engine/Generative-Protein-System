"use client";

import * as React from "react";
import type { BundledLanguage } from "shiki";
import { useTheme } from "next-themes";
import { highlightToHtml } from "./highlight";

/**
 * A stand-alone code file: shiki-highlighted through the shared
 * `highlight.ts` instance (the same one MarkdownRenderer's fenced blocks use),
 * plain `<pre>` when the highlighter cannot load.
 */
export function CodeRenderer({
  content,
  language,
}: {
  content: string;
  language: BundledLanguage;
}) {
  const [html, setHtml] = React.useState<string>("");
  const [error, setError] = React.useState(false);
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  React.useEffect(() => {
    let alive = true;
    highlightToHtml(content, language, dark)
      .then((out) => {
        if (alive) setHtml(out);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [content, language, dark]);

  if (error) {
    return (
      <pre className="flex-1 overflow-auto p-4 font-mono text-sm text-foreground">{content}</pre>
    );
  }

  return (
    <div
      className="flex-1 overflow-auto p-4 text-sm"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
