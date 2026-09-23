"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";
import dynamic from "next/dynamic";
import { Code, Download, FileX, Loader2, Save, X } from "lucide-react";
import {
  DEFAULT_WORKTREE_ID,
  isCronTaskPath,
  useSubagentTranscript,
  useTransportApi,
  useWorkspaceApi,
  useWorkspaceFile,
  uploadWorkspaceFile,
  workspaceFileUrl,
} from "@science-studio/transport-client";
import { isCronLogPath } from "@science-studio/cron";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isHpcJobTab, isSubagentTab, isTextEditable, kindFor, languageFor, subagentTabChildId } from "./file-utils";
import { CronTaskRenderer } from "./renderers/CronTaskRenderer";
import { HpcJobRenderer } from "./renderers/HpcJobRenderer";
import { ImageRenderer } from "./renderers/ImageRenderer";
import { MarkdownRenderer } from "./renderers/MarkdownRenderer";
import { CodeRenderer } from "./renderers/CodeRenderer";
import { JsonRenderer } from "./renderers/JsonRenderer";
import { PlainTextRenderer } from "./renderers/PlainTextRenderer";
import { TranscriptBody } from "./renderers/SubagentRenderer";
import { useStudioStore } from "@/store/studio-store";

/**
 * The PDF and structure viewers are browser-only (Canvas + WebAssembly; WebGL),
 * so they are loaded on demand in the browser and never during SSR. Their
 * file is fetched by the viewer itself from the workspace inline URL — the
 * text hook would only download the same bytes twice.
 */
const PdfRenderer = dynamic(
  () => import("./renderers/PdfRenderer").then((m) => m.PdfRenderer),
  { ssr: false, loading: () => <ViewerLoading /> },
);

const StructureRenderer = dynamic(
  () => import("./renderers/StructureRenderer").then((m) => m.StructureRenderer),
  { ssr: false, loading: () => <ViewerLoading /> },
);

const MsaRenderer = dynamic(
  () => import("./renderers/MsaRenderer").then((m) => m.MsaRenderer),
  { ssr: false, loading: () => <ViewerLoading /> },
);

function ViewerLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="text-muted-foreground size-5 animate-spin" />
    </div>
  );
}

export function FilePreviewPane() {
  const tabs = useStudioStore((s) => s.tabs);
  const activeTabPath = useStudioStore((s) => s.activeTabPath);

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <FileX className="h-8 w-8 opacity-40" />
        <div>Open a file from the tree to preview</div>
        <div className="text-xs opacity-70">Or pick one from the top-bar search.</div>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      {tabs.map((tab) => (
        <TabPanel key={tab.id} active={tab.path === activeTabPath}>
          {isSubagentTab(tab.path) ? (
            <SubagentPreview path={tab.path} name={tab.name} session={tab.session} />
          ) : isHpcJobTab(tab.path) ? (
            <HpcJobRenderer path={tab.path} name={tab.name} />
          ) : (
            <Preview path={tab.path} name={tab.name} />
          )}
        </TabPanel>
      ))}
    </div>
  );
}

/**
 * A subagent child-session tab: the child's own conversation record, fetched
 * from the TRANSPORT surface (NOT the workspace — this is not a file). It has a
 * header with a close control but no download affordance (there is nothing to
 * download). A missing/unreadable record lands in `error` and renders a
 * friendly "not available" line.
 *
 * `session` is the Session the tab was OPENED in (the record is session-scoped,
 * the tab strip is project-scoped) — a same-Project Session switch must not
 * re-fetch the record under the new, wrong session (it would 404). Falls back
 * to the live Session only for a tab that records none.
 */
function SubagentPreview({ path, name, session }: { path: string; name: string; session?: string }) {
  const { api, project, worktree } = useTransportApi();
  const activeSessionId = useStudioStore((s) => s.activeSessionId);
  const closeTab = useStudioStore((s) => s.closeTab);
  const childId = subagentTabChildId(path);
  // The child's record lives under the checkout the tab belongs to; the live
  // Worktree context is safe because a Worktree switch clears the tabs (a
  // different checkout cannot keep this tab open — docs/adr/0025).
  const { transcript, isLoading, error } = useSubagentTranscript({
    api,
    project,
    worktreeId: worktree,
    threadId: session ?? activeSessionId,
    childId,
    enabled: project !== null,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={path}>
          {name}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6"
          onClick={() => closeTab(path)}
          aria-label="Close tab"
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && (
          <div className="flex justify-center p-4">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        )}
        {!isLoading && error && (
          <p className="text-muted-foreground p-4 text-sm">
            The record for this subagent session is not available.
          </p>
        )}
        {!isLoading && !error && transcript && <TranscriptBody transcript={transcript} />}
      </div>
    </div>
  );
}

/**
 * Keeps a tab's content MOUNTED across switches so per-tab state (scroll
 * position today, any future component state) survives. Inactive panes are
 * hidden with `visibility` — NOT `display:none`, which drops the layout box and
 * can reset `scrollTop` — so their scroll containers keep their position.
 * `inert` + `aria-hidden` take the hidden pane out of focus and the a11y tree.
 */
function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn("absolute inset-0 min-h-0", !active && "invisible pointer-events-none")}
      aria-hidden={!active}
      inert={!active}
    >
      {children}
    </div>
  );
}

function Preview({ path, name }: { path: string; name: string }) {
  const { api, project, worktree } = useWorkspaceApi();
  const closeTab = useStudioStore((s) => s.closeTab);
  const kind = kindFor(name);
  // Cron is Project-`main`-only, so a run log opened as a normal file tab must
  // read the Project root, not the ACTIVE checkout (docs/adr/0025). Every other
  // file keeps the active worktree.
  const effectiveWorktree = isCronLogPath(path) ? DEFAULT_WORKTREE_ID : worktree;
  const downloadUrl = workspaceFileUrl(api, path, { download: true, project, worktree: effectiveWorktree });
  const fileUrl = workspaceFileUrl(api, path, { project, worktree: effectiveWorktree });

  const [sourceView, setSourceView] = useState(false);
  const [editedText, setEditedText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const canToggleSource = !isCronTaskPath(path) && isTextEditable(name);

  const handleSave = useCallback(async () => {
    if (editedText == null) return;
    setSaving(true);
    try {
      await uploadWorkspaceFile(api, path, new Blob([editedText]), project, effectiveWorktree);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [api, editedText, path, project, effectiveWorktree]);

  return (
    <div className="flex h-full min-h-0 flex-col">
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {isCronTaskPath(path) ? (
          <CronTaskRenderer path={path} />
        ) : kind === "pdf" ? (
          <PdfRenderer url={fileUrl} />
        ) : kind === "image" ? (
          <ImageRenderer url={fileUrl} alt={name} />
        ) : kind === "structure" ? (
          <StructureRenderer path={path} name={name} />
        ) : kind === "msa" ? (
          <MsaRenderer path={path} name={name} />
        ) : (
          <TextPreview
            path={path}
            name={name}
            worktree={effectiveWorktree}
            sourceView={sourceView}
            onEditedTextChange={setEditedText}
            onDirtyChange={setDirty}
          />
        )}
      </div>
    </div>
  );
}

/** The text preview: markdown / JSON / highlighted code / plain text. */
function TextPreview({
  path,
  name,
  worktree,
  sourceView,
  onEditedTextChange,
  onDirtyChange,
}: {
  path: string;
  name: string;
  worktree?: string | null;
  sourceView: boolean;
  onEditedTextChange: (text: string | null) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { text, mime, isLoading, error } = useWorkspaceFile(path, { worktree });
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
