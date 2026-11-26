/**
 * The CHILD-side cron plugin: a cordis plugin loaded into the dsh harness child
 * by a per-launch profile patch. It gives the agent the scheduling tools
 * (`schedule_create`/`list`/`delete`/`set_enabled`), a `/cron` command and one
 * system-prompt section. It only WRITES task files (the Project Workspace is the
 * child's cwd); the transport-service owns the scheduler and the run log.
 *
 * Like `bridge-plugin.ts`/`project-plugin.ts` it imports NOTHING from
 * `@deepseek-ai/*`, never writes to stdout, and fails soft.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CRON_DIR,
  cronLogPath,
  cronTaskPath,
  isValidSchedule,
  isValidTaskId,
  parseTaskDoc,
  serializeTaskDoc,
  taskIdFromPath,
  type CronTask,
} from "@gps/cron";

export const name = "gps-cron";
export const inject = ["commands", "tools", "systemPrompt"];

export interface CronPluginConfig {
  /** The record-owned Project identity; absent → the plugin is inert. */
  project?: { id: string; name: string; createdAt: string };
  /** The Project Workspace root; defaults to the child's cwd. */
  root?: string;
}

export interface CronCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string };
  readonly handler: (invocation: { readonly agent: unknown; readonly rawInput: string; readonly signal: AbortSignal }) =>
    | { kind: "success"; text?: string }
    | { kind: "error"; text: string }
    | Promise<{ kind: "success"; text?: string } | { kind: "error"; text: string }>;
}

export interface CronToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    readonly render: (args: unknown, value: unknown) => unknown;
  };
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

export interface CronPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

export interface CronHost {
  readonly commands?: { register(definition: CronCommandDefinition): () => void };
  readonly tools?: { register(definition: CronToolDefinition): () => void };
  readonly systemPrompt?: { section(section: CronPromptSection): () => void };
  effect?(body: () => () => void, label?: string): unknown;
}

