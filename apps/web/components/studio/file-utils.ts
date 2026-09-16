import type { BundledLanguage } from "shiki";
import { isStructureFile } from "@science-studio/molql-viewer/formats";

/**
 * Infer a renderer + code language from a file name / mime (the workspace API
 * gives us a `mime` and a basename; there is no explicit kind field).
 *
 * `structure` is detected by NAME, not mime: molecular structure files are
 * served as `application/octet-stream` (their extensions are not in the
 * workspace mime map), so the extension is the only signal.
 */
export type FileKind = "markdown" | "json" | "code" | "text" | "structure";

export function kindFor(name: string, mime?: string | null): FileKind {
  if (isStructureFile(name)) return "structure";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (mime?.startsWith("text/markdown") || ext === "md" || ext === "markdown" || ext === "mdx")
    return "markdown";
  if (mime === "application/json" || mime?.endsWith("+json") || ext === "json") return "json";
  return "code";
}

export function languageFor(name: string, kind: FileKind): BundledLanguage {
  if (kind === "markdown") return "markdown";
  if (kind === "json") return "json";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "py") return "python";
  if (ext === "ts" || ext === "mts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx" || ext === "mjs") return "javascript";
  if (ext === "sh" || ext === "bash") return "bash";
  return "javascript";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
