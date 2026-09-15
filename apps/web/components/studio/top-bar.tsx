"use client";

import { LeftViewSwitcher } from "./left-view-switcher";
import { TopBarSearch } from "./top-bar-search";
import { TabStrip } from "./tab-strip";
import { PanelToggles } from "./panel-toggles";
import { ThemeToggle } from "./theme-toggle";

export function TopBar() {
  return (
    <header className="flex h-12 items-center gap-2 border-b bg-background px-3">
      <LeftViewSwitcher />
      <div className="mx-1 h-5 w-px bg-border" />
      <div className="flex-1 overflow-hidden">
        <TabStrip />
      </div>
      <TopBarSearch />
      <div className="mx-1 h-5 w-px bg-border" />
      <PanelToggles />
      <div className="mx-1 h-5 w-px bg-border" />
      <ThemeToggle />
    </header>
  );
}
