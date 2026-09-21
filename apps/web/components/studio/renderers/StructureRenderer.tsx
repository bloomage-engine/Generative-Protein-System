"use client";

import "molstar/lib/mol-plugin-ui/skin/light.scss";

import { useCallback, useMemo, useState } from "react";
import { useWorkspaceApi, workspaceFileUrl } from "@science-studio/transport-client";
import {
  formatAtomMolql,
  formatBondMolql,
  formatInteractionMolql,
  formatResidueMolql,
  formatStructureMention,
  molqlTargetKey,
  MolqlViewerPanel,
  type MolqlTarget,
} from "@science-studio/molql-viewer";
import { useComposerInsert } from "@/components/assistant-ui/composer-insert";
import { useStudioStore } from "@/store/studio-store";

/**
 * The structure preview: a Mol* viewer over the workspace file. Selections are
 * driven by the agent's `molql` tool (through the frontend bridge) and, in
 * Mol*'s selection mode, by clicking a residue/atom/bond/interaction, which
 * toggles a composer mention.
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

  return (
    <div className="relative h-full min-h-0">
      <MolqlViewerPanel
        fileUrl={url}
        fileName={name}
        className="h-full w-full"
        onResidueClick={handleResidueClick}
        onError={(err) => setError(err.message)}
      />
      {error && (
        <p
          className="text-destructive bg-background/95 absolute inset-x-0 bottom-0 px-3 py-1.5 text-xs"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
