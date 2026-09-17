"use client";

import { FlaskConical } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { Button } from "@/components/ui/button";
import { FilePreviewPane } from "./file-preview-pane";
import { ProjectPanel } from "./project-panel";
import { RightPanel } from "./right-panel";
import { useStudioStore } from "@/store/studio-store";

function Handle() {
  return <Separator className="w-1 bg-border hover:bg-primary/40 data-[state=hover]:bg-primary" />;
}

/**
 * The three-pane workbench: the LEFT slot | file preview (center, always) |
 * file tree (right).
 *
 * The left slot holds ONE of two views — the conversation or the Project/Session
 * panel — picked by the top bar's switch (store `leftView`); `Thread` is
 * unmounted when the panel owns the slot. Either way the runtime itself lives
 * above in the memoized `Session`, so the swap re-renders UI off the same
 * runtime instead of touching it.
 */
export function StudioWorkspace({ projectId }: { projectId: string | null }) {
  const leftView = useStudioStore((s) => s.leftView);
  const leftPanel = useStudioStore((s) => s.leftPanel);
  const rightPanel = useStudioStore((s) => s.rightPanel);
  const sessionId = useStudioStore((s) => s.activeSessionId);
  const layoutKey = `${leftPanel ? 1 : 0}-${rightPanel ? 1 : 0}`;

  return (
    <Group key={layoutKey} orientation="horizontal" className="h-full w-full">
      {leftPanel && (
        <Panel id="left" defaultSize="30" minSize="15" maxSize="60" className="h-full">
          <div className="h-full min-h-0">
            {leftView === "project" ? (
              <ProjectPanel />
            ) : sessionId ? (
              <Thread />
            ) : (
              <NoSessionNotice />
            )}
          </div>
        </Panel>
      )}
      {leftPanel && <Handle />}
      <Panel id="center" defaultSize="40" minSize="20" maxSize="80" className="h-full">
        <FilePreviewPane />
      </Panel>
      {rightPanel && <Handle />}
      {rightPanel && (
        <Panel id="right" defaultSize="30" minSize="15" maxSize="60" className="h-full">
          <RightPanel project={projectId} />
        </Panel>
      )}
    </Group>
  );
}

/**
 * The Conversation view with no Session to converse with. There is no runtime
 * to render a `Thread` against, so it points at the pane that creates one.
 */
function NoSessionNotice() {
  const setLeftView = useStudioStore((s) => s.setLeftView);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      <div>No session is open.</div>
      <div className="text-xs opacity-70">Create or pick one in the Projects pane.</div>
      <Button variant="outline" size="sm" onClick={() => setLeftView("project")}>
        <FlaskConical /> Open the Projects pane
      </Button>
    </div>
  );
}
