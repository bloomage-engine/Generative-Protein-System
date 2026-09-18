import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SubagentLedgerEntry, SubagentLedgerStore } from "./subagents.js";

/**
 * The file-backed subagent ledger: one JSON file per Science Studio Session
 * key under one directory — the same one-file-per-session placement as the
 * transcript mirror, so a shared transcript dir never mixes two Projects'
 * rows into one file. Writes are atomic (a temp file renamed into place),
 * never interleaving, and unreadable content reads as ABSENT rather than
 * corrupt — the durable list degrades to empty, the live one stays good.
 */
export interface LedgerFile {
  v: 1;
  sessionId: string;
  entries: SubagentLedgerEntry[];
}

export class FileSubagentLedger implements SubagentLedgerStore {
  constructor(private readonly dir: string) {}

  private fileFor(sessionKey: string): string {
    return join(resolve(this.dir), `${encodeURIComponent(sessionKey)}.json`);
  }

  async listKeys(): Promise<string[]> {
    try {
      const names = await fs.readdir(this.dir);
      const keys: string[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          keys.push(decodeURIComponent(name.slice(0, -5)));
        } catch {
          // A name that cannot decode: skip it, keep the rest.
        }
      }
      return keys;
    } catch {
      return [];
    }
  }

  async load(sessionKey: string): Promise<SubagentLedgerEntry[] | null> {
    try {
      const raw = await fs.readFile(this.fileFor(sessionKey), "utf8");
      const parsed = JSON.parse(raw) as LedgerFile;
      if (parsed?.v !== 1 || !Array.isArray(parsed.entries)) return null;
      return parsed.entries;
    } catch {
      return null;
    }
  }

  async save(sessionKey: string, entries: readonly SubagentLedgerEntry[]): Promise<void> {
    const file = this.fileFor(sessionKey);
    try {
      await fs.mkdir(dirname(file), { recursive: true });
      const payload: LedgerFile = { v: 1, sessionId: sessionKey, entries: [...entries] };
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn("[dsh] subagent ledger save failed", err);
    }
  }
}
