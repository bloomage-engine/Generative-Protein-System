"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MsaGrid,
  MsaResultTable,
  UnalignedList,
  formatMsaMention,
  msaMentionKey,
  parseAlignment,
  type MsaTarget,
} from "@science-studio/msa-viewer";
import { useWorkspaceApi, workspaceFileUrl } from "@science-studio/transport-client";
import { useComposerInsert } from "@/components/assistant-ui/composer-insert";
import { useStudioStore } from "@/store/studio-store";
import { PlainTextRenderer } from "./PlainTextRenderer";

/**
 * The MSA preview: fetches the file's own bytes (like the other specialist viewers —
 * the text hook would double-download, and the server may serve these as
 * `application/octet-stream`, which `useWorkspaceFile` classifies as binary),
 * parses them with `@science-studio/msa-viewer`, and routes:
 *   aligned  → MsaGrid · unaligned → UnalignedList · mmseqs → MsaResultTable
 * Parse failure and an oversized file fall back to plain text — never a blank pane.
 *
 * A double-click / "insert" toggles `@<project>/<path>/<seqName>@<col>[-<col>]` in
 * the composer through the existing seam (a plain-text mention, exactly like structure
 * mentions).
 */

type FetchState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

/** The viewer reads the file into memory as one string; past this it points at the download. */
const VIEWER_MAX_BYTES = 64 * 1024 * 1024;

function friendlyError(status: number): string {
  if (status === 404) return "This file no longer exists in the workspace.";
  if (status === 503) return "The workspace is not available in this deployment.";
  return `The workspace answered HTTP ${status}; the alignment could not be loaded.`;
}

const TOO_BIG = `This alignment is larger than the ${Math.round(
  VIEWER_MAX_BYTES / (1024 * 1024),
)} MB the viewer reads into memory — use the download link above instead.`;

/**
 * Read the alignment text. The inline route caps its body (413) to protect the
 * ordinary preview path, but an alignment viewer legitimately wants the whole
 * file — a real ColabFold a3m easily passes the cap — so a 413 is retried on the
 * streaming `download=1` variant, up to a viewer ceiling. Aborting (a tab switch,
 * a StrictMode remount) cancels the request instead of leaving a large download
 * running.
 */
async function fetchAlignmentText(
  api: string,
  path: string,
  project: string | null,
  worktree: string | null,
  signal: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const attempt = (download: boolean): Promise<Response> =>
    fetch(
      workspaceFileUrl(api, path, download ? { download: true, project, worktree } : { project, worktree }),
      { signal },
    );
  let res = await attempt(false);
  if (res.status === 413) res = await attempt(true); // over the inline cap: stream it
  if (!res.ok) return { ok: false, message: friendlyError(res.status) };
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > VIEWER_MAX_BYTES) return { ok: false, message: TOO_BIG };
  return { ok: true, text: new TextDecoder("utf-8").decode(await res.arrayBuffer()) };
}

export function MsaRenderer({ path, name }: { path: string; name: string }) {
  const { api, project, worktree } = useWorkspaceApi();
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    setShowRaw(false);
    void (async () => {
      try {
        const result = await fetchAlignmentText(api, path, project, worktree, controller.signal);
        if (controller.signal.aborted) return;
        setState(result.ok ? { status: "ready", text: result.text } : { status: "error", message: result.message });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => controller.abort();
  }, [api, path, project, worktree]);

  const parsed = useMemo(() => {
    if (state.status !== "ready") return null;
    try {
      return { ok: true as const, value: parseAlignment(state.text) };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  }, [state]);

  // Double-click / "insert" toggles the mention on the existing seam (a second
  // activation of the same target REMOVES it — the provider tracks it by key).
  const composer = useComposerInsert();
  const revealLeftView = useStudioStore((s) => s.revealLeftView);
  const onMention = useCallback(
    (target: MsaTarget) => {
      if (!composer) return;
      const key = `${project ?? ""}/${path}::${msaMentionKey(target)}`;
      composer.toggleMention(key, formatMsaMention(project ?? "", path, target));
      revealLeftView("thread");
    },
    [composer, project, path, revealLeftView],
  );

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="p-4 text-sm text-destructive" role="alert">
        <p>{state.message}</p>
        <p className="mt-1 text-muted-foreground">
          <code>{name}</code> at <code>/{path}</code> could not be loaded or rendered.
        </p>
      </div>
    );
  }

  const text = state.text;

  if (parsed !== null && !parsed.ok) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border/70 px-3 py-2" role="alert">
          <p className="text-sm text-destructive">Could not render {name} as an alignment: {parsed.message}</p>
          <button
            type="button"
            className="mt-2 rounded px-2 py-1 text-xs bg-accent hover:bg-accent/70"
            onClick={() => setShowRaw(true)}
          >
            Open as plain text
          </button>
        </div>
        {showRaw && (
          <div className="min-h-0 flex-1 overflow-auto">
            <PlainTextRenderer content={text} />
          </div>
        )}
      </div>
    );
  }

  const value = parsed?.ok ? parsed.value : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5">
        <span className="text-xs text-muted-foreground">alignment viewer</span>
        <button
          type="button"
          className="ml-auto rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? "Back to viewer" : "Raw text"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {showRaw ? (
          <div className="h-full overflow-auto">
            <PlainTextRenderer content={text} />
          </div>
        ) : value === null ? (
          <p className="p-4 text-sm text-muted-foreground">Nothing to show.</p>
        ) : value.kind === "aligned" ? (
          <MsaGrid data={value} onMention={onMention} />
        ) : value.kind === "unaligned" ? (
          <UnalignedList data={value} onMention={onMention} />
        ) : (
          <MsaResultTable data={value} />
        )}
      </div>
    </div>
  );
}
