import "@assistant-ui/react-markdown/styles/dot.css";

import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import type { TextMessagePartProps } from "@assistant-ui/react";
import { type FC, memo, useMemo, useRef } from "react";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for assistant text parts — a plain-CSS port of the
 * registry `MarkdownText` element (docs /elements/markdown-text), built on
 * `@assistant-ui/react-markdown`'s `MarkdownTextPrimitive`.
 *
 * `MarkdownTextPrimitive` reads the part text from its message-part context,
 * renders GitHub-flavored markdown (tables, task lists, …), and shows the
 * streaming caret (`styles/dot.css`) on the trailing content while the part
 * is `running` — the same cue the default text renderer used, so nothing is
 * lost by replacing it.
 */

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0];
};

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

const MarkdownTextImpl: FC<MarkdownTextProps> = ({ components }) => {
  const stableComponents = useShallowStable(components);
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents;
    return {
      ...defaultComponents,
      ...memoizeMarkdownComponents(stableComponents),
    };
  }, [stableComponents]);

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md"
      components={markdownComponents}
      defer
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ ...props }) => <h1 className="md-h1" {...props} />,
  h2: ({ ...props }) => <h2 className="md-h2" {...props} />,
  h3: ({ ...props }) => <h3 className="md-h3" {...props} />,
  h4: ({ ...props }) => <h4 className="md-h4" {...props} />,
  h5: ({ ...props }) => <h5 className="md-h5" {...props} />,
  h6: ({ ...props }) => <h6 className="md-h6" {...props} />,
  p: ({ ...props }) => <p className="md-p" {...props} />,
  a: ({ ...props }) => <a className="md-a" {...props} />,
  blockquote: ({ ...props }) => (
    <blockquote className="md-blockquote" {...props} />
  ),
  ul: ({ ...props }) => <ul className="md-ul" {...props} />,
  ol: ({ ...props }) => <ol className="md-ol" {...props} />,
  li: ({ ...props }) => <li className="md-li" {...props} />,
  hr: ({ ...props }) => <hr className="md-hr" {...props} />,
  table: ({ ...props }) => (
    <div className="md-table-wrap">
      <table className="md-table" {...props} />
    </div>
  ),
  pre: ({ ...props }) => <pre className="md-pre" {...props} />,
  code: function Code({ className, ...props }) {
    // `MarkdownTextPrimitive` rewrites block code so this component only
    // styles inline code; the check still guards against double styling.
    const isCodeBlock = useIsMarkdownCodeBlock();
    const cls = isCodeBlock ? "md-code-block" : "md-code-inline";
    return <code className={className ? `${cls} ${className}` : cls} {...props} />;
  },
});
