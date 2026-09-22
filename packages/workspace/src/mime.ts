/**
 * Minimal extension → MIME map. Deliberately small; unknown types download.
 * The text formats are exactly the "common text" set the preview pane renders
 * (docs: AGENTS.md workspace section) — the client's textual-MIME gate
 * (`looksTextual`) must admit every type this map yields for a text file.
 */
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
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".properties": "text/plain",
  ".sql": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".gz": "application/gzip",
  ".zip": "application/zip",
  ".parquet": "application/vnd.apache.parquet",
};

const FALLBACK_MIME = "application/octet-stream";

/** Env files are text although they carry no real extension (`.env`, `.env.*`). */
function isEnvFile(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

/** MIME type for a file name (or path — keyed by basename); unknown types fall back. */
export function mimeFor(nameOrPath: string): string {
  const name = nameOrPath.slice(nameOrPath.lastIndexOf("/") + 1);
  if (isEnvFile(name)) return "text/plain";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return FALLBACK_MIME;
  return MIME_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? FALLBACK_MIME;
}

/** True when the MIME type can be rendered inline as text (the preview scope). */
export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/yaml" ||
    mime === "application/xml" ||
    mime === "application/toml"
  );
}
