/**
 * Attachment rendering — shared by every adapter.
 *
 * Every runtime we ship takes a TEXT prompt (openclaw `chat.send.message`, dsh
 * `session/prompt`), and the agent already runs with the workspace as its cwd,
 * so a workspace attachment is communicated by its path. These helpers keep
 * that one rendering in one place; an adapter that needs a different shape can
 * still implement its own (see docs/design/research-agent-framework.md §6).
 */
import type { AttachmentRef, MessagePart } from "./types.js";

export interface AttachmentRenderingOptions {
  /** Map a workspace-relative path to the path the AGENT sees. */
  toAgentPath?: (relPath: string) => string;
  /** Heading line. Defaults to "Attached files". */
  heading?: string;
}

/** Render attachments as a text block; "" when there is nothing to render. */
export function renderAttachments(
  attachments: readonly AttachmentRef[] | undefined,
  opts: AttachmentRenderingOptions = {},
): string {
  if (!attachments || attachments.length === 0) return "";
  const toAgentPath = opts.toAgentPath ?? ((relPath: string) => relPath);
  const lines = attachments.map((attachment) => {
    if (attachment.kind === "workspace" && attachment.path) {
      const agentPath = toAgentPath(attachment.path);
      const suffix =
        attachment.entryKind === "dir"
          ? " (directory)"
          : attachment.name && attachment.name !== agentPath
            ? ` (${attachment.name})`
            : "";
      return `- ${agentPath}${suffix}`;
    }
    // Not in the workspace yet — the file service has to write it first.
    return `- ${attachment.name} (not yet in the workspace)`;
  });
  return `${opts.heading ?? "Attached files"}:\n${lines.join("\n")}`;
}

/** The exact text to send to the runtime: the user's text plus any block. */
export function promptWithAttachments(
  content: string,
  attachments?: readonly AttachmentRef[],
  opts: AttachmentRenderingOptions = {},
): string {
  const block = renderAttachments(attachments, opts);
  return block ? `${content}\n\n${block}` : content;
}

/**
 * The parts for a user message carrying attachments: its text, plus one `file`
 * part per workspace-backed attachment so the UI renders a chip immediately —
 * without waiting for the runtime to echo anything back.
 */
export function userMessageParts(
  content: string,
  attachments?: readonly AttachmentRef[],
): MessagePart[] {
  const parts: MessagePart[] = [{ type: "text", text: content }];
  for (const attachment of attachments ?? []) {
    if (attachment.kind !== "workspace" || !attachment.path) continue;
    // A directory stays a reference: it gets no preview chip.
    if (attachment.entryKind === "dir") continue;
    parts.push({
      type: "file",
      path: attachment.path,
      name: attachment.name,
      ...(attachment.mime ? { mime: attachment.mime } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      source: "workspace",
    });
  }
  return parts;
}

// -- Mentions ---------------------------------------------------------------

/** A mention directive lifted out of composer text. */
export interface MentionRef {
  type: string;
  label: string;
  id: string;
}

/**
 * The directive types this module understands. Everything else (a runtime's
 * own directive types) is left in the text untouched.
 */
const WORKSPACE_MENTION_TYPES = new Set(["file", "directory"]);

/**
 * Split `:type[label]{name=id}` mention directives out of composer text.
 *
 * The composer serializes an `@` pick via assistant-ui's directive formatter;
 * these directives are the wire form of a mention, so parsing them here is what
 * turns `@analysis/plot.png` into an `AttachmentRef`. Returns the remaining
 * text (recognized directives removed, runs of spaces collapsed) plus the
 * mentions, in order.
 */
export function parseWorkspaceMentions(text: string): {
  text: string;
  mentions: MentionRef[];
} {
  const mentions: MentionRef[] = [];
  if (!text.includes(":")) return { text, mentions };

  // Same grammar as assistant-ui's `unstable_defaultDirectiveFormatter`.
  const directive = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/gu;
  let remaining = "";
  let lastIndex = 0;

  for (const match of text.matchAll(directive)) {
    const type = match[1]!;
    if (!WORKSPACE_MENTION_TYPES.has(type)) continue;
    const index = match.index!;
    remaining += text.slice(lastIndex, index);
    mentions.push({ type, label: match[2]!, id: match[3] ?? match[2]! });
    lastIndex = index + match[0].length;
  }
  remaining += text.slice(lastIndex);

  // No recognized directive: leave the text EXACTLY as it was (do not collapse
  // or trim a message the user wrote).
  if (mentions.length === 0) return { text, mentions };

  return { text: remaining.replace(/[ \t]{2,}/g, " ").trim(), mentions };
}

/** Turn lifted mentions into workspace references. */
export function attachmentsFromMentions(mentions: readonly MentionRef[]): AttachmentRef[] {
  return mentions.map((mention) => ({
    kind: "workspace",
    path: mention.id,
    name: mention.label,
    entryKind: mention.type === "directory" ? "dir" : "file",
  }));
}
