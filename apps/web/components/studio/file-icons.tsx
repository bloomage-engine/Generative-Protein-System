"use client";

import type { ReactNode } from "react";
import {
  Atom,
  Bot,
  Braces,
  CalendarClock,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Palette,
} from "lucide-react";
import { isMoleculeFile, type FileKind } from "./file-utils";

export function fileIcon(kind: FileKind): ReactNode {
  switch (kind) {
    case "markdown":
      return <FileText className="size-3.5 text-sky-500" />;
    case "json":
      return <Braces className="size-3.5 text-amber-500" />;
    case "code":
      return <FileCode2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />;
    case "pdf":
      return <FileText className="size-3.5 text-red-500" />;
    case "molecule":
      return <Atom className="size-3.5 text-violet-500" />;
    default:
      return <File className="size-3.5 text-muted-foreground" />;
  }
}

export function cronIcon(): ReactNode {
  return <CalendarClock className="size-3.5 text-orange-500" />;
}

export function subagentIcon(): ReactNode {
  return <Bot className="size-3.5 text-violet-500" />;
}

export function fileIconForName(
  name: string,
  isFolder: boolean,
  isExpanded: boolean,
): ReactNode {
  if (isFolder) {
    return isExpanded ? (
      <FolderOpen className="size-4 shrink-0 text-amber-500" />
    ) : (
      <Folder className="size-4 shrink-0 text-amber-500" />
    );
  }
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["ts", "tsx", "js", "jsx", "mjs", "py", "go", "rs"].includes(ext)) {
    return <FileCode2 className="size-4 shrink-0 text-blue-500" />;
  }
  if (ext === "css" || ext === "scss") {
    return <Palette className="size-4 shrink-0 text-purple-500" />;
  }
  if (ext === "json") {
    return <Braces className="size-4 shrink-0 text-yellow-500" />;
  }
  if (ext === "md" || ext === "mdx") {
    return <FileText className="size-4 shrink-0 text-sky-500" />;
  }
  if (name.toLowerCase().endsWith(".pdf")) {
    return <FileText className="size-4 shrink-0 text-red-500" />;
  }
  if (isMoleculeFile(name)) {
    return <Atom className="size-4 shrink-0 text-violet-500" />;
  }
  return <File className="text-muted-foreground size-4 shrink-0" />;
}
