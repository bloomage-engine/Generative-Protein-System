/**
 * File-reference grammar — ONE resolver for agent-emitted file paths.
 *
 * Agents return paths in two shapes: markdown links inside text, and structured
 * tool/event payloads. Both must resolve through this single function so the
 * markdown renderer, the file chip and the viewer agree on what counts as an
 * in-app workspace file.
 *
 * Recognized: workspace-relative paths (`analysis/plot.png`), `file://` URIs
 * under the agent root, and a custom `science://workspace/<path>` scheme an
 * adapter may inject. Everything else (http(s), mailto, data:, fragments,
 * absolute paths) is NOT a workspace reference — the server would reject it
 * anyway, and treating it as one would be a phishing surface.
 */

export interface FileRef {
  /** Workspace-relative, POSIX, normalized. */
  workspacePath: string;
  /** Last path segment, for display. */
  name: string;
}

export interface FileReferenceContext {
  /**
   * Agent-emitted path -> workspace-relative path; null when outside the root.
   * Optional: relative paths and the injected scheme need no mapping, so a
   * browser that does not know the agent root still resolves them.
   */
  toWorkspacePath?: (agentPath: string) => string | null;
  /** The injected scheme; defaults to "science". */
  scheme?: string;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Resolve one href to an in-app workspace file, or null when it is not one. */
export function resolveFileReference(
  href: string,
  ctx: FileReferenceContext,
): FileRef | null {
  if (typeof href !== "string") return null;
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#")) return null;

  // 1. The injected scheme: science://workspace/<path>
  const prefix = `${ctx.scheme ?? "science"}:`;
  if (raw.toLowerCase().startsWith(prefix)) {
    const match = /^\/\/([^/]+)\/(.*)$/.exec(raw.slice(prefix.length));
    if (!match || match[1] !== "workspace") return null;
    return fromPath(safeDecode(match[2] ?? ""));
  }

  // 2. file:// URIs, mapped back through the agent root.
  if (/^file:\/\//i.test(raw)) {
    let agentPath: string;
    try {
      agentPath = safeDecode(new URL(raw).pathname);
    } catch {
      return null;
    }
    const workspacePath = ctx.toWorkspacePath?.(agentPath) ?? null;
    return workspacePath === null ? null : fromPath(workspacePath);
  }

  // 3. Any other scheme, or protocol-relative, is external.
  if (HAS_SCHEME.test(raw) || raw.startsWith("//")) return null;

  // 4. Absolute paths are not workspace paths.
  if (raw.startsWith("/")) return null;

  // 5. A workspace-relative path (ignore any query/fragment suffix).
  return fromPath(raw.split(/[?#]/)[0] ?? "");
}

function fromPath(path: string): FileRef | null {
  const normalized = normalizeRelative(path);
  if (normalized === null) return null;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (name === "") return null;
  return { workspacePath: normalized, name };
}

/** Collapse `.`/`..`/empty segments; null when the path escapes the root. */
function normalizeRelative(path: string): string | null {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? null : parts.join("/");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
