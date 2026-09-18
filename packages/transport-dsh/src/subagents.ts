/**
 * The adapter-side subagent ledger. It folds the harness child's
 * `subagent.started` / `subagent.finished` notifications and its child-session
 * `subagent/descriptor` events into one live view per Science Studio Session.
 *
 * DURABLE (optional): without a store the ledger is live-only and dropped
 * with the adapter. When the adapter attaches a `SubagentLedgerStore` (it
 * does, in `init`), every entry is stamped with its resolved Science Studio
 * session key and saved per key, so finished runs survive the adapter
 * generation — the panel's history across service restarts (ADR 0016
 * addendum). A restored entry that was still `running` is settled to
 * `aborted`: its harness child died with the previous process, so listing it
 * as running would be a lie.
 *
 * The wire carries no timestamps, so the adapter stamps them on arrival. The
 * SDK's completion `status` is a coarse ok/error; the richer `stopReason` is
 * what the status is derived from.
 *
 * This module stays structural: it imports no `@deepseek-ai/*` value, so a
 * harness pin that moves a payload shape degrades to an unlabeled entry rather
 * than a crash (the same rule as the child bridge plugin).
 */
import type { SubagentRun } from "@science-studio/transport";

export interface SubagentDescriptorInfo {
  label?: string;
  provider?: string;
}

export interface SubagentFinishedInfo {
  provider?: string;
  status: "ok" | "error";
  stopReason?: string;
  /** The delegating session (harness id) `subagent.finished` reports itself. */
  parentSessionId?: string;
}

/** One persisted ledger row (JSON-safe; one file per session key). */
export interface SubagentLedgerEntry {
  id: string;
  parentHarnessId: string;
  /** Stamped once resolvable; stable across harness generations. */
  sessionKey?: string;
  label?: string;
  provider?: string;
  status: SubagentRun["status"];
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * The registry's durability seam. The adapter hosts a file-backed
 * implementation (ledger.ts); tests host in-memory ones.
 */
export interface SubagentLedgerStore {
  /** Every session key that holds a saved ledger. */
  listKeys(): Promise<string[]>;
  /** The ledger saved under one key, or `null` when absent/unreadable. */
  load(sessionKey: string): Promise<SubagentLedgerEntry[] | null>;
  /** Atomically replace every ledger row saved under one key. */
  save(sessionKey: string, entries: readonly SubagentLedgerEntry[]): Promise<void>;
}

type Entry = SubagentLedgerEntry;

/** The Run status a finished subagent settles to. The stop reason wins over
 *  the coarse SDK status: `max-tokens` and `refusal` are completed runs. */
function settleStatus(status: "ok" | "error", stopReason?: string): SubagentRun["status"] {
  switch (stopReason) {
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    default:
      return status === "error" ? "error" : "completed";
  }
}

/** A restored row is structural: keep only what is well-formed. */
function isLedgerEntry(value: unknown): value is SubagentLedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["id"] === "string" &&
    typeof e["parentHarnessId"] === "string" &&
    (e["status"] === "running" ||
      e["status"] === "completed" ||
      e["status"] === "aborted" ||
      e["status"] === "error") &&
    typeof e["startedAt"] === "string"
  );
}

export class SubagentRegistry {
  private readonly entries = new Map<string, Entry>();
  private store: SubagentLedgerStore | null = null;
  /** Chains saves so two concurrent saves never interleave their writes. */
  private saving: Promise<void> = Promise.resolve();
  /** The one restore in flight (or settled). */
  private restoring: Promise<void> | null = null;

