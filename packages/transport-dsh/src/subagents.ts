/**
 * The adapter-side subagent ledger. It folds the harness child's
 * `subagent.started` / `subagent.finished` notifications and its child-session
 * `subagent/descriptor` events into one live view per Science Studio Session,
 * and keeps the child's own settled transcript captured into the durable row
 * (docs/adr/0019).
 *
 * DURABLE (record-backed): the registry holds a `RecordStoreLike` and, when the
 * store exposes the subagent surface (`upsertSubagent` / `loadSubagent` /
 * `listSubagents`), every entry is persisted as a record `Subagent` row. The
 * record is authoritative for the durable identity: each entry is keyed by a
 * STABLE id the registry mints (`subagent-<uuid>`), and the wire key (the
 * `subagent.*` notification's child id) is only a field + a `wire→stable` bridge
 * — a live in-memory entry always wins over a restored row with the same stable
 * id (ADR 0016 addendum: a restored entry still `running` is settled to
 * `aborted`, its harness child died with the previous process).
 *
 * `list()` stays SYNC and reads the in-memory map (the LIVE view) — it does not
 * read the record. Restoring is explicit, per parent Session key
 * (`restore(sessionKey)`), and is what the adapter calls before it lists, so a
 * first read right after a restart lists the previous generation's finished runs
 * without racing the record load.
 *
 * The wire carries no timestamps, so the adapter stamps them on arrival. The
 * SDK's completion `status` is a coarse ok/error; the richer `stopReason` is
 * what the status is derived from.
 *
 * This module stays structural: it imports no `@deepseek-ai/*` value (the record
 * and transport seam types are type-only), so a harness pin that moves a payload
 * shape degrades to an unlabeled entry rather than a crash.
 */
import { randomUUID } from "node:crypto";
import type { PersistedTranscript, Subagent } from "@science-studio/record";
import type { RecordStoreLike, SubagentRun } from "@science-studio/transport";

export interface SubagentDescriptorInfo {
  label?: string;
  provider?: string;
}

/**
 * The placeholder wire key a RESTORED entry carries: the record does not store
 * the wire id (the `subagent.*` notification's child id), so the `wire→stable`
 * bridge stays 1:1 without a real one. The read surface recognises the prefix
 * as "no harness child log exists for this entry" (its transcript lives in the
 * record row — docs/adr/0019).
 */
export const RESTORED_WIRE_PREFIX = "restored-";

export interface SubagentFinishedInfo {
  provider?: string;
  status: "ok" | "error";
  stopReason?: string;
  /** The delegating session (harness id) `subagent.finished` reports itself. */
  parentSessionId?: string;
}

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

/** The registry's in-memory entry, keyed by its STABLE id (the record's key).
 *  The wire key (the `subagent.*` notification's child id) is a FIELD, not the
 *  id: the panel's `SubagentRun.id` is the stable id, and a `wire→stable` bridge
 *  resolves the notification's child id back to it. */
type Entry = {
  /** Stable, record-backed identity (`subagent-<uuid>`). */
  stableId: string;
  /** The wire key — the `subagent.*` notification's child id. */
  harnessChildId: string;
  /** The raw (harness) parent id, for lineage resolution. */
  parentHarnessId: string;
  /** The resolved Science Studio session key, once resolvable (the record row's parent). */
  parentSessionId?: string;
  label?: string;
  provider?: string;
  status: SubagentRun["status"];
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  transcript?: PersistedTranscript;
};

export class SubagentRegistry {
  private readonly entries = new Map<string, Entry>();       // stableId -> Entry
  private readonly wireToStable = new Map<string, string>(); // harnessChildId -> stableId
  private store: RecordStoreLike | null = null;
  /** Parent Session keys whose record rows have already been seeded (idempotent restore). */
  private readonly restored = new Set<string>();
  /** Chains saves so two concurrent saves never interleave their writes. */
  private saving: Promise<void> = Promise.resolve();

  constructor(
    /** Map a ROOT harness session id back to its Science Studio session key. */
    private readonly resolveSessionKey: (rootHarnessId: string) => string | undefined,
    /** Clock seam for deterministic tests. */
    private readonly now: () => string = () => new Date().toISOString(),
    /** The record-backed durable store (dsh pairs with the record, which has the 5 subagent methods). */
    store: RecordStoreLike | null = null,
  ) {
    this.store = store;
  }

