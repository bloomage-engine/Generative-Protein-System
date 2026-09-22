/**
 * The CHILD-side HPC plugin (docs/adr/0024): a cordis plugin loaded into the dsh
 * harness child by a per-launch profile patch. It gives the agent the five
 * `hpc_*` tools and one system-prompt section — and NOTHING else: every tool is
 * a thin fetch of the transport-service's `/api/hpc/*` surface. The service is
 * the only SSH client in the product; this plugin must never reach the network
 * toward a cluster or write the Binding file.
 *
 * Like `bridge-plugin.ts`/`project-plugin.ts`/`cron-plugin.ts` it imports
 * NOTHING from `@deepseek-ai/*` (pure repo packages are fine — the patch loads
 * this file by `file:` URL from the adapter's own `dist/`), never writes to
 * stdout, fails soft, and is inert without Project config.
 */
import { isValidComputeJobId } from "@science-studio/hpc";

export const name = "science-studio-hpc";
export const inject = ["tools", "systemPrompt"];

/** Same env + default as the molql plugin: the service the child talks to. */
const DEFAULT_SERVICE = "http://127.0.0.1:3001";
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 60_000;

export interface HpcPluginConfig {
  /** The record-owned Project identity; absent → the plugin is inert. */
  project?: { id: string; name?: string; createdAt?: string };
  /** The service base URL (wins over the env; the adapter passes the launch truth). */
  service?: string;
}

export interface HpcToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    readonly render: (args: unknown, value: unknown) => unknown;
  };
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

export interface HpcPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

export interface HpcHost {
  readonly tools?: { register(definition: HpcToolDefinition): () => void };
  readonly systemPrompt?: { section(section: HpcPromptSection): () => void };
  effect?(body: () => () => void, label?: string): unknown;
}

