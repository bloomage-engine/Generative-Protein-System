import {
  DEFAULT_WORKTREE_ID,
  sessionWorktreeId,
  type Id,
  type RecordStore,
  type Session,
} from "@gps/record";
import { matchesSchedule, type CronRunStatus, type CronTask } from "@gps/cron";
import type {
  Environment,
  EnvironmentProvider,
  MessagePart,
  Principal,
  SessionState,
} from "@gps/transport";
import type { RecordDirectory } from "../directory.js";
import type { CronStore } from "./store.js";

declare module "fastify" {
  interface FastifyInstance {
    cronScheduler: CronScheduler;
  }
}

export interface CronScheduler {
  tick(): Promise<void>;
  fire(projectId: Id, id: string): Promise<{ status: CronRunStatus }>;
  start(): void;
  stop(): void;
}

export interface CronSchedulerDeps {
  store: CronStore;
  records: RecordStore;
  directory: RecordDirectory;
  environments: EnvironmentProvider;
  /** The service identity, or `null` when the deployment cannot grant one (hosted mode). */
  principal: Principal | null;
  /** The server's one-in-flight-run lock, shared with the transport route. */
  activeRuns: Set<string>;
  now?: () => Date;
  tickMs?: number;
  onError?: (err: unknown) => void;
  maxMessageChars?: number;
}

function textOf(parts: readonly MessagePart[]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * The wall-clock minute a fire belongs to, in the SAME local frame
 * `matchesSchedule` reads. Two ticks inside one minute share this key, so a task
 * is attempted at most once per scheduled minute even when the 30-s tick and the
 * minute granularity otherwise line up twice (docs/adr/0017).
 */
function minuteKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}-${at.getHours()}-${at.getMinutes()}`;
}

export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  const { store, records, directory, environments, principal, activeRuns } = deps;
  const now = deps.now ?? (() => new Date());
  const tickMs = deps.tickMs ?? 30_000;
  const onError = deps.onError ?? ((err) => console.error("[transport-service] cron tick failed", err));
  const maxChars = deps.maxMessageChars ?? 4000;
  /** Last minute `(projectId, taskId)` was fired from `tick()`; run-now is exempt. */
  const firedMinutes = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  const append = async (environment: Environment, id: string, entry: Parameters<CronStore["appendLog"]>[2]) => {
    try {
      await store.appendLog(environment.workspace, id, entry);
    } catch (err) {
      onError(err);
    }
  };

  /**
   * Scheduled runs are MAIN-only (docs/adr/0025): the scheduler always acquires
   * the Project's `main` environment (the Project root), so a Session that lives
   * in a linked worktree must never be targeted — its prompt would execute in
   * the wrong checkout and append a turn to the wrong transcript. `found` is the
   * only fireable result; `linked` is an explicit `sessionId` naming such a
   * Session (refused with a reason), `missing` is no eligible target at all.
   */
  const resolveTarget = async (
    projectId: Id,
    task: CronTask,
  ): Promise<
    | { kind: "found"; session: Session }
    | { kind: "missing" }
    | { kind: "linked" }
  > => {
    if (task.sessionId) {
      const named = await records.getSession(task.sessionId);
      if (!named || named.projectId !== projectId) return { kind: "missing" };
      if (sessionWorktreeId(named) !== DEFAULT_WORKTREE_ID) return { kind: "linked" };
      return { kind: "found", session: named };
    }
    // No explicit target: the newest MAIN-worktree Session only. A linked
    // worktree's Sessions are invisible to cron.
    const sessions = (await directory.listSessions(projectId)).filter(
      (session) => sessionWorktreeId(session) === DEFAULT_WORKTREE_ID,
    );
    const newest = sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return newest ? { kind: "found", session: newest } : { kind: "missing" };
  };

  const fireWith = async (
    projectId: Id,
    environment: Environment,
    task: CronTask,
  ): Promise<CronRunStatus> => {
    const at = now().toISOString();
    const target = await resolveTarget(projectId, task);
    if (target.kind !== "found") {
      const message =
        target.kind === "linked"
          ? "target session is not in the main worktree"
          : "target session not found";
      if (target.kind === "linked") {
        // Cron is main-only: surface WHY an explicit target was refused instead
        // of silently dropping the run (docs/adr/0025).
        console.warn(
          `[transport-service] cron task "${task.id}" names session "${task.sessionId}" in a linked worktree; scheduled runs are main-only`,
        );
      }
      await append(environment, task.id, { at, status: "error", message });
      return "error";
    }
    const session: Session = target.session;
    const runKey = `${principal!.tenant}:${session.id}`;
    if (activeRuns.has(runKey)) {
      await append(environment, task.id, { at, status: "skipped-busy", sessionId: session.id });
      return "skipped-busy";
    }
    activeRuns.add(runKey);
    const runSession: SessionState = {
      sessionId: session.id,
      projectId,
      agentId: session.agentId,
      status: "idle",
      messages: [],
    };
    try {
      let text = "";
      for await (const delta of environment.adapter.run(runSession, [
        { type: "add-message", message: { id: `cron-${at}-${task.id}`, role: "user", content: task.prompt } },
      ])) {
        if (delta.type === "reconcile") {
          const last = delta.messages[delta.messages.length - 1];
          if (last?.role === "assistant") text = textOf(last.parts);
        } else if (delta.type === "add-message" && delta.message.role === "assistant") {
          text = textOf(delta.message.parts);
        }
      }
      await append(environment, task.id, {
        at,
        status: "success",
        sessionId: session.id,
        ...(text ? { message: text.slice(0, maxChars) } : {}),
      });
      return "success";
    } catch (err) {
      await append(environment, task.id, {
        at,
        status: "error",
        sessionId: session.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return "error";
    } finally {
      activeRuns.delete(runKey);
    }
  };

  return {
    async tick() {
      if (ticking || principal === null) return;
      ticking = true;
      try {
        const at = now();
        const minute = minuteKey(at);
        for (const project of await directory.listProjects()) {
          // Per project AND per task: one unreadable workspace, unreachable
          // environment or foreign task must never suspend the rest of the tick.
          try {
            const environment = await environments.acquire(principal, project.id, DEFAULT_WORKTREE_ID);
            const { tasks } = await store.list(environment.workspace);
            for (const task of tasks) {
              try {
                if (!task.enabled) continue;
                if (!matchesSchedule(task.schedule, at)) continue;
                const key = `${project.id}:${task.id}`;
                if (firedMinutes.get(key) === minute) continue;
                firedMinutes.set(key, minute);
                await fireWith(project.id, environment, task);
              } catch (err) {
                onError(err);
              }
            }
          } catch (err) {
            onError(err);
          }
        }
      } catch (err) {
        onError(err);
      } finally {
        ticking = false;
      }
    },
    async fire(projectId, id) {
      if (principal === null) return { status: "error" };
      const environment = await environments.acquire(principal, projectId, DEFAULT_WORKTREE_ID);
      const task = await store.read(environment.workspace, id);
      if (task === null) return { status: "error" };
      return { status: await fireWith(projectId, environment, task) };
    },
    start() {
      if (principal === null || timer !== null) return;
      timer = setInterval(() => void this.tick(), tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
