"use client";

import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * A titled, collapsible right-pane module. The header's title area is the
 * `CollapsibleTrigger`; `actions` is a SIBLING of it, so a header action
 * (upload, refresh) can never toggle the section.
 */
export function SidebarSection({
  section,
  title,
  icon: Icon,
  open,
  onOpenChange,
  actions,
  className,
  style,
  children,
}: {
  section: string;
  title: string;
  icon: LucideIcon;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      data-section={section}
      data-slot="sidebar-section"
      style={style}
      className={cn("flex min-h-0 flex-col overflow-hidden", className)}
    >
      <div className="flex items-center gap-1 px-2 py-1.5">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center gap-1 text-left"
          >
            <ChevronRight
              className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
            />
            <Icon className="size-3.5 shrink-0" />
            <span className="text-foreground truncate text-xs font-medium">{title}</span>
          </button>
        </CollapsibleTrigger>
        {actions ? <div className="flex items-center gap-0.5">{actions}</div> : null}
      </div>
      <CollapsibleContent className="min-h-0 flex-1 overflow-hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The neutral empty state a not-yet-wired module shows. */
export function ModuleEmptyState({
  icon: Icon,
  message,
  hint,
}: {
  icon: LucideIcon;
  message: string;
  hint: string;
}) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <Icon className="size-5 opacity-60" />
      <div className="text-xs">{message}</div>
      <div className="text-[11px] opacity-70">{hint}</div>
    </div>
  );
}
