import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply,
  type ProjectCommandDefinition,
  type ProjectHost,
  type ProjectPromptSection,
  type ProjectToolDefinition,
} from "../src/project-plugin.js";
import { PROJECT_FILE, readProjectDocument, type ProjectMeta } from "../src/project-scaffold.js";

/**
 * The project plugin against a scripted context: what it registers, that it
 * activates only for a real Project, and that its two tools drive the Brief.
 * Nothing here spawns a harness.
 */

const META: ProjectMeta = {
  id: "drought-screen",
  name: "抗旱基因筛选",
  createdAt: "2026-09-01T00:00:00.000Z",
};

function fakeHost(): {
  ctx: ProjectHost;
  commands: () => ProjectCommandDefinition[];
  tools: () => ProjectToolDefinition[];
  sections: () => ProjectPromptSection[];
  sessionStart: () => (() => void) | undefined;
} {
  const commands: ProjectCommandDefinition[] = [];
  const tools: ProjectToolDefinition[] = [];
  const sections: ProjectPromptSection[] = [];
  let sessionStart: (() => void) | undefined;
  const ctx: ProjectHost = {
    commands: { register: (definition) => { commands.push(definition); return () => {}; } },
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
    systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
    on: (event, listener) => {
      if (event === "agent/session-start") sessionStart = listener;
      return () => { sessionStart = undefined; };
    },
    effect: (body) => {
      body();
    },
  };
  return { ctx, commands: () => commands, tools: () => tools, sections: () => sections, sessionStart: () => sessionStart };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dsh-project-"));
}

function tool(host: ReturnType<typeof fakeHost>, name: string): ProjectToolDefinition {
  const found = host.tools().find((entry) => entry.name === name);
  assert.ok(found, `tool ${name} is registered`);
  return found;
}

test("a project config registers the command, the tools, the prompt and the scaffold listener", async () => {
  const root = await tempRoot();
  const host = fakeHost();
  try {
    apply(host.ctx, { project: META, root });
    assert.deepEqual(host.commands().map((entry) => entry.name), ["project"]);
    assert.deepEqual(host.tools().map((entry) => entry.name).sort(), ["project_log", "project_update"]);
    assert.deepEqual(host.sections().map((entry) => entry.name), ["science-studio-project"]);

    assert.equal(existsSync(join(root, "docs")), false, "nothing exists before a session starts");
    assert.ok(host.sessionStart(), "an agent/session-start listener is registered");
    host.sessionStart()?.();
    assert.ok(existsSync(join(root, "docs")));
    assert.ok(existsSync(join(root, "data", "raw")));
    assert.equal(existsSync(join(root, PROJECT_FILE)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with no project config the plugin is a no-op", async () => {
  const root = await tempRoot();
  const host = fakeHost();
  const original = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    apply(host.ctx, undefined);
    apply(host.ctx, { root });
    assert.deepEqual(host.commands(), []);
    assert.deepEqual(host.tools(), []);
    assert.deepEqual(host.sections(), []);
    assert.equal(host.sessionStart(), undefined);
    assert.equal(existsSync(join(root, "docs")), false);
  } finally {
    process.stderr.write = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("the /project command scaffolds and reports the brief", async () => {
  const root = await tempRoot();
  const host = fakeHost();
  try {
    apply(host.ctx, { project: META, root });
    const command = host.commands()[0];
    assert.ok(command);
    const result = await command.handler({ agent: {}, rawInput: "", signal: new AbortController().signal });
    assert.equal(result.kind, "success");
    assert.match(result.kind === "success" ? result.text ?? "" : "", /PROJECT\.md 已创建/);
    assert.ok(existsSync(join(root, "data", "raw")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project_update replaces exactly one section", async () => {
  const root = await tempRoot();
  const host = fakeHost();
  try {
    apply(host.ctx, { project: META, root });
    host.sessionStart()?.();
    await tool(host, "project_update").execute({ section: "研究目标与科学问题", content: "R1: 耐旱候选基因" }, {});
    const brief = readProjectDocument(root) ?? "";
    assert.match(brief, /## 研究目标与科学问题\n\nR1: 耐旱候选基因/);
    assert.match(brief, /## 背景与动机\n\n## 研究目标与科学问题/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project_log appends a dated entry", async () => {
  const root = await tempRoot();
  const host = fakeHost();
  try {
    apply(host.ctx, { project: META, root });
    host.sessionStart()?.();
    await tool(host, "project_log").execute({ entry: "完成原始数据校验" }, {});
    assert.match(readProjectDocument(root) ?? "", /- \d{4}-\d{2}-\d{2} 完成原始数据校验/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing brief is reported, never invented", async () => {
  const root = await tempRoot();
  const host = fakeHost();
  try {
    apply(host.ctx, { project: META, root });
    const outcome = await tool(host, "project_update").execute({ section: "研究目标与科学问题", content: "R1" }, {});
    assert.equal(typeof outcome, "string");
    assert.match(String(outcome), /PROJECT\.md/);
    assert.equal(readProjectDocument(root), null, "a tool never creates the brief");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