  /**
   * Bind the durable store (the adapter does this in `init`, where it first
   * learns the `RecordStoreLike` from the composition). Idempotent: the first
   * binding wins, so a later re-init never shadows an attached record.
   */
  bindStore(store: RecordStoreLike): void {
    if (this.store === null) this.store = store;
  }

  /** Await every queued save (tests and graceful shutdown). */
  async flush(): Promise<void> {
    await this.saving;
  }

  /**
   * Compat seam for callers that await before reading (the record-backed
   * registry has no eager restore — `restore(sessionKey)` is explicit). Resolves
   * once any queued save settles, so a read after `noteX` is consistent.
   */
  async ready(): Promise<void> {
    await this.saving;
  }

  noteStarted(parentSessionId: string, childSessionId: string): void {
    if (parentSessionId === childSessionId || this.wireToStable.has(childSessionId)) return;
    const stableId = "subagent-" + randomUUID();
    const entry: Entry = {
      stableId,
      harnessChildId: childSessionId,
      parentHarnessId: parentSessionId,
      status: "running",
      startedAt: this.now(),
    };
    this.entries.set(stableId, entry);
    this.wireToStable.set(childSessionId, stableId);
    this.persist(entry);
  }

  noteDescriptor(childSessionId: string, info: SubagentDescriptorInfo): void {
    const entry = this.entryFor(childSessionId);
    if (entry === undefined) return;
    if (info.label !== undefined) entry.label = info.label;
    if (info.provider !== undefined) entry.provider = info.provider;
    this.persist(entry);
  }

  noteFinished(childSessionId: string, info: SubagentFinishedInfo): void {
    let entry = this.entryFor(childSessionId);
    if (entry === undefined) {
      // A `subagent.started` that was never observed (a dropped notification,
      // a service restart between start and finish) still leaves a finished
      // record: the payload carries its own parent. `startedAt` is stamped at
      // observation — the wire carries no timestamps (best-effort).
      if (info.parentSessionId === undefined) return;
      const stableId = "subagent-" + randomUUID();
      entry = {
        stableId,
        harnessChildId: childSessionId,
        parentHarnessId: info.parentSessionId,
        status: "running",
        startedAt: this.now(),
      };
      this.entries.set(stableId, entry);
      this.wireToStable.set(childSessionId, stableId);
    }
    entry.status = settleStatus(info.status, info.stopReason);
    if (info.provider !== undefined) entry.provider = info.provider;
    if (info.stopReason !== undefined) entry.stopReason = info.stopReason;
    entry.finishedAt = this.now();
    this.persist(entry);
  }

  /**
   * Capture the child's own settled transcript into the record row (docs/adr/0019:
   * the child's transcript is as durable + first-class as the parent's). The
   * adapter calls this on settle, resolving the wire child id to the live entry.
   */
  noteTranscript(childSessionId: string, transcript: PersistedTranscript): void {
    const entry = this.entryFor(childSessionId);
    if (entry === undefined) return;
    entry.transcript = { v: 1, status: transcript.status, messages: structuredClone(transcript.messages) };
    this.persist(entry);
  }

  /** Resolve a wire (harness child) id back to the stable id the panel + record use. */
  stableIdFor(harnessChildId: string): string | undefined {
    return this.wireToStable.get(harnessChildId);
  }

  /** Resolve a stable id back to the wire (harness child) id of a live entry. */
  harnessIdFor(stableId: string): string | undefined {
    return this.entries.get(stableId)?.harnessChildId;
  }

