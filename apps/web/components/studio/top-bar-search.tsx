"use client";

import * as React from "react";
import { Search, MessageSquare } from "lucide-react";
import {
  useWorkspaceRoot,
  type Entry,
} from "@science-studio/transport-client";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { fileIcon } from "./file-icons";
import { kindFor } from "./file-utils";
import { useStudioStore } from "@/store/studio-store";

export function TopBarSearch() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);

  const projectId = useStudioStore((s) => s.projectId);
  const openFile = useStudioStore((s) => s.openFile);
  const sessions = useStudioStore((s) => s.sessions);
  const setScope = useStudioStore((s) => s.setScope);
  const setLeftView = useStudioStore((s) => s.setLeftView);

  // The file half of this search reads the SAME root listing the file tree
  // shows, and the session half the ACTIVE Project's Sessions — both follow the
  // committed scope, so a pick here never points at another Project's files.
  const root = useWorkspaceRoot({ project: projectId });
  const rootEntries: Entry[] = React.useMemo(
    () => (root.listing?.entries ?? []).filter((entry) => entry.kind === "file"),
    [root.listing],
  );

  const q = query.trim().toLowerCase();
  const files = q ? rootEntries.filter((e) => e.name.toLowerCase().includes(q)) : [];
  const matched = q
    ? sessions.filter((s) => (s.title ?? s.id).toLowerCase().includes(q))
    : [];

  React.useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const blurActive = () => (document.activeElement as HTMLElement | null)?.blur?.();
  const pickFile = (path: string) => {
    openFile(path, path.split("/").slice(-1)[0] ?? path);
    setOpen(false);
    setQuery("");
    blurActive();
  };
  const pickSession = (id: string) => {
    // The conversation and the Projects pane share the left slot: picking a
    // Session from the top bar has to bring the conversation back.
    setScope({ projectId, sessionId: id });
    setLeftView("thread");
    setOpen(false);
    setQuery("");
    blurActive();
  };

  const hasResults = files.length > 0 || (q !== "" && matched.length > 0);

  return (
    <div ref={rootRef} className="relative w-72 max-w-full">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          placeholder="Search files / sessions…"
          className="h-8 pl-7 text-xs"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
      </div>
      {open && (
        <div className="absolute right-0 top-9 z-50 w-80 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <ScrollArea className="max-h-96">
            {files.length > 0 && (
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Files · root
              </div>
            )}
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => pickFile(f.path)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                {fileIcon(kindFor(f.name, f.mime))}
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="max-w-[50%] truncate text-muted-foreground">/{f.path}</span>
              </button>
            ))}
            {matched.length > 0 && (
              <>
                <Separator className="my-1" />
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Sessions
                </div>
                {matched.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => pickSession(s.id)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                  >
                    <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{s.title ?? s.id}</span>
                  </button>
                ))}
              </>
            )}
            {!hasResults && (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                {q === "" ? "Type to search files and sessions." : `No matches for "${query}".`}
              </div>
            )}
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
