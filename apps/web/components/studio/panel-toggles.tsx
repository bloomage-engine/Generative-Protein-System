"use client";

import { PanelRight, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStudioStore } from "@/store/studio-store";

/**
 * The right/center pane controls. The LEFT pane is not here: its two views
 * (Conversation / Projects) are switched by `LeftViewSwitcher` at the other end
 * of the top bar.
 */
export function PanelToggles() {
  const rightPanel = useStudioStore((s) => s.rightPanel);
  const toggleRight = useStudioStore((s) => s.toggleRight);

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="secondary" size="icon-sm" disabled title="Always visible">
            <Square className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Viewer (always visible)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={rightPanel ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={toggleRight}
            aria-label="Right panel"
          >
            <PanelRight className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Right panel</TooltipContent>
      </Tooltip>
    </div>
  );
}
