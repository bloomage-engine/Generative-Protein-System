/**
 * The pure half of the dsh skills surface (docs/adr/0020).
 *
 * Nothing here knows about cordis or the harness: {@link discoverSkills} scans
 * the SAME ranked filesystem roots `@deepseek-ai/dsh-skill-filesystem` scans —
 * one level deep, bundle (`<root>/<name>/SKILL.md`) or flat (`<root>/<name>.md`)
 * — and NEVER starts a child. The frontmatter codec mirrors the harness's own
 * rules (required `name`/`description`, kebab-case names, `disable-model-
 * invocation`/`user-invocable`, invalid entries dropped rather than fatal), and
 * {@link mergeSkills} reproduces the rank merge so a project skill can shadow a
 * user-level one.
 *
 * Project skills are ordinary Project Workspace files: install/remove go
 * through the `Workspace` seam, so the containment/symlink/size invariants are
 * inherited instead of a second write path.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SkillExistsError,
  SkillInvalidError,
  SkillNameInvalidError,
  SkillNotFoundError,
  WorkspaceNotFoundError,
  WorkspaceUnavailableError,
  type SkillInfo,
  type SkillInvocationPolicy,
  type SkillScope,
  type Workspace,
} from "@science-studio/transport";

/** The workspace-relative root a Project's own skills are installed under. */
export const PROJECT_SKILL_DIR = ".dsh/skills";

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_FILE = "SKILL.md";
const LEGACY_KEYS = ["disableModelInvocation", "modelInvocable", "userInvocable"] as const;

/** One discovery root and its priority (lower rank wins). */
export interface SkillRoot {
  scope: SkillScope;
  source: string;
  rank: number;
  dir: string;
}

export interface SkillRootsInput {
  /** The agent's working directory (the Project Workspace). */
  cwd: string;
  /** The harness home; its `skills/` is the user-dsh root. */
  dshHome: string;
  /** The shared agents home; its `skills/` is the user-agents root. */
  agentsHome: string;
}

/**
 * The roots in the harness's priority order. Project roots outrank user roots,
 * so a project skill of a given name shadows a user-level one.
 */
export function skillRoots(opts: SkillRootsInput): SkillRoot[] {
  return [
    { scope: "project", source: "project-dsh", rank: 100, dir: join(opts.cwd, ".dsh", "skills") },
    { scope: "project", source: "project-agents", rank: 200, dir: join(opts.cwd, ".agents", "skills") },
    { scope: "global", source: "user-dsh", rank: 400, dir: join(opts.dshHome, "skills") },
    { scope: "global", source: "user-agents", rank: 500, dir: join(opts.agentsHome, "skills") },
  ];
}

/** Whether a string is a valid kebab-case skill name. */
export function isSkillName(value: string): boolean {
  return SKILL_NAME_RE.test(value);
}

/** A parsed SKILL.md: the frontmatter facts and the instructions body. */
export interface ParsedSkill {
  name: string;
  description: string;
  invocation: SkillInvocationPolicy;
  body: string;
}

/** Parse a SKILL.md into its facts, or `null` when it is not a valid skill. */
export function parseSkill(content: string): ParsedSkill | null {
  const split = splitFrontmatter(content);
  if (split === null) return null;
  const { data, body } = split;
  if (LEGACY_KEYS.some((key) => key in data)) return null;
  const name = unquote(data["name"] ?? "");
  const description = unquote(data["description"] ?? "");
  if (!isSkillName(name) || description === "") return null;

  let modelInvocable = true;
  if ("disable-model-invocation" in data) {
    const value = parseBoolean(data["disable-model-invocation"] ?? "");
    if (value === null) return null;
    modelInvocable = !value;
  }
  let userInvocable = true;
  if ("user-invocable" in data) {
    const value = parseBoolean(data["user-invocable"] ?? "");
    if (value === null) return null;
    userInvocable = value;
  }
  return { name, description, invocation: { modelInvocable, userInvocable }, body };
}