  constructor(
    /** Map a ROOT harness session id back to its Science Studio session key. */
    private readonly resolveSessionKey: (rootHarnessId: string) => string | undefined,
    /** Clock seam for deterministic tests. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Attach durable storage (the adapter does this in `init`). Loads whatever
   * ledgers exist ONCE; settles restored `running` entries to `aborted` (theirs
   * harness child died with the previous process). A live in-memory entry
   * always wins over a duplicate restored row.
   */
  attachStore(store: SubagentLedgerStore): void {
    if (this.store !== null) return;
    this.store = store;
    this.restoring = this.restoreAll().catch((err) => {
      console.warn("[dsh] subagent ledger restore failed", err);
    });
  }

  /** Await the one-time restore (tests and graceful reads). */
  async ready(): Promise<void> {
    await this.restoring;
  }

  /** Await every queued save (tests and graceful shutdown). */
  async flush(): Promise<void> {
    await this.saving;
  }

  noteStarted(parentSessionId: string, childSessionId: string): void {
    if (parentSessionId === childSessionId || this.entries.has(childSessionId)) return;
    const entry: Entry = {
      id: childSessionId,
      parentHarnessId: parentSessionId,
      status: "running",
      startedAt: this.now(),
    };
    this.entries.set(childSessionId, entry);
    const key = this.resolveKey(entry);
    if (key !== undefined && this.store !== null) entry.sessionKey = key;
    this.persist(entry.sessionKey);
  }

  noteDescriptor(childSessionId: string, info: SubagentDescriptorInfo): void {
    const entry = this.entries.get(childSessionId);
    if (!entry) return;
    if (info.label !== undefined) entry.label = info.label;
    if (info.provider !== undefined) entry.provider = info.provider;
    if (entry.sessionKey === undefined) {
      const key = this.resolveKey(entry);
      if (key !== undefined && this.store !== null) entry.sessionKey = key;
    }
    this.persist(entry.sessionKey);
  }

  noteFinished(childSessionId: string, info: SubagentFinishedInfo): void {
    let entry = this.entries.get(childSessionId);
    if (entry === undefined) {
      // A `subagent.started` that was never observed (a dropped notification,
      // a service restart between start and finish) still leaves a finished
      // record: the payload carries its own parent. `startedAt` is stamped at
      // observation — the wire carries no timestamps (best-effort).
      if (info.parentSessionId === undefined) return;
      entry = {
        id: childSessionId,
        parentHarnessId: info.parentSessionId,
        status: "running",
        startedAt: this.now(),
      };
      this.entries.set(childSessionId, entry);
    }
    entry.status = settleStatus(info.status, info.stopReason);
    if (info.provider !== undefined) entry.provider = info.provider;
    if (info.stopReason !== undefined) entry.stopReason = info.stopReason;
    entry.finishedAt = this.now();
    if (entry.sessionKey === undefined) {
      const key = this.resolveKey(entry);
      if (key !== undefined && this.store !== null) entry.sessionKey = key;
    }
    this.persist(entry.sessionKey);
  }

  /** The live runs for one Session, newest first. Non-destructive: an entry
   *  whose root does not currently resolve (a `/new` remint, a mapping not
   *  published yet) is SKIPPED, never dropped, so it appears again once the
   *  root resolves. */
  list(sessionKey: string): SubagentRun[] {
    const out: SubagentRun[] = [];
    for (const entry of this.entries.values()) {
      const key = this.resolveKey(entry);
      if (key === undefined) continue;
      if (key !== sessionKey) continue;
      if (entry.sessionKey !== key && this.store !== null) {
        // Keying settles here (the first listed read after a root resolve).
        entry.sessionKey = key;
        this.persist(key);
      }
      out.push({
        id: entry.id,
        parentId: key,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(entry.provider === undefined ? {} : { provider: entry.provider }),
        status: entry.status,
        ...(entry.stopReason === undefined ? {} : { stopReason: entry.stopReason }),
        startedAt: entry.startedAt,
        ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
      });
    }
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return out;
  }

  private async restoreAll(): Promise<void> {
    const store = this.store!;
    const keys = await store.listKeys();
    for (const key of keys) {
      const rows = await store.load(key);
      if (rows === null) continue;
      for (const row of rows) {
        if (!isLedgerEntry(row) || this.entries.has(row.id)) continue;
        const entry: Entry = { ...row };
        if (entry.status === "running" && entry.finishedAt === undefined) {
          entry.status = "aborted";
          entry.finishedAt = this.now();
          if (entry.stopReason === undefined) entry.stopReason = "aborted";
        }
        if (entry.sessionKey === undefined) entry.sessionKey = key;
        this.entries.set(entry.id, entry);
      }
    }
  }

  private persist(key: string | undefined): void {
    if (key === undefined || this.store === null) return;
    const store = this.store;
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        const rows = [...this.entries.values()].filter((e) => e.sessionKey === key);
        await store.save(key, rows);
      })
      .catch((err) => {
        console.warn("[dsh] subagent ledger save failed", err);
      });
  }

  /** The Session key an entry belongs to: the nearest stamped ancestor wins;
   *  otherwise the ROOT (the first untracked ancestor in the parent chain) is
   *  resolved. `undefined` = not resolvable yet (the entry is skipped, not
   *  dropped, by `list`). */
  private resolveKey(entry: Entry): string | undefined {
    if (entry.sessionKey !== undefined) return entry.sessionKey;
    const seen = new Set<string>([entry.id]);
    let harnessId = entry.parentHarnessId;
    while (!seen.has(harnessId)) {
      seen.add(harnessId);
      const ancestor = this.entries.get(harnessId);
      if (ancestor === undefined) return this.resolveSessionKey(harnessId);
      if (ancestor.sessionKey !== undefined) return ancestor.sessionKey;
      harnessId = ancestor.parentHarnessId;
    }
    return this.resolveSessionKey(entry.parentHarnessId);
  }
}
