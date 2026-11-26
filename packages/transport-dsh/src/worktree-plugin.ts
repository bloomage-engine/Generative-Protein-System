/**
 * The CHILD-side worktree plugin (docs/adr/0025): a cordis plugin loaded into
 * the dsh harness child by a per-launch profile patch. It gives the agent the
 * `worktree_list`/`worktree_create`/`worktree_remove` tools, one `/worktree`
 * command and one system-prompt section — and NOTHING else: every tool is a
 * thin fetch of the transport-service's `/api/worktrees*` surface. The service
 * owns git (init, add, remove, branch delete); this plugin must never shell out
 * to git or write the repository itself.
 *
 * Like `bridge-plugin.ts`/`project-plugin.ts`/`cron-plugin.ts`/`hpc-plugin.ts`
 * it imports NOTHING from `@deepseek-ai/*` (pure repo packages are fine — the
 * patch loads this file by `file:` URL from the adapter's own `dist/`), never
 * writes to stdout (that is the child's JSON-RPC wire), fails soft, and is
 * inert without Project config.
 */

export const name = "gps-worktree";
export const inject = ["commands", "tools", "systemPrompt"];

/** Same env + default as the other child plugins: the service the child talks to. */
const DEFAULT_SERVICE = "http://127.0.0.1:3001";
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

export interface WorktreePluginConfig {
  /** The record-owned Project identity; absent → the plugin is inert. */
  project?: { id: string; name?: string; createdAt?: string };
  /** The worktree the agent is currently working in; absent → generic phrasing. */
  worktree?: { id: string; name: string; branch: string; root: string };
  /** The service base URL (wins over the env; the adapter passes the launch truth). */
  service?: string;
}

export interface WorktreeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    readonly render: (args: unknown, value: unknown) => unknown;
  };
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

export interface WorktreePromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

export interface WorktreeCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly handler: (invocation: {
    readonly agent: unknown;
    readonly rawInput: string;
    readonly signal: AbortSignal;
  }) =>
    | { kind: "success"; text: string }
    | { kind: "error"; text: string }
    | Promise<{ kind: "success"; text: string } | { kind: "error"; text: string }>;
}

export interface WorktreeHost {
  readonly tools?: { register(definition: WorktreeToolDefinition): () => void };
  readonly systemPrompt?: { section(section: WorktreePromptSection): () => void };
  readonly commands?: { register(definition: WorktreeCommandDefinition): () => void };
  effect?(body: () => () => void, label?: string): unknown;
}

