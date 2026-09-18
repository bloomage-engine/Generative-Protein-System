import type { Id, RecordStore } from "@science-studio/record";
import { matchesSchedule, type CronRunStatus, type CronTask } from "@science-studio/cron";
import type {
  Environment,
  EnvironmentProvider,
  MessagePart,
  Principal,
  SessionState,
} from "@science-studio/transport";
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

  const resolveTarget = async (projectId: Id, task: CronTask) => {
    if (task.sessionId) {
      const named = await records.getSession(task.sessionId);
      return named && named.projectId === projectId ? named : null;
    }
    const sessions = await directory.listSessions(projectId);
    const newest = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return newest ?? null;
  };

  const fireWith = async (
    projectId: Id,
    environment: Environment,
    task: CronTask,
  ): Promise<CronRunStatus> => {
    const at = now().toISOString();
    const target = await resolveTarget(projectId, task);
    if (target === null) {
      await append(environment, task.id, { at, status: "error", message: "target session not found" });
      return "error";
    }
    const runKey = `${principal!.tenant}:${target.id}`;
    if (activeRuns.has(runKey)) {
      await append(environment, task.id, { at, status: "skipped-busy", sessionId: target.id });
      return "skipped-busy";
    }
    activeRuns.add(runKey);
    const session: SessionState = {
      sessionId: target.id,
      projectId,
      agentId: target.agentId,
      status: "idle",
      messages: [],
    };
    try {
      let text = "";
      for await (const delta of environment.adapter.run(session, [
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
        sessionId: target.id,
        ...(text ? { message: text.slice(0, maxChars) } : {}),
      });
      return "success";
    } catch (err) {
      await append(environment, task.id, {
        at,
        status: "error",
        sessionId: target.id,
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
            const environment = await environments.acquire(principal, project.id);
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
      const environment = await environments.acquire(principal, projectId);
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
