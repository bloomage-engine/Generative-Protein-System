import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_FILE,
  appendProgressEntry,
  ensureScaffold,
  readProjectDocument,
  renderProjectDocument,
  replaceSection,
  writeProjectDocument,
  type ProjectMeta,
} from "../src/project-scaffold.js";

/**
 * The pure half of the project plugin: laying down the research layout and
 * reading/writing the Project Brief (`PROJECT.md`). No cordis, no harness — just
 * a directory and the document the tools operate on.
 */

const META: ProjectMeta = {
  id: "drought-screen",
  name: "抗旱基因筛选",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const NOW = "2026-09-15";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dsh-project-"));
}

test("ensureScaffold lays down the research layout and the brief", async () => {
  const root = await tempRoot();
  try {
    const report = ensureScaffold(root, META, { now: NOW });
    for (const dir of ["docs", "references", "data/raw", "data/interim", "data/processed", "scripts", "notebooks", "experiments", "results/figures", "models", "reports", "logs", "config", "scratch"]) {
      assert.ok(existsSync(join(root, dir)), `missing ${dir}`);
    }
    assert.ok(report.createdDirectories.includes("data/raw"));
    assert.equal(report.createdProjectFile, true);
    const brief = await readFile(join(root, PROJECT_FILE), "utf8");
    assert.equal(brief, renderProjectDocument(META, NOW));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureScaffold is idempotent and never overwrites what exists", async () => {
  const root = await tempRoot();
  try {
    ensureScaffold(root, META, { now: NOW });
    await writeFile(join(root, "docs", "notes.md"), "mine", "utf8");
    await writeFile(join(root, PROJECT_FILE), "# hand written\n", "utf8");

    const report = ensureScaffold(root, META, { now: NOW });
    assert.deepEqual(report.createdDirectories, []);
    assert.equal(report.createdProjectFile, false);
    assert.equal(await readFile(join(root, "docs", "notes.md"), "utf8"), "mine");
    assert.equal(await readFile(join(root, PROJECT_FILE), "utf8"), "# hand written\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderProjectDocument stamps the record-owned identity and a bootstrap log line", () => {
  const brief = renderProjectDocument(META, NOW);
  assert.match(brief, /^# 抗旱基因筛选\n/);
  assert.match(brief, /`drought-screen`/);
  assert.match(brief, /创建于 2026-09-01T00:00:00\.000Z/);
  assert.match(brief, /- 2026-09-15 项目初始化/);
});

test("replaceSection swaps one section body and leaves the rest alone", () => {
  const brief = renderProjectDocument(META, NOW);
  const updated = replaceSection(brief, "研究目标与科学问题", "R1: 找出耐旱候选基因");
  assert.match(updated, /## 研究目标与科学问题\n\nR1: 找出耐旱候选基因/);
  assert.match(updated, /## 背景与动机\n\n## 研究目标与科学问题/);
  assert.match(updated, /- 2026-09-15 项目初始化/);
});

test("replaceSection appends a missing section at the end", () => {
  const updated = replaceSection("# T\n", "参考资料", "- Smith 2020");
  assert.match(updated, /## 参考资料\n\n- Smith 2020/);
});

test("appendProgressEntry adds a dated line after the existing entries", () => {
  const brief = renderProjectDocument(META, NOW);
  const updated = appendProgressEntry(brief, "完成原始数据校验", "2026-09-16");
  const bootstrap = updated.indexOf("- 2026-09-15 项目初始化");
  const entry = updated.indexOf("- 2026-09-16 完成原始数据校验");
  assert.ok(bootstrap >= 0 && entry > bootstrap, "the new entry follows the bootstrap one");
});

test("appendProgressEntry creates the progress section when absent", () => {
  const updated = appendProgressEntry("# T\n", "第一条记录", "2026-09-16");
  assert.match(updated, /## 进度日志\n\n- 2026-09-16 第一条记录/);
});

test("readProjectDocument and writeProjectDocument round-trip the brief", async () => {
  const root = await tempRoot();
  try {
    assert.equal(readProjectDocument(root), null, "no brief before scaffolding");
    writeProjectDocument(root, "# T\n");
    assert.equal(readProjectDocument(root), "# T\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
