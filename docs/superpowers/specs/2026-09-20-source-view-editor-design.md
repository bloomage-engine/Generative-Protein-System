# Source View Editor for File Preview

## Summary

Add a source view toggle to the file preview pane so users can view and edit the raw content of markdown, JSON, code, and text files. A toggle button in the header switches between the rendered view and an editable textarea; a save button persists changes back to the workspace.

## Motivation

Currently the file preview pane is strictly read-only. For markdown files there is no way to see or edit the raw source. For code files the syntax-highlighted view is not editable. Users need a quick way to inspect and make small edits to workspace files without leaving the workbench.

## Scope

**In scope:**
- Source view toggle button in the preview header (next to download button)
- Editable textarea for text-based files (markdown, JSON, code, plain text)
- Save button that writes changes back to the workspace via `uploadWorkspaceFile`
- Dirty tracking: save button only appears when content has been modified

**Out of scope:**
- PDF files (no source view — binary)
- Structure files (PDB/CIF — no source view toggle; 3D viewer only)
- Cron task files (already have their own editor UI)
- Subagent transcript tabs (not workspace files)
- Syntax highlighting in the source editor (plain textarea is sufficient)
- Line numbers, minimap, or other code editor features
- Undo/redo beyond browser textarea native behavior
- Conflict detection / concurrent edit handling

## Design

### Components affected

| Component | Change |
|-----------|--------|
| `Preview` | Add `sourceView` state; render toggle + save buttons in header |
| `TextPreview` | Accept `sourceView` prop; render textarea when true |
| `file-utils.ts` | Add `isTextEditable(name)` helper to determine if a file supports source view |

### Header controls (`Preview`)

The header row currently shows: path — download link — close button.

New layout: `path` — `source toggle` — `download` — `close`

- **Source toggle button**: `Code` icon from lucide-react. Only rendered for files where `isTextEditable(name)` returns true (markdown, JSON, code, text — i.e. everything that goes through `TextPreview`). Toggles the `sourceView` boolean state. Active state indicated by a visual highlight (e.g. `bg-accent`).
- **Save button**: `Save` icon from lucide-react. Only rendered when `sourceView=true` and the edited content differs from the original. Calls `uploadWorkspaceFile` on click.

### `isTextEditable(name)` helper

Returns true when the file kind is NOT `"pdf"`, NOT `"structure"`, and NOT a cron task path. This covers markdown, JSON, code, and plain text — all files dispatched to `TextPreview`.

### `TextPreview` changes

New prop: `sourceView: boolean`.

Internal state:
- `editedText: string | null` — initialized to the fetched `text` value when it arrives
- `dirty: boolean` — true when `editedText !== text`

When `sourceView=false`: render existing output (MarkdownRenderer / CodeRenderer / JsonRenderer / PlainTextRenderer) unchanged.

When `sourceView=true`: render a `<textarea>` with:
- `className="h-full w-full resize-none bg-background p-4 font-mono text-sm whitespace-pre"` 
- `value={editedText ?? ""}`
- `onChange` updates `editedText` and sets `dirty=true`

When `text` loads (initial fetch or re-fetch), initialize `editedText` to it.

### Save flow

1. User clicks save button
2. `Preview` calls `uploadWorkspaceFile(api, path, new Blob([editedText]), project)`
3. On success: update the local `text` reference (so the rendered view reflects edits), set `dirty=false`
4. On error: show error via the existing error display pattern (toast or inline)

The save operation does NOT automatically toggle back to rendered view — the user stays in source view to continue editing. They can manually toggle back.

### Toggle behavior

- Toggling from source → rendered: discards unsaved changes (no confirmation — the workspace file is unchanged, so nothing is lost)
- Toggling from rendered → source: initializes `editedText` from current `text`

### Files not supporting source view

For PDF, structure, and cron task files, the source toggle button is not rendered. The header stays as-is (path — download — close).

## Testing

- Unit: `isTextEditable` helper returns correct values for each file kind
- Component: `TextPreview` renders textarea in source mode, renderers in normal mode
- Integration: save button appears only when dirty, save calls upload, toggle discards unsaved changes

## Open questions

None — design is settled.
