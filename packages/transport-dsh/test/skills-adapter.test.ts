import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SkillExistsError,
  SkillInvalidError,
  SkillNameInvalidError,
  SkillNotFoundError,
  WorkspaceNotFoundError,
  WorkspaceUnavailableError,
  type FileStat,
  type RecordStoreLike,
  type Workspace,
} from "@gps/transport";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";

/**
 * The adapter's optional skills surface (docs/adr/0020): it scans the same
 * ranked roots the harness does, WITHOUT starting the child, and installs /
 * removes Project skills through the `Workspace` seam.
 */

const RECORD_STORE: RecordStoreLike = { addRun: async () => {} };

/** A real-filesystem Workspace rooted at `root` (enough for skills IO). */
function fsWorkspace(root: string): Workspace {
  return {
    list: async () => ({ path: "", entries: [] }),
    stat: async (relPath: string): Promise<FileStat> => {
      if (!existsSync(join(root, relPath))) throw new WorkspaceNotFoundError(relPath);
      return { path: relPath, name: relPath.split("/").pop() ?? relPath, kind: "file" } as FileStat;
    },
    open: async () => {
      throw new Error("not used");
    },
    write: async (relPath: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<FileStat> => {
      const abs = join(root, relPath);
      await mkdir(dirname(abs), { recursive: true });
      const bytes = data instanceof Uint8Array ? data : await streamToBytes(data);
      await writeFile(abs, bytes);
      return { path: relPath, name: relPath, kind: "file" } as FileStat;
    },
    delete: async (relPath: string): Promise<void> => {
      const abs = join(root, relPath);
      if (!existsSync(abs)) throw new WorkspaceNotFoundError(relPath);
      await rm(abs, { recursive: true, force: true });
    },
    toAgentPath: (relPath: string) => (relPath === "" ? root : `${root}/${relPath}`),
    toWorkspacePath: () => null,
  } as unknown as Workspace;
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function makeAdapter(opts: {
  cwd: string;
  dshHome: string;
  workspace?: Workspace;
}): Promise<{ adapter: DshRuntimeAdapter; started: () => boolean }> {
  let started = false;
  const adapter = new DshRuntimeAdapter({
    bindingDshHome: opts.dshHome,
    createClient: (): DshTurnClient => ({
      start: async () => {
        started = true;
      },
      close: async () => {},
      runTurn: async () => {},
    }),
  });
  await adapter.init({
    binding: { runtime: "dsh", config: {} },
    recordStore: RECORD_STORE,
    ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
  });
  return { adapter, started: () => started };
}

async function writeSkill(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

function skillDoc(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;
}

async function withAgentsHome<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.DSH_AGENTS_HOME;
  process.env.DSH_AGENTS_HOME = dir;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.DSH_AGENTS_HOME;
    else process.env.DSH_AGENTS_HOME = previous;
  }
}

test("skills lists project and global skills without starting the child", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-skills-adapter-"));
  const home = await mkdtemp(join(tmpdir(), "dsh-skills-adapter-home-"));
  const agents = await mkdtemp(join(tmpdir(), "dsh-skills-adapter-agents-"));
  try {
    await withAgentsHome(agents, async () => {
      await writeSkill(join(cwd, ".dsh", "skills", "alpha", "SKILL.md"), skillDoc("alpha", "A"));
      await writeSkill(join(home, "skills", "gamma", "SKILL.md"), skillDoc("gamma", "G"));
      const { adapter, started } = await makeAdapter({ cwd, dshHome: home, workspace: fsWorkspace(cwd) });
      const skills = await adapter.skills();
      assert.deepEqual(skills.map((s) => s.name).sort(), ["alpha", "gamma"]);
      assert.equal(skills.find((s) => s.name === "alpha")?.scope, "project");
      assert.equal(skills.find((s) => s.name === "gamma")?.scope, "global");
      assert.equal(started(), false, "a catalog read must not start the child");
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(agents, { recursive: true, force: true });
  }
});

test("installSkill writes a project skill; removeSkill deletes it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-skills-install-"));
  const home = await mkdtemp(join(tmpdir(), "dsh-skills-install-home-"));
  const agents = await mkdtemp(join(tmpdir(), "dsh-skills-install-agents-"));
  try {
    await withAgentsHome(agents, async () => {
      const { adapter } = await makeAdapter({ cwd, dshHome: home, workspace: fsWorkspace(cwd) });
      const info = await adapter.installSkill({ name: "alpha", description: "A", body: "Do it." });
      assert.equal(info.scope, "project");
      assert.equal(info.source, "project-dsh");
      const file = join(cwd, ".dsh", "skills", "alpha", "SKILL.md");
      assert.ok(existsSync(file));
      assert.match(await readFile(file, "utf8"), /name: alpha/);

      await assert.rejects(
        adapter.installSkill({ name: "alpha", description: "A", body: "b" }),
        SkillExistsError,
      );
      const replaced = await adapter.installSkill({ name: "alpha", description: "A2", body: "b", overwrite: true });
      assert.equal(replaced.description, "A2");

      const listed = await adapter.skills();
      assert.equal(listed.find((s) => s.name === "alpha")?.source, "project-dsh");

      await adapter.removeSkill("alpha");
      assert.equal(existsSync(join(cwd, ".dsh", "skills", "alpha")), false);
      await assert.rejects(adapter.removeSkill("alpha"), SkillNotFoundError);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(agents, { recursive: true, force: true });
  }
});

test("installSkill copies a global bundle into the project", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-skills-copy-"));
  const home = await mkdtemp(join(tmpdir(), "dsh-skills-copy-home-"));
  const agents = await mkdtemp(join(tmpdir(), "dsh-skills-copy-agents-"));
  try {
    await withAgentsHome(agents, async () => {
      await writeSkill(join(home, "skills", "gamma", "SKILL.md"), skillDoc("gamma", "G"));
      await writeSkill(join(home, "skills", "gamma", "references", "syntax.md"), "# Syntax\n");
      const { adapter } = await makeAdapter({ cwd, dshHome: home, workspace: fsWorkspace(cwd) });
      await adapter.installSkill({ copyFrom: { name: "gamma" } });
      assert.ok(existsSync(join(cwd, ".dsh", "skills", "gamma", "SKILL.md")));
      assert.equal(
        await readFile(join(cwd, ".dsh", "skills", "gamma", "references", "syntax.md"), "utf8"),
        "# Syntax\n",
      );
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(agents, { recursive: true, force: true });
  }
});

test("installSkill rejects invalid form input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-skills-invalid-"));
  const home = await mkdtemp(join(tmpdir(), "dsh-skills-invalid-home-"));
  const agents = await mkdtemp(join(tmpdir(), "dsh-skills-invalid-agents-"));
  try {
    await withAgentsHome(agents, async () => {
      const { adapter } = await makeAdapter({ cwd, dshHome: home, workspace: fsWorkspace(cwd) });
      await assert.rejects(
        adapter.installSkill({ name: "Not Kebab", description: "A", body: "b" }),
        SkillNameInvalidError,
      );
      await assert.rejects(
        adapter.installSkill({ name: "alpha", description: "  ", body: "b" }),
        SkillInvalidError,
      );
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(agents, { recursive: true, force: true });
  }
});

test("installSkill reports unavailable without a workspace", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-skills-nows-home-"));
  try {
    const { adapter } = await makeAdapter({ cwd: home, dshHome: home });
    await assert.rejects(
      adapter.installSkill({ name: "alpha", description: "A", body: "b" }),
      WorkspaceUnavailableError,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
