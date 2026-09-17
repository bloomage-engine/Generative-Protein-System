"use client";

import { CalendarClock } from "lucide-react";
import { ModuleEmptyState, SidebarSection } from "./sidebar-section";
import { useStudioStore } from "@/store/studio-store";

/** The Cron module. A skeleton: no scheduled-work data source exists yet. */
export function CronView() {
  const open = useStudioStore((s) => s.rightSections.cron);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.cron);

  return (
    <SidebarSection
      section="cron"
      title="Cron"
      icon={CalendarClock}
      open={open}
      onOpenChange={() => toggleRightSection("cron")}
      style={open ? { height } : undefined}
    >
      <ModuleEmptyState
        icon={CalendarClock}
        message="No scheduled tasks."
        hint="Scheduled runs will appear here."
      />
    </SidebarSection>
  );
}
