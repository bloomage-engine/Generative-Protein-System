"use client";

import dynamic from "next/dynamic";
import { Download, FileX, Loader2, X } from "lucide-react";
import {
  useWorkspaceApi,
  useWorkspaceFile,
  workspaceFileUrl,
} from "@science-studio/transport-client";
import { isStructureFile } from "@science-studio/molql-viewer/formats";
import { Button } from "@/components/ui/button";
import { kindFor, languageFor } from "./file-utils";
import { MarkdownRenderer } from "./renderers/MarkdownRenderer";
import { CodeRenderer } from "./renderers/CodeRenderer";
import { JsonRenderer } from "./renderers/JsonRenderer";
import { PlainTextRenderer } from "./renderers/PlainTextRenderer";
import { useStudioStore } from "@/store/studio-store";

/** Mol* is browser-only, so the structure renderer loads lazily (no SSR). */
const StructureRenderer = dynamic(
  () => import("./renderers/StructureRenderer").then((m) => m.StructureRenderer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground size-4 animate-spin" />
      </div>
    ),
  },
);

export function FilePreviewPane() {
  const tabs = useStudioStore((s) => s.tabs);
  const activeTabPath = useStudioStore((s) => s.activeTabPath);
  const tab = tabs.find((t) => t.path === activeTabPath) ?? null;

  if (!tab) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <FileX className="h-8 w-8 opacity-40" />
        <div>Open a file from the tree to preview</div>
        <div className="text-xs opacity-70">Or pick one from the top-bar search.</div>
      </div>
    );
  }

  return <Preview path={tab.path} name={tab.name} />;
}

function Preview({ path, name }: { path: string; name: string }) {
  const { api, project } = useWorkspaceApi();
  const closeTab = useStudioStore((s) => s.closeTab);
  const downloadUrl = workspaceFileUrl(api, path, { download: true, project });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={path}>
          /{path}
        </span>
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
      <div className="min-h-0 flex-1 overflow-hidden">
        {isStructureFile(name) ? (
          <StructureRenderer path={path} name={name} />
        ) : (
          <TextPreview path={path} name={name} />
        )}
      </div>
    </div>
  );
}

function TextPreview({ path, name }: { path: string; name: string }) {
  const { text, mime, isLoading, error } = useWorkspaceFile(path);
  const kind = kindFor(name, mime);
  const language = kind === "code" ? languageFor(name, kind) : undefined;

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