function warn(message: string, detail: unknown): void {
  const text = detail instanceof Error ? detail.message : String(detail);
  process.stderr.write(`[dsh cron] ${message}: ${text}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function textOutput(): CronToolDefinition["output"] {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: String(value) }],
  };
}

function slug(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base === "" ? "task" : base;
}

function readTaskIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => taskIdFromPath(`${CRON_DIR}/${file}`))
    .filter((id): id is string => id !== null);
}

function listTasks(root: string): CronTask[] {
  const dir = join(root, CRON_DIR);
  const tasks: CronTask[] = [];
  for (const id of readTaskIds(dir)) {
    const parsed = parseTaskDoc(id, readFileSync(join(dir, `${id}.md`), "utf8"));
    if ("task" in parsed) tasks.push(parsed.task);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export function apply(ctx: CronHost, config: CronPluginConfig | undefined): void {
  const project = config?.project;
  if (!project) return;
  const root = config.root ?? process.cwd();
  const dir = join(root, CRON_DIR);

  const createTool: CronToolDefinition = {
    name: "schedule_create",
    description:
      "创建一个定时任务：到点后由服务向目标会话发送 prompt 并执行一次。schedule 为 5 字段 cron 表达式（分 时 日 月 周，如 `0 9 * * *` 表示每天 09:00）。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务名称。" },
        schedule: { type: "string", description: "5 字段 cron 表达式，如 `0 9 * * *`。" },
        prompt: { type: "string", description: "到点后发送给 agent 的指令。" },
        sessionId: { type: "string", description: "目标会话 id；省略则使用本项目最近活跃的会话。" },
        enabled: { type: "boolean", description: "是否启用，默认 true。" },
      },
      required: ["name", "schedule", "prompt"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const input = asRecord(args);
      const taskName = input?.["name"];
      const schedule = input?.["schedule"];
      const prompt = input?.["prompt"];
      if (typeof taskName !== "string" || taskName.trim() === "") return "参数无效：需要非空 name。";
      if (typeof schedule !== "string" || !isValidSchedule(schedule)) {
        return `无效的 schedule「${String(schedule)}」：需要 5 字段 cron 表达式，如 \`0 9 * * *\`。`;
      }
      if (typeof prompt !== "string" || prompt.trim() === "") return "参数无效：需要非空 prompt。";
      const sessionId = input?.["sessionId"];
      const enabled = input?.["enabled"];
      const existing = readTaskIds(dir);
      let id = slug(taskName);
      if (existing.includes(id)) {
        let suffix = 2;
        while (existing.includes(`${id}-${suffix}`)) suffix += 1;
        id = `${id}-${suffix}`;
      }
      const task: CronTask = {
        id,
        name: taskName.trim(),
        schedule: schedule.trim(),
        enabled: typeof enabled === "boolean" ? enabled : true,
        prompt,
        ...(typeof sessionId === "string" && sessionId !== "" ? { sessionId } : {}),
        createdAt: new Date().toISOString(),
      };
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(root, cronTaskPath(id)), serializeTaskDoc(task));
        return `已创建定时任务「${task.name}」（id: ${id}，schedule: ${task.schedule}）。`;
      } catch (err) {
        warn("schedule_create failed", err);
        return "写入任务文件失败。";
      }
    },
  };

  const listTool: CronToolDefinition = {
    name: "schedule_list",
    description: "列出本项目已有的定时任务。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: textOutput(),
    async execute() {
      try {
        const tasks = listTasks(root);
        if (tasks.length === 0) return "本项目还没有定时任务。";
        return tasks
          .map((task) => `- ${task.name}（id: ${task.id}，${task.schedule}，${task.enabled ? "启用" : "停用"}）`)
          .join("\n");
      } catch (err) {
        warn("schedule_list failed", err);
        return "读取任务列表失败。";
      }
    },
  };

  const deleteTool: CronToolDefinition = {
    name: "schedule_delete",
    description: "删除一个定时任务。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id。" } },
      required: ["id"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const id = asRecord(args)?.["id"];
      if (typeof id !== "string" || !isValidTaskId(id)) return "参数无效：id 不合法。";
      try {
        rmSync(join(root, cronTaskPath(id)), { force: true });
        rmSync(join(root, cronLogPath(id)), { force: true });
        return `已删除任务 ${id}。`;
      } catch (err) {
        warn("schedule_delete failed", err);
        return "删除任务失败。";
      }
    },
  };

  const setEnabledTool: CronToolDefinition = {
    name: "schedule_set_enabled",
    description: "启用或停用一个定时任务。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id。" },
        enabled: { type: "boolean", description: "true 启用，false 停用。" },
      },
      required: ["id", "enabled"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const input = asRecord(args);
      const id = input?.["id"];
      const enabled = input?.["enabled"];
      if (typeof id !== "string" || !isValidTaskId(id)) return "参数无效：id 不合法。";
      if (typeof enabled !== "boolean") {
        return "参数无效：需要 { id: string, enabled: boolean }。";
      }
      try {
        const path = join(root, cronTaskPath(id));
        if (!existsSync(path)) return `任务 ${id} 不存在。`;
        const parsed = parseTaskDoc(id, readFileSync(path, "utf8"));
        if ("error" in parsed) return `任务 ${id} 无法解析：${parsed.error}`;
        writeFileSync(path, serializeTaskDoc({ ...parsed.task, enabled }));
        return `任务 ${id} 已${enabled ? "启用" : "停用"}。`;
      } catch (err) {
        warn("schedule_set_enabled failed", err);
        return "更新任务失败。";
      }
    },
  };

  const command: CronCommandDefinition = {
    name: "cron",
    description: "列出本项目的定时任务",
    handler: () => {
      const tasks = listTasks(root);
      if (tasks.length === 0) return { kind: "success", text: "本项目还没有定时任务。" };
      return {
        kind: "success",
        text: tasks.map((task) => `- ${task.name}（${task.schedule}）`).join("\n"),
      };
    },
  };

  const prompt: CronPromptSection = {
    name: "gps-cron",
    order: 460,
    text: [
      "本项目支持定时任务：到点后由服务向目标会话发送一条 prompt 并执行一次，结果记录在会话中，同时写入任务日志文件。",
      `任务文件位于工作区 \`${CRON_DIR}/<id>.md\`（frontmatter 含 name/schedule/enabled/sessionId，正文是 prompt）。`,
      "用 schedule_create 创建、schedule_list 查看、schedule_delete 删除、schedule_set_enabled 启停；也可以用 /cron 查看。",
      "schedule 是 5 字段 cron（分 时 日 月 周），如 `0 9 * * *`（每天 09:00）、`0 * * * *`（每小时）；省略 sessionId 时默认使用本项目 main 工作树最近活跃的会话（定时任务只在 main 工作树运行，指向其它工作树的会话会被拒绝）。",
      "只应在用户明确要求定期执行某事时创建任务，不要主动安排。",
    ].join("\n"),
  };

  const register = (): (() => void) => {
    const disposers: (() => void)[] = [];
    const tryRegister = (label: string, registerOne: () => () => void): void => {
      try {
        disposers.push(registerOne());
      } catch (err) {
        warn(label, err);
      }
    };
    if (ctx.commands) tryRegister("command registration failed", () => ctx.commands!.register(command));
    if (ctx.tools) tryRegister("schedule_create registration failed", () => ctx.tools!.register(createTool));
    if (ctx.tools) tryRegister("schedule_list registration failed", () => ctx.tools!.register(listTool));
    if (ctx.tools) tryRegister("schedule_delete registration failed", () => ctx.tools!.register(deleteTool));
    if (ctx.tools) tryRegister("schedule_set_enabled registration failed", () => ctx.tools!.register(setEnabledTool));
    if (ctx.systemPrompt) tryRegister("prompt section registration failed", () => ctx.systemPrompt!.section(prompt));
    return () => {
      for (const disposer of disposers.reverse()) {
        try {
          disposer();
        } catch (err) {
          warn("dispose failed", err);
        }
      }
    };
  };

  try {
    if (ctx.effect) ctx.effect(register, "gps-cron");
    else register();
  } catch (err) {
    warn("cron plugin disabled", err);
  }
}
