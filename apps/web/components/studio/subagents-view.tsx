"use client";

import { Bot } from "lucide-react";
import { ModuleEmptyState, SidebarSection } from "./sidebar-section";
import { useStudioStore } from "@/store/studio-store";

/** The Subagents module. A skeleton: no subagent data source exists yet. */
export function SubagentsView() {
  const open = useStudioStore((s) => s.rightSections.subagents);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.subagents);

  return (
    <SidebarSection
      section="subagents"
      title="Subagents"
      icon={Bot}
      open={open}
      onOpenChange={() => toggleRightSection("subagents")}
      className="shrink-0"
      style={open ? { height } : undefined}
    >
      <ModuleEmptyState
        icon={Bot}
        message="No subagents yet."
        hint="Subagent runs will appear here."
      />
    </SidebarSection>
  );
}
