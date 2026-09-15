"use client";

import { FlaskConical, MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStudioStore, type LeftView } from "@/store/studio-store";

const VIEWS = [
  { id: "project", label: "Projects", icon: FlaskConical },
  { id: "thread", label: "Conversation", icon: MessagesSquare },
] as const satisfies ReadonlyArray<{ id: LeftView; label: string; icon: typeof FlaskConical }>;

/**
 * The left slot's two switch buttons. The conversation and the Project/Session
 * panel share one pane, so exactly one is shown; the button of whichever is
 * showing reads as pressed and clicking it collapses the slot (the top bar is
 * the only place the slot's visibility is controlled now).
 */
export function LeftViewSwitcher() {
  const leftView = useStudioStore((s) => s.leftView);
  const leftPanel = useStudioStore((s) => s.leftPanel);
  const selectLeftView = useStudioStore((s) => s.selectLeftView);

  return (
    <div className="flex items-center gap-1">
      {VIEWS.map(({ id, label, icon: Icon }) => {
        const active = leftPanel && leftView === id;
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant={active ? "secondary" : "ghost"}
                size="sm"
                className="h-7 gap-1.5"
                aria-pressed={active}
                onClick={() => selectLeftView(id)}
              >
                <Icon className="size-4 shrink-0" />
                <span className="font-medium">{label}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {active ? `Hide the ${label} pane` : `Show the ${label} pane`}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
