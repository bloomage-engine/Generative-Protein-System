"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isCronTaskPath } from "@science-studio/transport-client";
import { cronIcon, fileIcon, subagentIcon } from "./file-icons";
import { isSubagentTab, kindFor } from "./file-utils";
import { useStudioStore } from "@/store/studio-store";

/** The open-files tab strip (center of the top bar). */
export function TabStrip() {
  const tabs = useStudioStore((s) => s.tabs);
  const activeTabPath = useStudioStore((s) => s.activeTabPath);
  const setActiveTab = useStudioStore((s) => s.setActiveTab);
  const closeTab = useStudioStore((s) => s.closeTab);

  if (tabs.length === 0) {
    return (
      <div className="flex h-8 items-center px-2 text-xs text-muted-foreground">
        Open a file from the tree to show tabs
      </div>
    );
  }

  return (
    <div role="tablist" className="flex h-8 items-stretch overflow-x-auto">
      {tabs.map((tab) => {
        const active = tab.path === activeTabPath;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => setActiveTab(tab.path)}
            className={
              "group relative flex h-8 cursor-pointer items-center gap-1.5 border-r border-border/60 pl-2.5 pr-1 text-xs transition-colors " +
              (active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")
            }
          >
            {isCronTaskPath(tab.path) ? cronIcon() : isSubagentTab(tab.path) ? subagentIcon() : fileIcon(kindFor(tab.name))}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="max-w-[10rem] truncate">{tab.name}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{tab.path}</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-6 w-6"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.path);
              }}
              aria-label="Close tab"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