/** stderr only — stdout is the child's JSON-RPC wire. */
function warn(message: string, detail: unknown): void {
  const text = detail instanceof Error ? detail.message : String(detail);
  process.stderr.write(`[dsh worktree] ${message}: ${text}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function textOutput(): WorktreeToolDefinition["output"] {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: String(value) }],
  };
}

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
    return { ok: false, error: `无法连接 Generative Protein System 服务（${err instanceof Error ? err.message : String(err)}）` };
  }
}

function describeWorktree(w: Record<string, unknown>, currentId: string | undefined): string {
  return `- ${String(w.name)}（分支 ${String(w.branch)}）${w.id === currentId ? " ⟵ 当前" : ""}`;
}

async function listWorktrees(
  service: string,
  projectId: string,
): Promise<{ ok: true; worktrees: Record<string, unknown>[] } | { ok: false; error: string }> {
  const res = await callService(service, projectId, "GET", "/api/worktrees");
  if (!res.ok) return { ok: false, error: res.error };
  const worktrees = Array.isArray(res.data.worktrees) ? (res.data.worktrees as Record<string, unknown>[]) : [];
  return { ok: true, worktrees };
}

/** `true` for a slug-shaped worktree id (the service mints ids this way). */
function isValidWorktreeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

export function apply(ctx: WorktreeHost, config: WorktreePluginConfig | undefined): void {
  const projectId = config?.project?.id;
  if (!projectId) return;
  const service = (config?.service ?? process.env.GPS_SERVICE_URL ?? DEFAULT_SERVICE).replace(/\/+$/, "");
  const current = config?.worktree;
  const currentId = current?.id;

  const listTool: WorktreeToolDefinition = {
    name: "worktree_list",
    description: "列出本项目的 worktree（git 分支）及其当前所在。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: textOutput(),
    async execute() {
      const res = await listWorktrees(service, projectId);
      if (!res.ok) return `查询失败：${res.error}`;
      if (res.worktrees.length === 0) return "本项目只有默认 worktree main。";
      return res.worktrees.map((worktree) => describeWorktree(worktree, currentId)).join("\n");
    },
  };

  const createTool: WorktreeToolDefinition = {
    name: "worktree_create",
    description:
      "为本项目创建一个新的 worktree（同一 git 仓库的独立 checkout，位于 .worktrees/ 下，拥有自己的一组会话）。创建后你自己的「工作目录不会改变」——新的 worktree 要由研究者在 Generative Protein System 界面上打开才能在其中工作。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "worktree 的人类可读名称。" },
        branch: { type: "string", description: "新分支名；省略则由名称派生。" },
        base: { type: "string", description: "起点分支；省略则为 main。" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const input = asRecord(args);
      const name = input?.name;
      if (typeof name !== "string" || name.trim() === "") return "参数无效：需要非空 name。";
      const body: Record<string, unknown> = { name: name.trim() };
      if (typeof input?.branch === "string" && input.branch.trim() !== "") body.branch = input.branch.trim();
      if (typeof input?.base === "string" && input.base.trim() !== "") body.base = input.base.trim();
      const res = await callService(service, projectId, "POST", "/api/worktrees", body, WRITE_TIMEOUT_MS);
      if (!res.ok) return `创建失败：${res.error}`;
      const worktree = asRecord(res.data.worktree);
      if (worktree === null) return "创建失败：服务未返回 worktree。";
      return `已创建 worktree：${describeWorktree(worktree, currentId).replace(/^- /, "")}`;
    },
  };

  const removeTool: WorktreeToolDefinition = {
    name: "worktree_remove",
    description:
      "删除一个 worktree（不可逆：会连同它的 checkout、分支以及该 worktree 下的所有会话一起删除；main 不可删除）。",
    parameters: {
      type: "object",
      properties: { worktree: { type: "string", description: "worktree 的 slug 形式 id。" } },
      required: ["worktree"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const worktree = asRecord(args)?.worktree;
      if (typeof worktree !== "string" || !isValidWorktreeId(worktree)) {
        return "参数无效：worktree 应为 slug 形式的 id。";
      }
      const res = await callService(
        service,
        projectId,
        "POST",
        `/api/worktrees/${encodeURIComponent(worktree)}/delete`,
        undefined,
        WRITE_TIMEOUT_MS,
      );
      if (!res.ok) return `删除失败：${res.error}`;
      return `已删除 worktree ${worktree}。`;
    },
  };

  const promptLines = current
    ? [
        `你当前在 worktree「${current.name}」（分支 ${current.branch}），根路径 ${current.root}。`,
        "同一项目的其他 worktree 是同一 git 仓库的独立 checkout，位于 .worktrees/ 下，各自拥有一组会话。",
        "你可以用 worktree_list / worktree_create / worktree_remove 查看与增删 worktree，但无法切换自己的工作目录——要换到别的 worktree，请在 Generative Protein System 界面上打开那个 worktree。",
      ]
    : [
        "本项目用 git worktree 管理多个独立 checkout：主 worktree 为 main，其余位于 .worktrees/ 下，各自拥有一组会话。",
        "你可以用 worktree_list / worktree_create / worktree_remove 查看与增删 worktree，但无法切换自己的工作目录——要换到别的 worktree，请在 Generative Protein System 界面上打开那个 worktree。",
      ];

  const prompt: WorktreePromptSection = {
    name: "gps-worktree",
    order: 470,
    text: promptLines.join("\n"),
  };

  const command: WorktreeCommandDefinition = {
    name: "worktree",
    description: "列出本项目的 worktree 分支",
    async handler() {
      const res = await listWorktrees(service, projectId);
      if (!res.ok) return { kind: "error", text: `查询失败：${res.error}` };
      const text =
        res.worktrees.length === 0
          ? "本项目只有默认 worktree main。"
          : res.worktrees.map((worktree) => describeWorktree(worktree, currentId)).join("\n");
      return { kind: "success", text };
    },
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
    for (const [label, tool] of [
      ["worktree_list", listTool],
      ["worktree_create", createTool],
      ["worktree_remove", removeTool],
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
    if (ctx.effect) ctx.effect(register, "gps-worktree");
    else register();
  } catch (err) {
    warn("worktree plugin disabled", err);
  }
}
