import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Message, SessionState } from "@science-studio/transport";

/**
 * Science Studio's OWN durable mirror of each session's canonical transcript
 * (one JSON file per session). The dsh SDK wire has no history-replay request,
 * so after a service restart the adapter would otherwise face an empty
 * transcript while the client still claims history — and reconciling an
 * unverifiable empty transcript would wipe that client. Writing our own
 * mirror keeps the canonical transcript authoritative across restarts without
 * coupling to dsh's volatile internal session-log format (docs/adr/0004).
 *
 * The mirror is an optimization/durability device only: it is written on each
 * settled run and is never the source of truth for record persistence (Runs
 * go to the record store).
 */
export interface MirrorFile {
  v: 1;
  sessionId: string;
  status: SessionState["status"];
  messages: Message[];
}

export class TranscriptMirror {
  constructor(private readonly dir: string) {}

  private fileFor(sessionKey: string): string {
    return join(resolve(this.dir), `${encodeURIComponent(sessionKey)}.json`);
  }

  /** Read a session's mirror; returns null when absent or unreadable. */
  async load(sessionKey: string): Promise<MirrorFile | null> {
    try {
      const raw = await fs.readFile(this.fileFor(sessionKey), "utf8");
      const parsed = JSON.parse(raw) as MirrorFile;
      if (parsed?.v !== 1 || typeof parsed.sessionId !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Persist a session's canonical transcript (atomic rename). */
  async save(sessionKey: string, status: SessionState["status"], messages: Message[]): Promise<void> {
    const file = this.fileFor(sessionKey);
    try {
      await fs.mkdir(dirname(file), { recursive: true });
      const payload: MirrorFile = {
        v: 1,
        sessionId: sessionKey,
        status,
        messages: structuredClone(messages),
      };
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn("[dsh] transcript mirror save failed", err);
    }
  }
}
