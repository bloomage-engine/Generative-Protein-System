/**
 * The CHILD-side project plugin: a cordis plugin loaded into the dsh harness
 * child by a per-launch profile patch, which lays down the research layout of a
 * Project Workspace and keeps its Project Brief (`PROJECT.md`) current
 * (docs/adr/0012).
 *
 * It speaks only to its own {@link ProjectHost} structural view — like
 * `bridge-plugin.ts` it imports NOTHING from `@deepseek-ai/*`, never writes to
 * stdout (the child's stdout is the JSON-RPC wire), and fails SOFT: a failing
 * registration logs one stderr line and leaves the child running. It is a no-op
 * unless its config carries Project metadata, so the dsh example apps (an
 * arbitrary `DSH_WORKSPACE`, no Project) never sprout a research layout.
 */
import {
  PROJECT_SECTIONS,
  appendProgressEntry,
  ensureScaffold,
  isProjectSection,
  readProjectDocument,
  replaceSection,
  writeProjectDocument,
  type ProjectMeta,
  type ScaffoldReport,
} from "./project-scaffold.js";

/** The module namespace metadata the cordis loader reads (see bridge-plugin.ts). */
export const name = "science-studio-project";
/** Only load once the harness exposes the services this plugin registers into. */
export const inject = ["commands", "tools", "systemPrompt"];

export interface ProjectPluginConfig {
  /** The record-owned Project identity the Brief renders. Absent → the plugin is inert. */
  project?: ProjectMeta;
  /** The Project Workspace root; defaults to the child's cwd. */
  root?: string;
  /** Override the layout; the default is `SCAFFOLD_DIRECTORIES`. */
  directories?: readonly string[];
}

export type ProjectCommandResult = { kind: "success"; text?: string } | { kind: "error"; text: string };

export interface ProjectCommandInvocation {
  readonly agent: unknown;
  readonly rawInput: string;
  readonly signal: AbortSignal;
}

export interface ProjectCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string };
  readonly handler: (invocation: ProjectCommandInvocation) => ProjectCommandResult | Promise<ProjectCommandResult>;
}

export interface ProjectToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    readonly render: (args: unknown, value: unknown) => unknown;
  };
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

export interface ProjectPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: unknown) => string);
}

/** The harness services this plugin registers into (a structural view, nothing imported). */
export interface ProjectHost {
  readonly commands?: { register(definition: ProjectCommandDefinition): () => void };
  readonly tools?: { register(definition: ProjectToolDefinition): () => void };
  readonly systemPrompt?: { section(section: ProjectPromptSection): () => void };
  on?(event: "agent/session-start", listener: () => void): () => void;
  effect?(body: () => () => void, label?: string): unknown;
}

/** stderr only — stdout is the child's JSON-RPC wire. */
function warn(message: string, detail: unknown): void {
  const text = detail instanceof Error ? detail.message : String(detail);
  process.stderr.write(`[dsh project] ${message}: ${text}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function textOutput(): ProjectToolDefinition["output"] {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: String(value) }],
  };
}

const SYSTEM_PROMPT = [
  "本项目的 Project Workspace 根部有一份 PROJECT.md（项目简报），记录项目的背景、研究目标、方法、关键节点、进度与结果。",
  "开始工作前先读它；在取得阶段性进展、完成关键节点或做出重要决策时，用 project_update 更新「关键节点」「当前状态与下一步」「结果与发现」等章节，用 project_log 追加一条进度记录。",
  "保持简报准确、简洁。它是给人读的伴生文档，不是事实来源：项目元数据以记录层为准。",
].join("\n");

/**
 * The plugin body. Registers an `agent/session-start` scaffold, a `/project`
 * command, the two Brief tools, and one system-prompt section — all inside one
 * effect so the fiber's unload disposes them together.
 */
export function apply(ctx: ProjectHost, config: ProjectPluginConfig | undefined): void {
  const project = config?.project;
  if (!project) return;

  const root = config.root ?? process.cwd();
  const directories = config.directories;

  const ensure = (): ScaffoldReport | null => {
    try {
      return ensureScaffold(root, project, directories ? { directories } : {});
    } catch (err) {
      warn("scaffold failed", err);
      return null;
    }
  };

  const updateTool: ProjectToolDefinition = {
    name: "project_update",
    description: "替换 PROJECT.md 中某个章节的正文（章节标题见枚举），用于记录研究目标、方法、关键节点、结果等。",
    parameters: {
      type: "object",
      properties: {
        section: { type: "string", enum: [...PROJECT_SECTIONS], description: "要替换的章节标题。" },
        content: { type: "string", description: "该章节的新正文（Markdown）。" },
      },
      required: ["section", "content"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const input = asRecord(args);
      const section = input?.["section"];
      const content = input?.["content"];
      if (typeof section !== "string" || typeof content !== "string") {
        return "参数无效：需要 { section: string, content: string }。";
      }
      if (!isProjectSection(section)) {
        return `未知章节「${section}」。可用章节：${PROJECT_SECTIONS.join("、")}。`;
      }
      const document = readProjectDocument(root);
      if (document === null) return "PROJECT.md 不存在，请先运行 /project 初始化项目。";
      try {
        writeProjectDocument(root, replaceSection(document, section, content));
        return `已更新「${section}」。`;
      } catch (err) {
        warn("project_update failed", err);
        return "写入 PROJECT.md 失败。";
      }
    },
  };

  const logTool: ProjectToolDefinition = {
    name: "project_log",
    description: "在 PROJECT.md 的「进度日志」章节追加一条带日期的记录，用于记录项目进度。",
    parameters: {
      type: "object",
      properties: { entry: { type: "string", description: "一条进度记录（一行）。" } },
      required: ["entry"],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args) {
      const entry = asRecord(args)?.["entry"];
      if (typeof entry !== "string" || entry.trim() === "") return "参数无效：需要非空 { entry: string }。";
      const document = readProjectDocument(root);
      if (document === null) return "PROJECT.md 不存在，请先运行 /project 初始化项目。";
      try {
        writeProjectDocument(root, appendProgressEntry(document, entry.trim()));
        return `已记录：${entry.trim()}`;
      } catch (err) {
        warn("project_log failed", err);
        return "写入 PROJECT.md 失败。";
      }
    },
  };

  const command: ProjectCommandDefinition = {
    name: "project",
    description: "确保项目目录结构与 PROJECT.md 简报就绪，并报告状态",
    handler: () => {
      const report = ensure();
      if (report === null) return { kind: "error", text: "初始化项目结构失败。" };
      const brief = report.createdProjectFile ? "PROJECT.md 已创建" : "PROJECT.md 已存在";
      const created = report.createdDirectories.length > 0 ? `，新建 ${report.createdDirectories.length} 个目录` : "";
      return { kind: "success", text: `${project.name}：项目结构就绪（${brief}${created}）。` };
    },
  };

  const prompt: ProjectPromptSection = { name: "science-studio-project", order: 450, text: SYSTEM_PROMPT };

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
    if (ctx.tools) tryRegister("project_update registration failed", () => ctx.tools!.register(updateTool));
    if (ctx.tools) tryRegister("project_log registration failed", () => ctx.tools!.register(logTool));
    if (ctx.systemPrompt) tryRegister("prompt section registration failed", () => ctx.systemPrompt!.section(prompt));
    if (ctx.on) tryRegister("session-start listener failed", () => ctx.on!("agent/session-start", () => void ensure()));
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
    if (ctx.effect) ctx.effect(register, "science-studio-project");
    else register();
  } catch (err) {
    warn("project plugin disabled", err);
  }
}
