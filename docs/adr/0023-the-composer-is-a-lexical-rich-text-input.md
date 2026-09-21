# The composer is a Lexical rich-text input

The workbench composer input is assistant-ui's Lexical editor
(`LexicalComposerInput` from `@assistant-ui/react-lexical`) instead of the
plain `<textarea>`. A workspace `@` mention renders inline as an icon+name
chip; the underlying directive text (`:file[…]` / `:directory[…]`) is still
what the node serializes and what the wire carries.

- **Status**: accepted
- **Context**: the `@` picker inserted assistant-ui directive text straight
  into a `<textarea>`, so the composer showed the raw grammar
  (`:directory[.science-studio]{name=.science-studio}`) rather than the picked
  file. Two constraints collided. The service identifies an attachment by
  parsing that exact text (`parseWorkspaceMentions`), so the visible form cannot
  simply replace the wire form. And an overlay that paints different-width chips
  over a transparent textarea misaligns: the raw text still occupies its own
  width, so a caret after the first chip lands on the wrong character. Inline
  chips therefore need a real rich-text editor, where a chip is an atomic node.
  assistant-ui ships exactly that boundary: `@assistant-ui/react-lexical`'s
  `LexicalComposerInput`, whose `DirectiveNode.getTextContent()` returns the
  directive syntax (the plain-text roundtrip) and whose `directiveChip` render
  prop is the chip. While there, the picker could finally BROWSE: directories
  were listed from the root only, and a directory pick inserted a reference
  instead of descending.
- **Decisions**:
  - **Adopt the official Lexical composer.** `@assistant-ui/react-lexical` +
    `lexical` (^0.49); `@assistant-ui/react` moved to `0.15.21` so its
    `core ^0.3.20` (the peer the Lexical package needs) dedupes to a single
    copy. The composer is a client component, so nothing server-side changes.
  - **Chips are display-only.** `directiveChip` renders folder/file icon +
    label from `{ directiveType, label }`; the directive text remains the
    node's content, so the wire, `parseWorkspaceMentions`, the optimistic-send
    fingerprint and the service lift are untouched.
  - **Directories navigate; only files insert.** The `@` trigger is a
    `TriggerPopover.Action`, deliberately not `.Directive`: the Lexical
    `DirectivePlugin` wires a directive trigger and owns the trigger's single
    `registerSelectItemOverride` slot, while an action trigger leaves that slot
    to a small override that walks into a picked directory. `useWorkspaceMentions`
    gained `{ withParent: true }` (a synthetic `..` typed `directory`) and the
    picker shows a breadcrumb. The directive insertion for files still happens
    (Action keeps the audit-trail text) and the SyncPlugin turns it into chips.
  - **The package's missing stylesheet is supplied by the app.** `globals.css`
    gains `.aui-lexical-editor` / `.aui-lexical-input` / `.aui-lexical-placeholder`
    rules; the wrapper keeps the old Tailwind sizing.
- **Consequences**: a new client dependency and a larger first-load bundle
  (Lexical). Composer tests that drove a `textarea.aui-composer-input` now drive
  `.aui-lexical-input` (`fill`/`press` work on `[contenteditable]`); a new web
  regression (`test/composer-mentions.test.mjs`) pins directory navigation, the
  inline chip, and that the SENT body still carries the nested directive.
  `useWorkspaceMentions`'s `withParent` is opt-in: a consumer that does not
  intercept directory selection would serialize `..` as an empty-id directive.
