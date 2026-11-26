# Source View Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a source view toggle to the file preview pane so users can view and edit the raw content of markdown, JSON, code, and text files.

**Architecture:** The `Preview` component gains `sourceView` state and renders toggle/save buttons in its header. `TextPreview` accepts a `sourceView` prop and renders an editable `<textarea>` when true. A new `isTextEditable` helper determines which file kinds support source view.

**Tech Stack:** React, lucide-react icons, existing `uploadWorkspaceFile` from `@gps/transport-client`

## Global Constraints

- Files to modify: `apps/web/components/studio/file-preview-pane.tsx`, `apps/web/components/studio/file-utils.ts`
- Icons from `lucide-react` (already a dependency)
- Save uses `uploadWorkspaceFile` from `@gps/transport-client` (already exported)
- No new dependencies
- Follow existing code style (no comments unless asked)

---

### Task 1: Add `isTextEditable` helper to file-utils

**Files:**
- Modify: `apps/web/components/studio/file-utils.ts`
- Test: `apps/web/test/file-kinds.test.mjs` (extend existing)

**Interfaces:**
- Produces: `isTextEditable(name: string): boolean` — returns true for markdown, JSON, code, and text files; false for PDF, structure, and cron tasks

- [ ] **Step 1: Read the existing file-utils.ts to understand the pattern**

Read `apps/web/components/studio/file-utils.ts` — note `kindFor`, `isPdfFile`, `isSubagentTab` patterns.

- [ ] **Step 2: Add `isTextEditable` function**

Add after the existing `isSubagentTab` / `subagentTabChildId` functions:

```typescript
/** True when the file is text-based and can be viewed/edited in source mode. */
export function isTextEditable(name: string): boolean {
  const kind = kindFor(name);
  return kind !== "pdf" && kind !== "structure";
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc -b --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: no new errors (or only pre-existing ones)

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/studio/file-utils.ts
git commit -m "feat: add isTextEditable helper to file-utils"
```

---

### Task 2: Add source view state and header buttons to `Preview`

**Files:**
- Modify: `apps/web/components/studio/file-preview-pane.tsx` (Preview component, lines 155-199)

**Interfaces:**
- Consumes: `isTextEditable` from Task 1
- Produces: `sourceView` boolean state passed to `TextPreview`; header renders toggle + save buttons

- [ ] **Step 1: Add imports**

Add `Code` and `Save` to the lucide-react import, and `isTextEditable` to the file-utils import:

```typescript
import { Code, Download, FileX, Loader2, Save, X } from "lucide-react";
```

```typescript
import { isSubagentTab, isTextEditable, kindFor, languageFor, subagentTabChildId } from "./file-utils";
```

- [ ] **Step 2: Add source view state and save handler to `Preview`**

Inside the `Preview` function, add state and the save handler before the return:

```typescript
const [sourceView, setSourceView] = useState(false);
const [editedText, setEditedText] = useState<string | null>(null);
const [dirty, setDirty] = useState(false);
const [saving, setSaving] = useState(false);

const canToggleSource = isTextEditable(name);

const handleSave = useCallback(async () => {
  if (editedText == null) return;
  setSaving(true);
  try {
    await uploadWorkspaceFile(api, path, new Blob([editedText]), project);
    setDirty(false);
  } finally {
    setSaving(false);
  }
}, [api, editedText, path, project]);
```

Add the required imports at the top of the file:

```typescript
import { useCallback, useState } from "react";
```

And add `uploadWorkspaceFile` to the `@gps/transport-client` import:

```typescript
import {
  isCronTaskPath,
  useSubagentTranscript,
  useTransportApi,
  useWorkspaceApi,
  useWorkspaceFile,
  uploadWorkspaceFile,
  workspaceFileUrl,
} from "@gps/transport-client";
```

- [ ] **Step 3: Render toggle and save buttons in the header**

Replace the header section in `Preview` (between the `<header>` open tag and the download `<a>` tag) to add the new buttons. The full header becomes:

```tsx
<header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
  <span className="min-w-0 flex-1 truncate text-xs font-medium" title={path}>
    /{path}
  </span>
  {canToggleSource && (
    <Button
      variant={sourceView ? "secondary" : "ghost"}
      size="icon-xs"
      className="h-6 w-6"
      onClick={() => {
        setSourceView((v) => !v);
        if (sourceView) {
          setEditedText(null);
          setDirty(false);
        }
      }}
      aria-label={sourceView ? "Show rendered view" : "Show source"}
    >
      <Code className="size-3.5" />
    </Button>
  )}
  {sourceView && dirty && (
    <Button
      variant="ghost"
      size="icon-xs"
      className="h-6 w-6"
      onClick={handleSave}
      disabled={saving}
      aria-label="Save file"
    >
      {saving ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Save className="size-3.5" />
      )}
    </Button>
  )}
  <a
    href={downloadUrl}
    aria-label="Download"
    download
    className="text-muted-foreground hover:text-foreground rounded p-1"
  >
    <Download className="size-4" />
  </a>
  <Button
    variant="ghost"
    size="icon-xs"
    className="h-6 w-6"
    onClick={() => closeTab(path)}
    aria-label="Close file"
  >
    <X className="size-3.5" />
  </Button>
</header>
```

