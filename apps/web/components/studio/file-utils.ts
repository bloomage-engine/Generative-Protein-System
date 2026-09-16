import type { BundledLanguage } from "shiki";

/**
 * Infer a renderer + code language from a file name / mime (the workspace API
 * gives us a `mime` and a basename; there is no explicit kind field).
 *
 * `pdf` and `molecule` are decided from the NAME only: the service serves PDFs
 * as `application/pdf` and every structure format as `application/octet-stream`
 * (see `mimeFor`), so a MIME sniff cannot tell a `.pdb` from any other binary.
 */
export type FileKind = "markdown" | "json" | "code" | "text" | "pdf" | "molecule";

/** Structure formats Mol* can load, including the gzip/binary variants. */
const MOLECULE_SUFFIXES = [
  ".pdb",
  ".pdb.gz",
  ".cif",
  ".cif.gz",
  ".mmcif",
  ".bcif",
  ".bcif.gz",
  ".mol",
  ".mol2",
];

export function isPdfFile(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

export function isMoleculeFile(name: string): boolean {
  const lower = name.toLowerCase();
  return MOLECULE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function kindFor(name: string, mime?: string | null): FileKind {
  if (isPdfFile(name)) return "pdf";
  if (isMoleculeFile(name)) return "molecule";
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
