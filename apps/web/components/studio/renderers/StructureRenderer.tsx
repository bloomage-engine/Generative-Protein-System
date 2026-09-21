"use client";

import "molstar/lib/mol-plugin-ui/skin/light.scss";

import { useCallback, useMemo, useState } from "react";
import { useWorkspaceApi, workspaceFileUrl } from "@science-studio/transport-client";
import {
  applyMolqlSelection,
  formatAtomMolql,
  formatBondMolql,
  formatInteractionMolql,
  formatResidueMolql,
  formatStructureMention,
  molqlTargetKey,
  MolqlError,
  MolqlViewerPanel,
  type MolqlTarget,
} from "@science-studio/molql-viewer";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Play, Sparkles } from "lucide-react";
import { useComposerInsert } from "@/components/assistant-ui/composer-insert";
import { useStudioStore } from "@/store/studio-store";

const EXAMPLE = "(sel.atom.chains (= atom.chain A))";

/**
 * The structure preview: a Mol* viewer over the workspace file plus a small
 * manual MolQL console. The console is the human/testing entry; in normal use
 * the agent's `molql` tool drives the same viewer through the frontend bridge.
 *
 * This module imports molstar, so the preview pane loads it dynamically with
 * `ssr: false`.
 */
export function StructureRenderer({ path, name }: { path: string; name: string }) {
  const { api, project } = useWorkspaceApi();
  const url = useMemo(
    () => workspaceFileUrl(api, path, { download: true, project }),
    [api, path, project],
  );

  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [expression, setExpression] = useState("");
  const composer = useComposerInsert();
  const revealLeftView = useStudioStore((s) => s.revealLeftView);

  // Selection-mode click → toggle `@<project>/<path>/<molql>` in the composer
  // draft (a second click on the same target removes it; an empty click — which
  // clears Mol*'s selection — removes all of them).
  const handleResidueClick = useCallback(
    (target: MolqlTarget | null) => {
      if (!composer) return;
      if (target === null) {
        composer.clearMentions();
        return;
      }
      let molql: string;
      let label: string | undefined;
      switch (target.kind) {
        case "residue":
          molql = formatResidueMolql(target.residue);
          break;
        case "atom":
          molql = formatAtomMolql(target.atom);
          break;
        case "interaction":
          molql = formatInteractionMolql(target.a, target.b);
          label = target.interactionType;
          break;
        default:
          molql = formatBondMolql(target.a, target.b);
      }
      const key = `${project ?? ""}/${path}::${molqlTargetKey(target)}`;
      composer.toggleMention(key, formatStructureMention(project, path, molql, label));
      revealLeftView("thread");
    },
    [composer, project, path, revealLeftView],
  );

  const apply = async () => {
    setError(null);
    try {
      await applyMolqlSelection(expression);
    } catch (err) {
      setError(
        err instanceof MolqlError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <MolqlViewerPanel
          fileUrl={url}
          fileName={name}
          className="h-full w-full"
          onResidueClick={handleResidueClick}
          onError={(err) => setError(err.message)}
        />
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2">
        <div className="bg-background/95 pointer-events-auto w-full max-w-lg rounded-lg border shadow-sm">
          {open ? (
            <div className="flex items-center gap-1 p-1">
              <input
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void apply();
                }}
                spellCheck={false}
                placeholder={EXAMPLE}
                aria-label="MolQL expression"
                className="border-input bg-background min-w-0 flex-1 rounded-md border px-2 py-1 font-mono text-xs outline-none focus-visible:ring-1"
              />
              <Button size="sm" onClick={() => void apply()} disabled={!expression.trim()}>
                <Play /> Apply
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-6 w-6"
                aria-label="Hide MolQL console"
                onClick={() => setOpen(false)}
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs"
            >
              <Sparkles className="size-3.5" />
              MolQL
              <ChevronUp className="size-3.5" />
            </button>
          )}
          {error && (
            <p className="text-destructive px-2 pb-1.5 text-xs" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
