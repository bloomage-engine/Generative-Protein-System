import type { BundledLanguage } from "shiki";
import { isStructureFile } from "@gps/molstar-viewer/formats";
import { isMsaFile } from "@gps/msa-viewer/formats";

/**
 * Infer a renderer + code language from a file name / mime (the workspace API
 * gives us a `mime` and a basename; there is no explicit kind field).
 *
 * `pdf`, `structure` and `image` are decided from the NAME: the service serves
 * PDFs as `application/pdf`, images as `image/*`, and every structure format as
 * `application/octet-stream` (see `mimeFor`), so a MIME sniff cannot tell a
 * `.pdb` from any other binary. The structure formats themselves are owned by
 * `@gps/molstar-viewer/formats`.
 */
export type FileKind = "markdown" | "json" | "code" | "text" | "pdf" | "structure" | "image" | "msa";

export { isStructureFile } from "@gps/molstar-viewer/formats";
export { isMsaFile } from "@gps/msa-viewer/formats";

export function isPdfFile(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

export function isImageFile(name: string): boolean {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return IMAGE_EXTENSIONS.has(ext);
}

export function kindFor(name: string, mime?: string | null): FileKind {
  if (isPdfFile(name)) return "pdf";
  if (isStructureFile(name)) return "structure";
  if (isMsaFile(name)) return "msa";
  if (isImageFile(name)) return "image";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (mime?.startsWith("text/markdown") || ext === "md" || ext === "markdown" || ext === "mdx")
    return "markdown";
  if (mime === "application/json" || mime?.endsWith("+json") || ext === "json") return "json";
  return "code";
}

/**
 * The shiki grammar for a file, by extension; `undefined` when unknown (the
 * pane then renders plain text — NOT a wrong grammar: a `.txt` must not be
 * JS-highlighted). Only languages in `highlight.ts`'s `HIGHLIGHT_LANGUAGES`
 * are legal (shiki hard-fails on the rest); callers fall back to plain.
 */
const LANGUAGE_BY_EXTENSION: Record<string, BundledLanguage> = {
  py: "python",
  ts: "typescript",
  mts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  bash: "bash",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  toml: "toml",
  ini: "ini",
  properties: "properties",
  sql: "sql",
  csv: "csv",
  html: "html",
  htm: "html",
  xhtml: "html",
};

export function languageFor(name: string, kind: FileKind): BundledLanguage | undefined {
  if (kind === "markdown") return "markdown";
  if (kind === "json") return "json";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return LANGUAGE_BY_EXTENSION[ext];
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A subagent child-session tab lives in its OWN namespace (`subagent:<id>`)
 * — a real workspace path can never collide with it, and the preview pane
 * dispatches it before any file logic.
 */
export function isSubagentTab(path: string): boolean {
  return path.startsWith("subagent:");
}

export function subagentTabChildId(path: string): string {
  return isSubagentTab(path) ? path.slice("subagent:".length) : "";
}

/**
 * A Compute Job detail/log tab (docs/adr/0024) in the same synthetic-tab
 * tradition as `subagent:` — a ledger row, not a file; the preview pane
 * dispatches it before any file logic.
 */
export function isHpcJobTab(path: string): boolean {
  return path.startsWith("hpc:");
}

export function hpcTabJobId(path: string): string {
  return isHpcJobTab(path) ? path.slice("hpc:".length) : "";
}

/**
 * True when the file is text-based and can be viewed/edited in source mode.
 * Cron tasks are excluded — they have their own dedicated editor UI.
 * Note: this only checks the file name, not the path; the caller must also
 * check `isCronTaskPath` for full correctness.
 */
export function isTextEditable(name: string): boolean {
  const kind = kindFor(name);
  return kind !== "pdf" && kind !== "structure" && kind !== "image" && kind !== "msa";
}
