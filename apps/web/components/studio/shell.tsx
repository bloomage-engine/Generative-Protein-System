"use client";

import { TopBar } from "./top-bar";
import { StatusBar } from "./status-bar";
import { StudioWorkspace } from "./workspace";

export function StudioShell({ projectId }: { projectId: string | null }) {
  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background text-foreground">
      <TopBar />
      <div className="flex-1 overflow-hidden">
        <StudioWorkspace projectId={projectId} />
      </div>
      <StatusBar />
    </div>
  );
}
