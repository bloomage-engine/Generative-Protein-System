import "@assistant-ui/react-markdown/styles/dot.css";

import { useIsMarkdownCodeBlock } from "@assistant-ui/react-markdown";
import type { TextMessagePartProps } from "@assistant-ui/react";
import { type FC } from "react";
import {
  MarkdownText as BaseMarkdownText,
  type MarkdownComponents,
} from "@science-studio/transport-client";

/**
 * Markdown renderer for assistant text parts — a plain-CSS skin over the
 * shared mechanism (`BaseMarkdownText` from
 * `@science-studio/transport-client`, built on
 * `@assistant-ui/react-markdown`'s `MarkdownTextPrimitive`): GitHub-flavored
 * markdown, shallow-stable component maps, and the streaming caret
 * (`styles/dot.css`) on the trailing content while the part is `running`.
 * This file only styles each element with the example's plain CSS classes.
 */

type MarkdownTextProps = Partial<TextMessagePartProps>;

const defaultComponents: MarkdownComponents = {
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
};

/** The styled text renderer used by the message parts map. */
export const MarkdownText: FC<MarkdownTextProps> = (props) => (
  <BaseMarkdownText components={defaultComponents} {...props} />
);