/** Serialize a skill to SKILL.md text. Throws on an invalid name/description. */
export function serializeSkill(input: {
  name: string;
  description: string;
  body: string;
  invocation?: Partial<SkillInvocationPolicy>;
}): string {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!isSkillName(name)) throw new SkillNameInvalidError(input.name);
  if (description === "") throw new SkillInvalidError("description must not be empty");
  const lines = ["---", `name: ${name}`, `description: ${yamlScalar(description)}`];
  if (input.invocation?.modelInvocable === false) lines.push("disable-model-invocation: true");
  if (input.invocation?.userInvocable === false) lines.push("user-invocable: false");
  lines.push("---", "", input.body.trim(), "");
  return lines.join("\n");
}

/** Discover every skill under the roots, merged and rank-ordered by name. */
export async function discoverSkills(opts: SkillRootsInput): Promise<SkillInfo[]> {
  const found: Discovered[] = [];
  for (const root of skillRoots(opts)) await readRoot(root, opts.cwd, found);
  return mergeSkills(found);
}

/** A skill bundle's files: the SKILL.md text plus extra files keyed by bundle-relative path. */
export interface SkillBundleFiles {
  skill: string;
  /** Extra bundle files, kept as bytes so a binary `references/**` copies verbatim. */
  files: Record<string, string | Uint8Array>;
}

/**
 * Read a discovered skill's full bundle from the HOST filesystem — the copy
 * source for "install this global skill into the project". Resolves to `null`
 * for an unreadable source. Bundle-relative file keys exclude `SKILL.md`.
 */
export async function readSkillBundle(path: string): Promise<SkillBundleFiles | null> {
  try {
    if (path.endsWith(".md") && !path.endsWith(SKILL_FILE)) {
      return { skill: await readFile(path, "utf8"), files: {} };
    }
    const dir = dirname(path);
    const skill = await readFile(join(dir, SKILL_FILE), "utf8");
    const files = await readDirFiles(dir, dir, {});
    delete files[SKILL_FILE];
    return { skill, files };
  } catch {
    return null;
  }
}

/** The structured Project-skill install input (the adapter supplies the text). */
export interface ProjectSkillInstall {
  /** The SKILL.md text (already serialized, or copied from a global skill). */
  skill: string;
  /** Extra files keyed relative to the bundle directory. */
  files?: Record<string, string | Uint8Array>;
  overwrite?: boolean;
}

/**
 * Write a Project skill bundle through the workspace seam. The explicit
 * existence precheck (bundle OR flat form) is what enforces `overwrite` — the
 * write itself always replaces, since the decision is already made.
 */
export async function installProjectSkill(
  workspace: Workspace,
  input: ProjectSkillInstall,
): Promise<SkillInfo> {
  const parsed = parseSkill(input.skill);
  if (parsed === null) throw new SkillInvalidError("the skill document is invalid");
  const bundleDir = `${PROJECT_SKILL_DIR}/${parsed.name}`;
  const skillPath = `${bundleDir}/${SKILL_FILE}`;
  const flatPath = `${PROJECT_SKILL_DIR}/${parsed.name}.md`;
  const flatExists = await exists(workspace, flatPath);
  if (input.overwrite !== true && (flatExists || (await exists(workspace, skillPath)))) {
    throw new SkillExistsError(parsed.name);
  }
  await writeFile(workspace, skillPath, ensureTrailingNewline(input.skill));
  if (input.overwrite === true && flatExists) await workspace.delete?.(flatPath);
  for (const [rel, content] of Object.entries(input.files ?? {})) {
    const normalized = normalizeBundleRel(rel);
    if (normalized !== null) await writeFile(workspace, `${bundleDir}/${normalized}`, content);
  }
  return {
    name: parsed.name,
    description: parsed.description,
    scope: "project",
    source: "project-dsh",
    path: skillPath,
    invocation: parsed.invocation,
  };
}

