/**
 * The pure half of the project plugin: the research layout a Project Workspace
 * starts with, and the Project Brief (`PROJECT.md`) kept at its root.
 *
 * Nothing here knows about cordis or the harness. {@link ensureScaffold} is
 * idempotent and create-only — it adds what is missing and never overwrites,
 * renames, or deletes anything, so a re-run after a restart (or in a second
 * Session of the same Project) is a no-op. {@link replaceSection} and
 * {@link appendProgressEntry} are the whole document contract the two model
 * tools are built on.
 *
 * The Brief is a companion to the record, never its authority: the record owns
 * Project metadata and this template merely renders the copy it is given.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The Brief's file name at the Project Workspace root. */
export const PROJECT_FILE = "PROJECT.md";

/** The research layout, relative to the Project Workspace root (docs/adr/0012). */
export const SCAFFOLD_DIRECTORIES: readonly string[] = [
  "docs",
  "references",
  "data/raw",
  "data/interim",
  "data/processed",
  "scripts",
  "notebooks",
  "experiments",
  "results/figures",
  "models",
  "reports",
  "logs",
  "config",
  "scratch",
];

/** The Brief's section headings, in document order. */
export const PROJECT_SECTIONS = [
  "背景与动机",
  "研究目标与科学问题",
  "范围与非目标",
  "方法与技术路线",
  "关键节点",
  "进度日志",
  "当前状态与下一步",
  "关键决策",
  "数据与来源",
  "结果与发现",
  "未决问题与风险",
  "参考资料",
] as const;

export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

/** The record-owned Project identity the Brief renders. */
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
}

/** What one scaffold pass created (`[]` / `false` on an already-scaffolded root). */
export interface ScaffoldReport {
  createdDirectories: string[];
  createdProjectFile: boolean;
}

export interface EnsureScaffoldOptions {
  /** Override the layout; the default is {@link SCAFFOLD_DIRECTORIES}. */
  directories?: readonly string[];
  /** A `YYYY-MM-DD` stamp for the bootstrap log line; defaults to today. */
  now?: string;
}

/** Today's date as `YYYY-MM-DD` (the tools' only clock). */
export function today(now?: string): string {
  return now ?? new Date().toISOString().slice(0, 10);
}

/** The body of a section, or `undefined` when only its heading is intended. */
function sectionBody(section: ProjectSection, now: string): string | undefined {
  switch (section) {
    case "关键节点":
      return [
        "| 节点 | 目标日期 | 状态 |",
        "| --- | --- | --- |",
        `| 项目初始化 | ${now} | 已完成 |`,
      ].join("\n");
    case "进度日志":
      return `- ${now} 项目初始化`;
    default:
      return undefined;
  }
}

/** The initial Brief: identity from the record, every section heading present. */
export function renderProjectDocument(meta: ProjectMeta, now?: string): string {
  const stamp = today(now);
  const parts: string[] = [
    `# ${meta.name}`,
    "",
    `> Project \`${meta.id}\` · 创建于 ${meta.createdAt}`,
    "",
  ];
  for (const section of PROJECT_SECTIONS) {
    parts.push(`## ${section}`, "");
    const body = sectionBody(section, stamp);
    if (body !== undefined) parts.push(body, "");
  }
  return parts.join("\n");
}

/** Lay down the layout and the Brief where missing; report what was created. */
export function ensureScaffold(root: string, meta: ProjectMeta, options: EnsureScaffoldOptions = {}): ScaffoldReport {
  const directories = options.directories ?? SCAFFOLD_DIRECTORIES;
  const now = today(options.now);
  const createdDirectories: string[] = [];
  for (const directory of directories) {
    const absolute = join(root, directory);
    if (!existsSync(absolute)) {
      mkdirSync(absolute, { recursive: true });
      createdDirectories.push(directory);
    }
  }
  let createdProjectFile = false;
  const brief = join(root, PROJECT_FILE);
  if (!existsSync(brief)) {
    writeFileSync(brief, renderProjectDocument(meta, now), "utf8");
    createdProjectFile = true;
  }
  return { createdDirectories, createdProjectFile };
}

/** Read the Brief, or `null` when the root has none yet. */
export function readProjectDocument(root: string): string | null {
  const brief = join(root, PROJECT_FILE);
  return existsSync(brief) ? readFileSync(brief, "utf8") : null;
}

/** Write the Brief back. Callers only ever rewrite what {@link readProjectDocument} returned. */
export function writeProjectDocument(root: string, document: string): void {
  writeFileSync(join(root, PROJECT_FILE), document, "utf8");
}

/** The half-open line range of a `## section` body, or `null` when absent. */
function sectionBounds(lines: readonly string[], section: string): { start: number; end: number } | null {
  const heading = `## ${section}`;
  const start = lines.indexOf(heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]?.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Drop leading and trailing blank lines, keeping interior ones. */
function trimBlankEdges(lines: readonly string[]): string[] {
  let first = 0;
  let last = lines.length;
  while (first < last && (lines[first] ?? "").trim() === "") first += 1;
  while (last > first && (lines[last - 1] ?? "").trim() === "") last -= 1;
  return lines.slice(first, last);
}

/** Replace one section's body in place, or append the section when absent. */
export function replaceSection(document: string, section: string, content: string): string {
  const lines = document.split("\n");
  const bounds = sectionBounds(lines, section);
  const body = content === "" ? [] : content.split("\n");
  if (bounds === null) {
    const base = document.endsWith("\n") ? document : `${document}\n`;
    const text = body.length === 0 ? "" : `\n\n${content}`;
    return `${base}\n## ${section}${text}\n`;
  }
  const replacement = body.length === 0 ? [`## ${section}`, ""] : [`## ${section}`, "", ...body, ""];
  return [...lines.slice(0, bounds.start), ...replacement, ...lines.slice(bounds.end)].join("\n");
}

/** Append one dated line to the progress log, creating it when absent. */
export function appendProgressEntry(document: string, entry: string, now?: string): string {
  const line = `- ${today(now)} ${entry}`;
  const lines = document.split("\n");
  const bounds = sectionBounds(lines, "进度日志");
  if (bounds === null) {
    const base = document.endsWith("\n") ? document : `${document}\n`;
    return `${base}\n## 进度日志\n\n${line}\n`;
  }
  const body = [...trimBlankEdges(lines.slice(bounds.start + 1, bounds.end)), line];
  const replacement = ["## 进度日志", "", ...body, ""];
  return [...lines.slice(0, bounds.start), ...replacement, ...lines.slice(bounds.end)].join("\n");
}

/** Whether a heading is one of the Brief's known sections. */
export function isProjectSection(value: string): value is ProjectSection {
  return (PROJECT_SECTIONS as readonly string[]).includes(value);
}