function warn(message: string, detail: unknown): void {
  const text = detail instanceof Error ? detail.message : String(detail);
  process.stderr.write(`[dsh hpc] ${message}: ${text}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function textOutput(): HpcToolDefinition["output"] {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: String(value) }],
  };
}

const STATE_LABEL: Record<string, string> = {
  submitted: "已提交",
  pending: "排队中",
  running: "运行中",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
  unknown: "状态未知",
};

/**
 * One JSON call to the service. `null` result means "service unreachable";
 * any non-2xx answer surfaces the service's OWN `{error}` text (docs/adr/0021
 * — the client shows the service's diagnosis, never a re-shaped one).
 */
async function callService(
  service: string,
  projectId: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const url = `${service}${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`;
  try {
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      /* a non-JSON answer keeps data = {} — the status text below carries it */
    }
    if (!response.ok) {
      const serverError = typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
      return { ok: false, error: serverError };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `无法连接 Science Studio 服务（${err instanceof Error ? err.message : String(err)}）` };
  }
}

function describeJob(job: Record<string, unknown>): string {
  const state = STATE_LABEL[String(job.state)] ?? String(job.state);
  const remote = job.remoteJobId ? `，远端 #${job.remoteJobId}` : "";
  const exit = typeof job.exitCode === "number" ? `，exit ${job.exitCode}` : "";
  return `- [${state}] ${job.name}（id: ${job.id}${remote}${exit}）`;
}

export function apply(ctx: HpcHost, config: HpcPluginConfig | undefined): void {
  const projectId = config?.project?.id;
  if (!projectId) return;
  const service = (config?.service ?? process.env.SCIENCE_STUDIO_SERVICE_URL ?? DEFAULT_SERVICE).replace(/\/+$/, "");

  const submitTool: HpcToolDefinition = {
    name: "hpc_submit",
    description:
      "向本项目绑定的 HPC 端点提交一个 Compute Job。slurm 端点：script 为完整的 sbatch 脚本正文（服务会自动在最前面追加 #SBATCH 头，你在脚本内写的 #SBATCH 会覆盖同名默认）；linux 端点：command 为要在远端运行的 shell 命令/脚本。提交前先用 hpc_jobs 查看现有任务，绝不重复提交。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务的人类可读名称。" },
        script: { type: "string", description: "sbatch 脚本正文（slurm 端点）。" },
        command: { type: "string", description: "shell 命令（linux 端点）；与 script 二选一。" },
        partition: { type: "string", description: "slurm 分区；省略则用绑定/端点默认。" },
        nodes: { type: "number", description: "节点数。" },
        ntasks: { type: "number", description: "任务数。" },
        cpusPerTask: { type: "number", description: "每任务 CPU 数。" },
        mem: { type: "string", description: "内存请求，如 4G。" },
        time: { type: "string", description: "墙钟时长，如 2:00:00。" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const input = asRecord(args);
      if (typeof input.name !== "string" || input.name.trim() === "") return "参数无效：需要非空 name。";
      const script = input.script;
      const command = input.command;
      const hasText =
        (typeof script === "string" && script.trim() !== "") ||
        (typeof command === "string" && command.trim() !== "");
      if (!hasText) return "参数无效：需要 script（slurm）或 command（linux）。";
      const res = await callService(service, projectId, "POST", "/api/hpc/jobs", input, WRITE_TIMEOUT_MS);
      if (!res.ok) return `提交失败：${res.error}`;
      const job = asRecord(res.data.job);
      return `已提交 Compute Job：${describeJob(job).replace(/^- /, "")}`;
    },
  };

  const jobsTool: HpcToolDefinition = {
    name: "hpc_jobs",
    description:
      "列出本项目最近的 Compute Job 及状态（数据来自服务侧账本，15 秒内对账一次）。可用 state 过滤（如 running、pending）。",
    parameters: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["submitted", "pending", "running", "completed", "failed", "cancelled", "unknown"],
          description: "只列出该状态的行。",
        },
      },
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const state = asRecord(args).state;
      const path =
        typeof state === "string" ? `/api/hpc/jobs?state=${encodeURIComponent(state)}` : "/api/hpc/jobs";
      const res = await callService(service, projectId, "GET", path);
      if (!res.ok) return `查询失败：${res.error}`;
      const jobs = Array.isArray(res.data.jobs) ? (res.data.jobs as Record<string, unknown>[]) : [];
      if (jobs.length === 0) return "本项目还没有 Compute Job。";
      return jobs.slice(0, 30).map((job) => describeJob(job)).join("\n");
    },
  };

  const cancelTool: HpcToolDefinition = {
    name: "hpc_cancel",
    description: "取消一个 Compute Job（slurm: scancel；linux: kill）。",
    parameters: {
      type: "object",
      properties: { jobId: { type: "string", description: "账本行 id（cjob-…），不是远端 #id。" } },
      required: ["jobId"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const jobId = asRecord(args).jobId;
      if (typeof jobId !== "string" || !isValidComputeJobId(jobId)) return "参数无效：jobId 应为 cjob-… 形式的账本 id。";
      const res = await callService(service, projectId, "POST", `/api/hpc/jobs/${encodeURIComponent(jobId)}/cancel`);
      if (!res.ok) return `取消失败：${res.error}`;
      return `已请求取消：${describeJob(asRecord(res.data.job)).replace(/^- /, "")}`;
    },
  };

  const logsTool: HpcToolDefinition = {
    name: "hpc_logs",
    description: "查看一个 Compute Job 的日志尾部（stdout/stderr）。",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "账本行 id（cjob-…）。" },
        stream: { type: "string", enum: ["stdout", "stderr"], description: "默认 stdout。" },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const input = asRecord(args);
      const jobId = input.jobId;
      if (typeof jobId !== "string" || !isValidComputeJobId(jobId)) return "参数无效：jobId 应为 cjob-… 形式的账本 id。";
      const stream = input.stream === "stderr" ? "stderr" : "stdout";
      const res = await callService(service, projectId, "GET", `/api/hpc/jobs/${encodeURIComponent(jobId)}/logs?stream=${stream}`);
      if (!res.ok) return `读取失败：${res.error}`;
      const text = typeof res.data.text === "string" ? res.data.text : "";
      return text === "" ? "（日志为空）" : text.slice(-20_000);
    },
  };

  const filesTool: HpcToolDefinition = {
    name: "hpc_files",
    description:
      "在 Project Workspace 与端点的 Remote Work Dir 之间显式搬运一个文件（action=upload|download；不做自动同步）。workspacePath 为工作区相对路径，remoteRelPath 为 Remote Work Dir 下的相对路径。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["upload", "download"], description: "方向。" },
        workspacePath: { type: "string", description: "Project Workspace 相对路径。" },
        remoteRelPath: { type: "string", description: "Remote Work Dir 相对路径。" },
      },
      required: ["action", "workspacePath", "remoteRelPath"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const input = asRecord(args);
      if (input.action !== "upload" && input.action !== "download") return "参数无效：action 必须是 upload 或 download。";
      const res = await callService(service, projectId, "POST", "/api/hpc/files", input, WRITE_TIMEOUT_MS);
      if (!res.ok) return `传输失败：${res.error}`;
      return input.action === "upload"
        ? `已上传到远端：${String(res.data.remotePath)}`
        : `已下载到工作区：${String(res.data.workspacePath)}`;
    },
  };

  const prompt: HpcPromptSection = {
    name: "science-studio-hpc",
    order: 465,
    text: [
      "本项目可把计算提交到外部 HPC 集群（Compute Job），由 Science Studio 服务通过 SSH 代你执行与对账。",
      "端点与默认参数由研究者在 设置 → HPC 中配置，本项目的绑定写在 `.science-studio/hpc.md`（只读）。",
      "Remote Work Dir 是本项目在集群上的家目录；Compute Job 只看得见它，看不见 Project Workspace——大文件请在集群上就位，或用 hpc_files 显式搬运。",
      `工作约定：提交前先 \`hpc_jobs\` 查看现状，在对话中说明申请的资源再调用 \`hpc_submit\`；绝不重复提交。提交返回 502「may be queued」时先去集群确认，不要盲目重试。`,
      "运行状态由服务每 15 秒对账一次；日志用 hpc_logs，取消用 hpc_cancel。",
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
    for (const [label, tool] of [
      ["hpc_submit", submitTool],
      ["hpc_jobs", jobsTool],
      ["hpc_cancel", cancelTool],
      ["hpc_logs", logsTool],
      ["hpc_files", filesTool],
    ] as const) {
      if (ctx.tools) tryRegister(`${label} registration failed`, () => ctx.tools!.register(tool));
    }
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
    if (ctx.effect) ctx.effect(register, "science-studio-hpc");
    else register();
  } catch (err) {
    warn("hpc plugin disabled", err);
  }
}