- [ ] **Step 4: Pass source view props to TextPreview**

Update the `TextPreview` rendering to pass the new props:

```tsx
<TextPreview
  path={path}
  name={name}
  sourceView={sourceView}
  onEditedTextChange={setEditedText}
  onDirtyChange={setDirty}
/>
```

- [ ] **Step 5: Verify type-check passes**

Run: `npx tsc -b --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: no new errors (TextPreview doesn't accept these props yet, so expect errors here — they'll be fixed in Task 3)

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/studio/file-preview-pane.tsx
git commit -m "feat: add source view toggle and save buttons to Preview header"
```

---

### Task 3: Implement source view textarea in TextPreview

**Files:**
- Modify: `apps/web/components/studio/file-preview-pane.tsx` (TextPreview component, lines 201-232)

**Interfaces:**
- Consumes: `sourceView`, `onEditedTextChange`, `onDirtyChange` from Task 2
- Produces: editable textarea when `sourceView=true`; existing renderers when false

- [ ] **Step 1: Update TextPreview signature and add state**

Replace the `TextPreview` function with:

```typescript
function TextPreview({
  path,
  name,
  sourceView,
  onEditedTextChange,
  onDirtyChange,
}: {
  path: string;
  name: string;
  sourceView: boolean;
  onEditedTextChange: (text: string | null) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { text, mime, isLoading, error } = useWorkspaceFile(path);
  const kind = kindFor(name, mime);
  const language = kind === "code" ? languageFor(name, kind) : undefined;

  const [editedText, setEditedText] = useState<string>("");

  // Sync editedText when source view opens or text loads
  const prevSourceView = useRef(sourceView);
  useEffect(() => {
    if (sourceView && !prevSourceView.current) {
      // Entering source view — initialize from loaded text
      const initial = text ?? "";
      setEditedText(initial);
      onEditedTextChange(initial);
      onDirtyChange(false);
    }
    prevSourceView.current = sourceView;
  }, [sourceView, text, onEditedTextChange, onDirtyChange]);

  // Reset when text changes externally (e.g. re-fetch after save)
  useEffect(() => {
    if (!sourceView && text != null) {
      setEditedText(text);
      onEditedTextChange(text);
    }
  }, [text, sourceView, onEditedTextChange]);

  if (sourceView) {
    return (
      <textarea
        className="h-full w-full resize-none bg-background p-4 font-mono text-sm whitespace-pre"
        value={editedText}
        onChange={(e) => {
          const val = e.target.value;
          setEditedText(val);
          onEditedTextChange(val);
          onDirtyChange(val !== (text ?? ""));
        }}
        spellCheck={false}
      />
    );
  }

  return (
    <>
      {isLoading && (
        <div className="flex justify-center p-4">
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        </div>
      )}
      {error && <p className="text-destructive p-3 text-xs">{error}</p>}
      {!isLoading &&
        !error &&
        (text == null ? (
          <p className="text-muted-foreground p-4 text-sm">
            {mime ?? "Binary file"} — preview is not available. Use download.
          </p>
        ) : kind === "markdown" ? (
          <MarkdownRenderer content={text} />
        ) : kind === "json" ? (
          <JsonRenderer content={text} />
        ) : kind === "code" && language ? (
          <CodeRenderer content={text} language={language} />
        ) : (
          <PlainTextRenderer content={text} />
        ))}
    </>
  );
}
```

Add the `useRef` import:

```typescript
import { useCallback, useRef, useState } from "react";
```

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc -b --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: no new errors

- [ ] **Step 3: Verify the full component renders correctly**

Run: `npm run dev -w @gps/web` and open a markdown file in the preview pane. Verify:
- Toggle button appears in header
- Clicking toggle shows textarea with raw markdown
- Editing text makes save button appear
- Clicking save persists the change
- Clicking toggle again discards unsaved changes and shows rendered view

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/studio/file-preview-pane.tsx
git commit -m "feat: implement source view textarea in TextPreview"
```

---

### Task 4: Verify end-to-end and clean up

- [ ] **Step 1: Run type-check on the full web app**

Run: `npx tsc -b --noEmit -p apps/web/tsconfig.json`
Expected: no errors

- [ ] **Step 2: Run existing tests**

Run: `npm run test:e2e -w @gps/web` (if Chromium available)
Expected: existing tests pass (file-kinds, tab-state, etc.)

- [ ] **Step 3: Manual verification**

Test with each file type:
- Markdown file: toggle → edit → save → toggle back → verify rendered content updated
- JSON file: toggle → edit → save → verify
- Code file (.ts/.py): toggle → edit → save → verify
- Plain text file: toggle → edit → save → verify
- PDF file: no toggle button
- Structure file (.pdb): no toggle button
- Cron task file: no toggle button

- [ ] **Step 4: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore: source view editor cleanup"
```
