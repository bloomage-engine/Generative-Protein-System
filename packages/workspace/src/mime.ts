/** Minimal extension → MIME map. Deliberately small; unknown types download. */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".log": "text/plain",
  ".py": "text/x-python",
  ".r": "text/x-r",
  ".sh": "text/x-shellscript",
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".gz": "application/gzip",
  ".zip": "application/zip",
  ".parquet": "application/vnd.apache.parquet",
};

const FALLBACK_MIME = "application/octet-stream";

/** MIME type for a file name, by extension; unknown extensions fall back. */
export function mimeFor(nameOrPath: string): string {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot <= 0 || dot === nameOrPath.length - 1) return FALLBACK_MIME;
  return MIME_BY_EXTENSION[nameOrPath.slice(dot).toLowerCase()] ?? FALLBACK_MIME;
}

/** True when the MIME type can be rendered inline as text (v1 preview scope). */
export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/yaml";
}