/** Remove a Project skill, in either its bundle or its flat form. */
export async function removeProjectSkill(workspace: Workspace, name: string): Promise<void> {
  if (!isSkillName(name)) throw new SkillNameInvalidError(name);
  if (typeof workspace.delete !== "function") {
    throw new WorkspaceUnavailableError(`${PROJECT_SKILL_DIR}/${name}`);
  }
  const bundleDir = `${PROJECT_SKILL_DIR}/${name}`;
  const flatPath = `${PROJECT_SKILL_DIR}/${name}.md`;
  if (await exists(workspace, `${bundleDir}/${SKILL_FILE}`)) {
    await workspace.delete(bundleDir);
    return;
  }
  if (await exists(workspace, flatPath)) {
    await workspace.delete(flatPath);
    return;
  }
  throw new SkillNotFoundError(name);
}

// -- internals --------------------------------------------------------------

interface Discovered {
  info: SkillInfo;
  rank: number;
}

async function readRoot(root: SkillRoot, cwd: string, found: Discovered[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root.dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = entry.isDirectory()
      ? join(root.dir, entry.name, SKILL_FILE)
      : entry.isFile() && entry.name.endsWith(".md")
        ? join(root.dir, entry.name)
        : null;
    if (absolute === null) continue;
    const parsed = await readParsed(absolute);
    if (parsed === null) continue;
    found.push({
      rank: root.rank,
      info: {
        name: parsed.name,
        description: parsed.description,
        scope: root.scope,
        source: root.source,
        path: root.scope === "project" ? absolute.slice(cwd.length + 1) : absolute,
        invocation: parsed.invocation,
      },
    });
  }
}

async function readParsed(file: string): Promise<ParsedSkill | null> {
  try {
    return parseSkill(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function mergeSkills(found: Discovered[]): SkillInfo[] {
  const byName = new Map<string, Discovered[]>();
  for (const entry of found) {
    const list = byName.get(entry.info.name) ?? [];
    list.push(entry);
    byName.set(entry.info.name, list);
  }
  const out: SkillInfo[] = [];
  for (const name of [...byName.keys()].sort()) {
    const list = byName.get(name) ?? [];
    list.sort((a, b) => a.rank - b.rank);
    list.forEach((entry, index) => {
      out.push(index === 0 ? entry.info : { ...entry.info, shadowed: true });
    });
  }
  return out;
}

async function readDirFiles(
  root: string,
  dir: string,
  out: Record<string, string | Uint8Array>,
): Promise<Record<string, string | Uint8Array>> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      await readDirFiles(root, absolute, out);
    } else if (entry.isFile()) {
      out[absolute.slice(root.length + 1)] = await readFile(absolute);
    }
  }
  return out;
}

async function exists(workspace: Workspace, relPath: string): Promise<boolean> {
  try {
    await workspace.stat(relPath);
    return true;
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) return false;
    throw err;
  }
}

async function writeFile(
  workspace: Workspace,
  relPath: string,
  content: string | Uint8Array,
): Promise<void> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  await workspace.write(relPath, bytes, { createParents: true, overwrite: true });
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function normalizeBundleRel(rel: string): string | null {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean === "") return null;
  if (clean.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return clean;
}

interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

function splitFrontmatter(content: string): Frontmatter | null {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const data: Record<string, string> = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.startsWith(" ")) continue;
    const match = /^([A-Za-z0-9_-]+):[ \t]?(.*)$/.exec(line);
    if (match) data[match[1] ?? ""] = match[2] ?? "";
  }
  return { data, body: lines.slice(end + 1).join("\n").trim() };
}

function parseBoolean(raw: string): boolean | null {
  const value = unquote(raw).toLowerCase();
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  return null;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function yamlScalar(value: string): string {
  if (/[:#"'\\\n]/.test(value) || value !== value.trim()) return JSON.stringify(value);
  return value;
}
