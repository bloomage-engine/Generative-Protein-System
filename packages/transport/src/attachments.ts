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
      return attachment.name && attachment.name !== agentPath
        ? `- ${agentPath} (${attachment.name})`
        : `- ${agentPath}`;
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
