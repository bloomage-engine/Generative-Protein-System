"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { BundledLanguage } from "shiki";
import { useTheme } from "next-themes";
import { HIGHLIGHT_LANGUAGES, highlightToHtml } from "./highlight";

/** Flatten rendered children to their text content (code elements nest one level deep). */
function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement(node)) {
    return textOf((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/**
 * A fenced code block inside markdown, highlighted through the same shiki
 * instance as CodeRenderer. Languages the shared highlighter has not
 * preloaded render as a plain bordered `<pre>` instead of an error.
 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const known = HIGHLIGHT_LANGUAGES.includes(lang as BundledLanguage);
  const [html, setHtml] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!known) return;
    let alive = true;
    highlightToHtml(code, lang as BundledLanguage, dark)
      .then((out) => {
        if (alive) setHtml(out);
      })
      .catch(() => {
        // the highlighter could not load — stay plain
      });
    return () => {
      alive = false;
    };
  }, [code, lang, dark, known]);

  if (html) {
    return (
      <div
        className="my-4 overflow-x-auto rounded-md"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <pre className="my-4 overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-5">
      <code>{code}</code>
    </pre>
  );
}

/**
 * The markdown-file renderer: GitHub-flavored markdown typeset by the
 * Tailwind typography plugin (the `prose` styles — `@plugin
 * "@tailwindcss/typography"` in app/globals.css), fenced code highlighted by
 * the shared shiki instance in `./highlight`.
 */
export function MarkdownRenderer({ content }: { content: string }) {
  // Stable identity: react-markdown re-parses when `components` changes.
  const components: Components = React.useMemo(
    () => ({
      pre({ children }: { children?: React.ReactNode }) {
        const codeEl = React.Children.toArray(children).find(React.isValidElement);
        const className =
          codeEl && React.isValidElement(codeEl)
            ? ((codeEl.props as { className?: string }).className ?? "")
            : "";
        const match = /language-([\w+-]+)/.exec(className);
        return (
          <CodeBlock code={textOf(children).replace(/\n$/, "")} lang={match?.[1] ?? ""} />
        );
      },
    }),
    [],
  );

  return (
    <div className="flex-1 overflow-auto p-6 text-sm leading-6">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
