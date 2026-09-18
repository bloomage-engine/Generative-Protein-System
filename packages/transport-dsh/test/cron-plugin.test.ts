import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply,
  type CronCommandDefinition,
  type CronHost,
  type CronPromptSection,
  type CronToolDefinition,
} from "../src/cron-plugin.js";
import { parseTaskDoc, serializeTaskDoc } from "@science-studio/cron";

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };

function fakeHost(): {
  ctx: CronHost;
  commands: () => CronCommandDefinition[];
  tools: () => CronToolDefinition[];
  sections: () => CronPromptSection[];
} {
  const commands: CronCommandDefinition[] = [];
  const tools: CronToolDefinition[] = [];
  const sections: CronPromptSection[] = [];
  const ctx: CronHost = {
    commands: { register: (definition) => { commands.push(definition); return () => {}; } },
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
    systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
    effect: (body) => { body(); },
  };
  return { ctx, commands: () => commands, tools: () => tools, sections: () => sections };
}

function tool(host: ReturnType<typeof fakeHost>, name: string): CronToolDefinition {
  const found = host.tools().find((entry) => entry.name === name);
  assert.ok(found, `tool ${name} is registered`);
  return found;
}

test("a project config registers the four tools, /cron and the prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cron-"));
  try {
    const host = fakeHost();
    apply(host.ctx, { project: META, root });
    assert.deepEqual(host.tools().map((t) => t.name).sort(), [
      "schedule_create",
      "schedule_delete",
      "schedule_list",
      "schedule_set_enabled",
    ]);
    assert.deepEqual(host.commands().map((c) => c.name), ["cron"]);
    assert.deepEqual(host.sections().map((s) => s.name), ["science-studio-cron"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule_create writes a parseable task file; list and delete see it", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cron-"));
  try {
    const host = fakeHost();
    apply(host.ctx, { project: META, root });
    const create = tool(host, "schedule_create");
    const created = await create.execute(
      { name: "Daily digest", schedule: "0 9 * * *", prompt: "Summarize." },
      {},
    );
    assert.match(String(created), /daily-digest/);
    const path = join(root, ".science-studio", "cron", "daily-digest.md");
    assert.ok(existsSync(path));
    const parsed = parseTaskDoc("daily-digest", readFileSync(path, "utf8"));
    assert.ok("task" in parsed);
    assert.equal(parsed.task.prompt, "Summarize.");

    assert.match(String(await tool(host, "schedule_list").execute({}, {})), /Daily digest/);
    await tool(host, "schedule_delete").execute({ id: "daily-digest" }, {});
    assert.equal(existsSync(path), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule_create rejects an invalid schedule", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cron-"));
  try {
    const host = fakeHost();
    apply(host.ctx, { project: META, root });
    const outcome = await tool(host, "schedule_create").execute(
      { name: "x", schedule: "nope", prompt: "y" },
      {},
    );
    assert.match(String(outcome), /schedule/i);
    assert.equal(existsSync(join(root, ".science-studio")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule_delete rejects a traversal id and leaves files outside the cron dir untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cron-"));
  try {
    const host = fakeHost();
    apply(host.ctx, { project: META, root });
    const outside = join(root, "PROJECT.md");
    writeFileSync(outside, "sentinel");
    const outcome = await tool(host, "schedule_delete").execute({ id: "../../PROJECT" }, {});
    assert.match(String(outcome), /id/);
    assert.ok(existsSync(outside));
    assert.equal(readFileSync(outside, "utf8"), "sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule_set_enabled rejects a traversal id and does not modify a file outside the cron dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cron-"));
  try {
    const host = fakeHost();
    apply(host.ctx, { project: META, root });
    const outside = join(root, "PROJECT.md");
    const original = serializeTaskDoc({
      id: "outside",
      name: "Outside",
      schedule: "0 9 * * *",
      enabled: true,
      prompt: "Keep me.",
    });
    writeFileSync(outside, original);
    const outcome = await tool(host, "schedule_set_enabled").execute(
      { id: "../../PROJECT", enabled: false },
      {},
    );
    assert.match(String(outcome), /id/);
    assert.equal(readFileSync(outside, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
