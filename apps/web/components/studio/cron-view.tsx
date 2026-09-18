"use client";

import { useState } from "react";
import { CalendarClock, Plus } from "lucide-react";
import { cronTaskPath, describeSchedule, useCronTasks } from "@science-studio/transport-client";
import { Button } from "@/components/ui/button";
import { ModuleEmptyState, SidebarSection } from "./sidebar-section";
import { NewCronTaskDialog } from "./cron-new-task-dialog";
import { useStudioStore } from "@/store/studio-store";

const STATUS_CLASS: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "skipped-busy": "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  error: "bg-destructive/15 text-destructive",
};

export function CronView() {
  const open = useStudioStore((s) => s.rightSections.cron);
  const toggleRightSection = useStudioStore((s) => s.toggleRightSection);
  const height = useStudioStore((s) => s.rightHeights.cron);
  const projectId = useStudioStore((s) => s.projectId);
  const activeSessionId = useStudioStore((s) => s.activeSessionId);
  const openFile = useStudioStore((s) => s.openFile);
  const [dialogOpen, setDialogOpen] = useState(false);

  const enabled = open && projectId !== null;
  const { tasks, invalid, error, refresh } = useCronTasks({ projectId, enabled });

  return (
    <SidebarSection
      section="cron"
      title="Cron"
      icon={CalendarClock}
      open={open}
      onOpenChange={() => toggleRightSection("cron")}
      className={open ? "shrink-0" : undefined}
      style={open ? { height } : undefined}
      actions={
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6"
          aria-label="New scheduled task"
          disabled={projectId === null}
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="size-3.5" />
        </Button>
      }
    >
      {tasks.length === 0 && invalid.length === 0 ? (
        <ModuleEmptyState
          icon={CalendarClock}
          message="No scheduled tasks."
          hint="Scheduled runs will appear here."
        />
      ) : (
        <ul className="flex h-full flex-col gap-1 overflow-auto p-2" aria-label="Scheduled tasks">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onDoubleClick={() => openFile(task.path, task.name)}
                className="border-border/60 hover:bg-accent/50 flex w-full flex-col gap-1 rounded-md border px-2 py-1.5 text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium" title={task.name}>
                    {task.name}
                  </span>
                  {task.lastRun ? (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[task.lastRun.status] ?? ""}`}
                    >
                      {task.lastRun.status}
                    </span>
                  ) : null}
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
                  <span>{describeSchedule(task.schedule)}</span>
                  <span className="ml-auto">{task.enabled ? "Enabled" : "Disabled"}</span>
                </div>
              </button>
            </li>
          ))}
          {invalid.map((file) => (
            <li key={file.path} className="text-destructive px-2 text-[10px]">
              Unreadable task: {file.path}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="text-destructive px-2 pb-1 text-[10px]">{error}</p> : null}
      {projectId !== null ? (
        <NewCronTaskDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          projectId={projectId}
          sessionId={activeSessionId}
          onCreated={(task) => {
            refresh();
            openFile(cronTaskPath(task.id), task.name);
          }}
        />
      ) : null}
    </SidebarSection>
  );
}
