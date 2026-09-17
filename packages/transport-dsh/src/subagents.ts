/**
 * The adapter-side, in-memory subagent ledger. It folds the harness child's
 * `subagent.started` / `subagent.finished` notifications and its child-session
 * `subagent/descriptor` events into one live view per Science Studio Session.
 *
 * LIVE-ONLY: nothing is persisted; the ledger is dropped with the adapter (and
 * the child generation it observed). The harness wire carries no timestamps, so
 * the adapter stamps them on arrival. The SDK's completion `status` is a coarse
 * ok/error; the richer `stopReason` is what the status is derived from.
 *
 * This module stays structural: it imports no `@deepseek-ai/*` type, so a
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
}

interface Entry {
  id: string;
  parentHarnessId: string;
  label?: string;
  provider?: string;
  status: SubagentRun["status"];
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
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

export class SubagentRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    /** Map a ROOT harness session id back to its Science Studio session key. */
    private readonly resolveSessionKey: (rootHarnessId: string) => string | undefined,
    /** Clock seam for deterministic tests. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  noteStarted(parentSessionId: string, childSessionId: string): void {
    if (parentSessionId === childSessionId || this.entries.has(childSessionId)) return;
    this.entries.set(childSessionId, {
      id: childSessionId,
      parentHarnessId: parentSessionId,
      status: "running",
      startedAt: this.now(),
    });
  }

  noteDescriptor(childSessionId: string, info: SubagentDescriptorInfo): void {
    const entry = this.entries.get(childSessionId);
    if (!entry) return;
    if (info.label !== undefined) entry.label = info.label;
    if (info.provider !== undefined) entry.provider = info.provider;
  }

  noteFinished(childSessionId: string, info: SubagentFinishedInfo): void {
    const entry = this.entries.get(childSessionId);
    if (!entry) return;
    entry.status = settleStatus(info.status, info.stopReason);
    if (info.provider !== undefined) entry.provider = info.provider;
    if (info.stopReason !== undefined) entry.stopReason = info.stopReason;
    entry.finishedAt = this.now();
  }

  /** The live runs for one Session, newest first. Non-destructive: an entry
   *  whose root does not currently resolve (a `/new` remint, a mapping not
   *  published yet) is SKIPPED, never dropped, so it appears again once the
   *  root resolves. */
  list(sessionKey: string): SubagentRun[] {
    const out: SubagentRun[] = [];
    for (const entry of this.entries.values()) {
      const root = this.rootOf(entry);
      const key = this.resolveSessionKey(root);
      if (key === undefined) continue;
      if (key !== sessionKey) continue;
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

  /** Walk parent links until one is not itself a tracked child; that parent is
   *  the root session the delegation belongs to. */
  private rootOf(entry: Entry): string {
    let root = entry.id;
    let parent = entry.parentHarnessId;
    const seen = new Set<string>([root]);
    while (!seen.has(parent)) {
      seen.add(parent);
      const parentEntry = this.entries.get(parent);
      if (!parentEntry) return parent;
      root = parent;
      parent = parentEntry.parentHarnessId;
    }
    return root;
  }
}
