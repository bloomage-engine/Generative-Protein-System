"use client";

import * as React from "react";
import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import { useTheme } from "next-themes";

let highlighterCache: Highlighter | null = null;
let loadingPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (highlighterCache) return highlighterCache;
  if (!loadingPromise) {
    loadingPromise = createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: ["python", "typescript", "javascript", "bash", "json", "markdown"],
    }).then((h) => {
      highlighterCache = h;
      return h;
    });
  }
  return loadingPromise;
}

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
    getHighlighter()
      .then((h) => {
        if (!alive) return;
        const mode = dark ? "github-dark" : "github-light";
        setHtml(h.codeToHtml(content, { lang: language, theme: mode }));
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
