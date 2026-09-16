"use client";

import type { ReactNode } from "react";
import { Atom, FileCode2, FileText, Braces, File } from "lucide-react";
import type { FileKind } from "./file-utils";

export function fileIcon(kind: FileKind): ReactNode {
  switch (kind) {
    case "markdown":
      return <FileText className="size-3.5 text-sky-500" />;
    case "json":
      return <Braces className="size-3.5 text-amber-500" />;
    case "code":
      return <FileCode2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />;
    case "structure":
      return <Atom className="size-3.5 text-violet-500" />;
    default:
      return <File className="size-3.5 text-muted-foreground" />;
  }
}