  /**
   * Seed the in-memory map from the record for one parent Session key — idempotent
   * per key. A restored row that was still `running` is settled to `aborted` (its
   * harness child died with the previous process — ADR 0016 addendum). A live
   * in-memory entry always wins over a restored row with the same stable id.
   */
  async restore(sessionKey: string): Promise<void> {
    if (this.restored.has(sessionKey)) return;
    this.restored.add(sessionKey);
    const store = this.store;
    if (store === null) return;
    let rows: Subagent[];
    try {
      rows = (await store.listSubagents?.(sessionKey)) ?? [];
    } catch (err) {
      console.warn("[dsh] subagent ledger restore failed", err);
      return;
    }
    for (const row of rows) {
      if (row.id === undefined || this.entries.has(row.id)) continue;
      const entry: Entry = {
        stableId: row.id,
        // The record does not store the wire key; a placeholder keeps the bridge 1:1.
        harnessChildId: RESTORED_WIRE_PREFIX + row.id,
        parentHarnessId: RESTORED_WIRE_PREFIX + row.id,
        parentSessionId: row.parentSessionId,
        status: row.status,
        ...(row.label === undefined ? {} : { label: row.label }),
        ...(row.provider === undefined ? {} : { provider: row.provider }),
        ...(row.stopReason === undefined ? {} : { stopReason: row.stopReason }),
        startedAt: row.startedAt,
        ...(row.finishedAt === undefined ? {} : { finishedAt: row.finishedAt }),
        ...(row.transcript === undefined ? {} : { transcript: row.transcript }),
      };
      if (entry.status === "running" && entry.finishedAt === undefined) {
        entry.status = "aborted";
        entry.finishedAt = this.now();
        if (entry.stopReason === undefined) entry.stopReason = "aborted";
      }
      this.entries.set(entry.stableId, entry);
    }
  }

  /** The live runs for one Session, newest first. SYNC + in-memory (the LIVE view).
   *  The `id` is the STABLE id. An entry whose root does not currently resolve (a
   *  `/new` remint, a mapping not published yet) is SKIPPED, never dropped, so it
   *  appears again once the root resolves. */
  list(sessionKey: string): SubagentRun[] {
    const out: SubagentRun[] = [];
    for (const entry of this.entries.values()) {
      const key = entry.parentSessionId ?? this.resolveSession(entry);
      if (key === undefined) continue;
      if (key !== sessionKey) continue;
      if (entry.parentSessionId !== key && this.store !== null) {
        // Keying settles here (the first listed read after a root resolve) so the
        // durable row names the session — only when there is something to persist.
        // Without a store the key stays live, so an entry that stops resolving
        // is skipped again (not destroyed), exactly the prior ledger rule.
        entry.parentSessionId = key;
        this.persist(entry);
      }
      out.push({
        id: entry.stableId,
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

  /** Resolve a wire (harness) child id to its live entry, if one exists. */
  private entryFor(harnessChildId: string): Entry | undefined {
    const stableId = this.wireToStable.get(harnessChildId);
    return stableId !== undefined ? this.entries.get(stableId) : undefined;
  }

  /** The Science Studio session key an entry belongs to: the nearest tracked
   *  ancestor wins; otherwise the ROOT (the first untracked ancestor in the
   *  parent chain) is resolved. `undefined` = not resolvable yet (the entry is
   *  skipped, not dropped, by `list`). */
  private resolveSession(entry: Entry): string | undefined {
    const seen = new Set<string>([entry.harnessChildId]);
    let id: string = entry.parentHarnessId;
    while (!seen.has(id)) {
      seen.add(id);
      const stableId = this.wireToStable.get(id);
      const ancestor = stableId !== undefined ? this.entries.get(stableId) : undefined;
      if (ancestor === undefined) return this.resolveSessionKey(id);
      id = ancestor.parentHarnessId;
    }
    return this.resolveSessionKey(entry.parentHarnessId);
  }

  private persist(entry: Entry): void {
    const store = this.store;
    if (store === null) return;
    const key = entry.parentSessionId ?? this.resolveSession(entry);
    if (key === undefined) return; // not resolvable yet — settle it on a later read/mutation
    if (entry.parentSessionId !== key) entry.parentSessionId = key;
    const row: Subagent = {
      id: entry.stableId,
      parentSessionId: key,
      origin: "subagent",
      status: entry.status,
      startedAt: entry.startedAt,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.provider === undefined ? {} : { provider: entry.provider }),
      ...(entry.stopReason === undefined ? {} : { stopReason: entry.stopReason }),
      ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
      ...(entry.transcript === undefined ? {} : { transcript: entry.transcript }),
    };
    // The `?.` guards the OPTIONAL record methods (Task 4 made them optional):
    // the dsh adapter KNOWS its store is the full record (which has them), but the
    // SEAM says optional — `?.` no-ops if the store is a non-record view (e.g. a
    // miswired `addRun`-only service sink) instead of null-deref'ing.
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await store.upsertSubagent?.(row);
      })
      .catch((err) => {
        console.warn("[dsh] subagent ledger save failed", err);
      });
  }
}
