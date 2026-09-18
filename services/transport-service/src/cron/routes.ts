import type { FastifyInstance } from "fastify";
import { isValidSchedule, isValidTaskId, type CronTask } from "@science-studio/cron";
import type { ProjectScopes } from "../project-scope.js";
import type { CronScheduler } from "./scheduler.js";
import type { CronStore } from "./store.js";

export interface CronRouteDeps {
  scope: ProjectScopes;
  store: CronStore;
  scheduler: CronScheduler;
}

interface TaskBody {
  name?: unknown;
  schedule?: unknown;
  prompt?: unknown;
  sessionId?: unknown;
  enabled?: unknown;
}

function parseTaskBody(body: unknown): { input: Omit<CronTask, "id"> } | { error: string } {
  const raw = (body ?? {}) as TaskBody;
  if (typeof raw.name !== "string" || raw.name.trim() === "") return { error: "name is required" };
  if (typeof raw.schedule !== "string" || !isValidSchedule(raw.schedule)) {
    return { error: "a valid 5-field schedule is required" };
  }
  if (typeof raw.prompt !== "string") return { error: "prompt is required" };
  const sessionId = typeof raw.sessionId === "string" && raw.sessionId !== "" ? raw.sessionId : undefined;
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
  return {
    input: {
      name: raw.name.trim(),
      schedule: raw.schedule.trim(),
      prompt: raw.prompt,
      enabled,
      ...(sessionId ? { sessionId } : {}),
    },
  };
}

function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base === "" ? "task" : base;
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function registerCronRoutes(app: FastifyInstance, deps: CronRouteDeps): void {
  const { scope, store, scheduler } = deps;

  app.get("/api/cron", async (request, reply) =>
    scope.withWorkspace(request, reply, async ({ environment }) => store.list(environment.workspace)),
  );

  app.get("/api/cron/task", async (request, reply) => {
    const { id } = request.query as { id?: string };
    if (!id || !isValidTaskId(id)) return reply.code(400).send({ error: "a valid id is required" });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      const task = await store.read(environment.workspace, id);
      if (task === null) return reply.code(404).send({ error: `task not found: ${id}` });
      return { task };
    });
  });

  app.post("/api/cron/task", async (request, reply) => {
    const parsed = parseTaskBody(request.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      const { tasks } = await store.list(environment.workspace);
      const taken = new Set(tasks.map((task) => task.id));
      const task = await store.write(environment.workspace, {
        id: uniqueId(slug(parsed.input.name), taken),
        ...parsed.input,
      });
      return reply.code(201).send({ task });
    });
  });

  app.put("/api/cron/task", async (request, reply) => {
    const { id } = request.query as { id?: string };
    if (!id || !isValidTaskId(id)) return reply.code(400).send({ error: "a valid id is required" });
    const parsed = parseTaskBody(request.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      const existing = await store.read(environment.workspace, id);
      if (existing === null) return reply.code(404).send({ error: `task not found: ${id}` });
      const task = await store.write(environment.workspace, {
        id,
        ...parsed.input,
        ...(existing.createdAt ? { createdAt: existing.createdAt } : {}),
      });
      return { task };
    });
  });

  app.post("/api/cron/task/delete", async (request, reply) => {
    const { id } = request.query as { id?: string };
    if (!id || !isValidTaskId(id)) return reply.code(400).send({ error: "a valid id is required" });
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      await store.remove(environment.workspace, id);
      return { ok: true };
    });
  });

  app.post("/api/cron/task/run", async (request, reply) => {
    const { id } = request.query as { id?: string };
    if (!id || !isValidTaskId(id)) return reply.code(400).send({ error: "a valid id is required" });
    const { projectId } = await scope.acquire(request);
    return scheduler.fire(projectId, id);
  });
}
