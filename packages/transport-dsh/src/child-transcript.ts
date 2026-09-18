import { promises as fs } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Message, SubagentTranscript } from "@science-studio/transport";
import { contentToParts, extractResultText, findToolCallMessage } from "./mapping.js";

// `zstdDecompressSync` is present at runtime (Node >= 23.8) but not yet declared in
// this repo's pinned @types/node, so it is reached without bumping the types.
const zstdDecompressSync = (zlib as unknown as {
  zstdDecompressSync: (buf: Buffer) => Buffer;
}).zstdDecompressSync;

/**
 * The harness's session-root directory key for a project path —
 * re-implemented (rather than imported) from
 * `@deepseek-ai/dsh-session-persistence-jsonl`: separators and drive
 * separators collapse to a single `-`, unsafe code units escape as `~XXXX`
 * (upper-case, 4-digit hex), the key is bracketed `--…--` and bounded to 251
 * characters. The key is a stable, version-observed path contract; the
 * adapter must not depend on the harness's plugin internals.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

export interface ChildTranscriptSource {
  /** The harness home the adapter's children launch into. */
  home: string;
  /** The launch working directory recorded on the child's session header. */
  cwd: string;
  /** The Science Studio Session key the child was delegated from. */
  sessionKey: string;
  /** The child (harness) session id. */
  childId: string;
}

/**
 * Read one dsh child's durable session (the harness's own event log) and fold
 * it into the seam's `SubagentTranscript`. FAIL-SOFT end to end: an absent
 * home/dir/log, an undecodable frame, and a torn trailing line all resolve to
 * `null` (or keep what already decoded) — the surface degrades to "no record"
 * rather than throwing (docs/adr/0016 addendum).
 *
 * The fold mirrors the behavior's live rules over the SAME vocabulary:
 * `user/message`/`assistant/message` rows become messages; a `tool/call`
 * upserts a `tool-call` part into the latest assistant message; a
 * `tool/result` merges its text into that call; `turn/end` settles the status
 * and `finishedAt`; `subagent/descriptor` carries the label/model fields; the
 * `session` header carries `startedAt` (and must name THIS child).
 */
export async function readChildTranscript(source: ChildTranscriptSource): Promise<SubagentTranscript | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(source.childId)) return null;
  const dir = join(source.home, "sessions", projectKey(source.cwd), source.childId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  // The newest format generation wins (a bump in v leaves older artifacts).
  const gens = names
    .map((name) => {
      const match = /^session\.v([0-9]+)\.jsonl(?:\.zstd)?$/.exec(name);
      if (match === null) return null;
      return { version: Number(match[1]), zstd: name.endsWith(".zstd"), name };
    })
    .filter((g): g is { version: number; zstd: boolean; name: string } => g !== null)
    .sort((a, b) => b.version - a.version);
  if (gens.length === 0) return null;

  let text: string;
  try {
    const bytes = await fs.readFile(join(dir, gens[0]!.name));
    text = gens[0]!.zstd ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
  } catch {
    return null;
  }

  let startedAt: string | undefined;
  let headerId: string | undefined;
  let label: string | undefined;
  let provider: string | undefined;
  let agentProvider: string | undefined;
  let agentModel: string | undefined;
  let status: SubagentTranscript["status"];
  let finishedAt: string | undefined;
  const messages: Message[] = [];
  let minted = 0;
  const nextId = (): string => `child-${++minted}`;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // a torn tail keeps the already-folded prefix
    }
    if (typeof row !== "object" || row === null) continue;
    const rec = row as Record<string, unknown>;
    const type = typeof rec["type"] === "string" ? rec["type"] : null;
    if (type === null) continue;
    const data = (rec["data"] ?? {}) as Record<string, unknown>;
    const timeIso = typeof rec["time"] === "number" ? new Date(rec["time"]).toISOString() : undefined;

    const blocksOf = (value: unknown): readonly ContentBlock[] =>
      Array.isArray(value) ? (value as readonly ContentBlock[]) : [];

    switch (type) {
      case "session":
        headerId = typeof rec["id"] === "string" ? rec["id"] : undefined;
        if (typeof rec["createdAt"] === "number" && Number.isFinite(rec["createdAt"])) {
          startedAt = new Date(rec["createdAt"]).toISOString();
        }
        break;

      case "subagent/descriptor": {
        if (typeof data["label"] === "string") label = data["label"];
        if (typeof data["provider"] === "string") provider = data["provider"];
        if (typeof data["agentProvider"] === "string") agentProvider = data["agentProvider"];
        if (typeof data["agentModel"] === "string") agentModel = data["agentModel"];
        break;
      }

      case "user/message": {
        const parts = contentToParts(blocksOf(data["content"]));
        if (parts.length > 0) messages.push({ id: nextId(), role: "user", parts });
        break;
      }

      case "assistant/message": {
        const message = (data["message"] ?? {}) as Record<string, unknown>;
        if (message["role"] !== "assistant") break;
        const id = typeof message["id"] === "string" ? message["id"] : nextId();
        if (messages.some((m) => m.id === id)) break; // committed once per id (live rule)
        messages.push({ id, role: "assistant", parts: contentToParts(blocksOf(message["content"])) });
        break;
      }

      case "tool/call": {
        // The owning assistant message is the latest; the tool-call part may
        // already exist from the assistant row (upsert, not append-twice).
        const owner = [...messages].reverse().find((m) => m.role === "assistant");
        if (owner === undefined) break;
        const existing = owner.parts.find((p) => p.type === "tool-call" && p.id === data["callId"]);
        if (existing === undefined && typeof data["name"] === "string") {
          owner.parts.push({
            type: "tool-call",
            id: typeof data["callId"] === "string" ? data["callId"] : nextId(),
            name: data["name"],
            args: typeof data["arguments"] === "string" ? data["arguments"] : "",
          });
        }
        break;
      }

      case "tool/result": {
        const message = (data["message"] ?? {}) as Record<string, unknown>;
        const blocks = blocksOf(message["content"]);
        for (const block of blocks as unknown as Array<Record<string, unknown>>) {
          if (block["type"] !== "tool-result" || typeof block["toolCallId"] !== "string") continue;
          const target = findToolCallMessage(messages, block["toolCallId"]);
          if (target === null) continue;
          for (const part of target.parts) {
            if (part.type === "tool-call" && part.id === block["toolCallId"]) {
              part.result = extractResultText(blocks as Array<ContentBlock>);
              part.isError = block["isError"] === true;
            }
          }
        }
        break;
      }

      case "turn/end": {
        const reason = (data["reason"] ?? {}) as Record<string, unknown>;
        const kind = reason["kind"];
        status = kind === "completed" ? "completed" : kind === "error" ? "error" : "aborted";
        if (timeIso !== undefined) finishedAt = timeIso;
        break;
      }

      default:
        // system/message, step/*, request/*, sandbox/mode, approval/policy,
        // agent/inbox/*: structural, never rendered.
        break;
    }
  }

  // A header that names a different session is not this record.
  if (headerId !== undefined && headerId !== source.childId) return null;

  return {
    id: source.childId,
    parentId: source.sessionKey,
    ...(label === undefined ? {} : { label }),
    ...(provider === undefined ? {} : { provider }),
    ...(agentProvider === undefined ? {} : { agentProvider }),
    ...(agentModel === undefined ? {} : { agentModel }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(status === undefined ? {} : { status }),
    messages,
  };
}
