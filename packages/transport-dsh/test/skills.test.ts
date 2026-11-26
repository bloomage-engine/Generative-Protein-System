import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SkillExistsError,
  SkillInvalidError,
  SkillNameInvalidError,
  SkillNotFoundError,
  WorkspaceNotFoundError,
  type FileStat,
  type Workspace,
} from "@gps/transport";
import {
  PROJECT_SKILL_DIR,
  discoverSkills,
  installProjectSkill,
  parseSkill,
  removeProjectSkill,
  serializeSkill,
  skillRoots,
} from "../src/skills.js";

/**
 * The pure half of the dsh skills surface (docs/adr/0020): the discovery roots
 * and their ranks, the SKILL.md frontmatter codec, and the merge that marks a
 * shadowed entry. It scans the filesystem WITHOUT launching a harness child, and
 * installs/removes Project skills through the `Workspace` seam.
 */

const SKILL = `---
name: molql
description: Translate natural-language structure queries into MolQL.
disable-model-invocation: true
user-invocable: false
---
Select the residues named in the request.
`;

test("skillRoots ranks project roots above user roots", () => {
  const roots = skillRoots({ cwd: "/proj", dshHome: "/home/.dsh", agentsHome: "/home/.agents" });
  assert.deepEqual(
    roots.map((r) => [r.source, r.scope, r.rank]),
    [
      ["project-dsh", "project", 100],
      ["project-agents", "project", 200],
      ["user-dsh", "global", 400],
      ["user-agents", "global", 500],
    ],
  );
  assert.equal(roots[0]?.dir, join("/proj", ".dsh", "skills"));
  assert.equal(roots[3]?.dir, join("/home/.agents", "skills"));
});

test("parseSkill reads the frontmatter and the body", () => {
  const parsed = parseSkill(SKILL);
  assert.ok(parsed);
  assert.equal(parsed.name, "molql");
  assert.equal(parsed.description, "Translate natural-language structure queries into MolQL.");
  assert.deepEqual(parsed.invocation, { modelInvocable: false, userInvocable: false });
  assert.equal(parsed.body, "Select the residues named in the request.");
});

test("parseSkill defaults both invocation faces to true", () => {
  const parsed = parseSkill("---\nname: alpha\ndescription: does a thing\n---\nbody\n");
  assert.ok(parsed);
  assert.deepEqual(parsed.invocation, { modelInvocable: true, userInvocable: true });
});

test("parseSkill rejects a malformed or unsupported skill", () => {
  assert.equal(parseSkill("no frontmatter here"), null);
  assert.equal(parseSkill("---\nname: alpha\n---\nbody\n"), null, "missing description");
  assert.equal(parseSkill("---\nname: Alpha\ndescription: x\n---\n"), null, "not kebab-case");
  assert.equal(parseSkill("---\nname: alpha\ndescription: x\nuserInvocable: false\n---\n"), null, "legacy key");
  assert.equal(
    parseSkill("---\nname: alpha\ndescription: x\ndisable-model-invocation: maybe\n---\n"),
    null,
    "invalid boolean",
  );
});

test("serializeSkill round-trips through parseSkill", () => {
  const text = serializeSkill({
    name: "alpha",
    description: "Does a thing: carefully",
    body: "Step one.\n",
    invocation: { modelInvocable: false, userInvocable: true },
  });
  const parsed = parseSkill(text);
  assert.ok(parsed);
  assert.equal(parsed.name, "alpha");
  assert.equal(parsed.description, "Does a thing: carefully");
  assert.deepEqual(parsed.invocation, { modelInvocable: false, userInvocable: true });
  assert.equal(parsed.body, "Step one.");
});

test("serializeSkill omits the invocation keys at their defaults", () => {
  const text = serializeSkill({ name: "alpha", description: "x", body: "b" });
  assert.doesNotMatch(text, /disable-model-invocation/);
  assert.doesNotMatch(text, /user-invocable/);
  assert.match(text, /^---\nname: alpha\ndescription: x\n---\n\nb\n$/);
});

test("serializeSkill rejects a bad name or an empty description", () => {
  assert.throws(() => serializeSkill({ name: "Not Kebab", description: "x", body: "b" }), SkillNameInvalidError);
  assert.throws(() => serializeSkill({ name: "alpha", description: "  ", body: "b" }), SkillInvalidError);
});

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeSkillFile(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

test("discoverSkills finds bundle and flat skills one level deep, dropping malformed ones", async () => {
  const cwd = await tempRoot("dsh-skills-proj-");
  const home = await tempRoot("dsh-skills-home-");
  const agents = await tempRoot("dsh-skills-agents-");
  try {
    await writeSkillFile(join(cwd, ".dsh", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\nA body\n");
    await writeSkillFile(join(cwd, ".dsh", "skills", "beta.md"), "---\nname: beta\ndescription: B\n---\nB body\n");
    await writeSkillFile(join(cwd, ".dsh", "skills", "broken", "SKILL.md"), "not a skill");
    await writeSkillFile(join(cwd, ".dsh", "skills", "alpha", "references", "deep", "SKILL.md"), "---\nname: deep\ndescription: D\n---\n");
    await writeSkillFile(join(home, "skills", "gamma", "SKILL.md"), "---\nname: gamma\ndescription: G\n---\n");

    const skills = await discoverSkills({ cwd, dshHome: home, agentsHome: agents });
    assert.deepEqual(skills.map((s) => s.name).sort(), ["alpha", "beta", "gamma"]);
    const alpha = skills.find((s) => s.name === "alpha");
    assert.equal(alpha?.scope, "project");
    assert.equal(alpha?.source, "project-dsh");
    const gamma = skills.find((s) => s.name === "gamma");
    assert.equal(gamma?.scope, "global");
    assert.equal(gamma?.source, "user-dsh");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(agents, { recursive: true, force: true });
  }
});

test("discoverSkills marks the farther same-name entry shadowed", async () => {
  const cwd = await tempRoot("dsh-skills-shadow-");
  const home = await tempRoot("dsh-skills-shadow-home-");
  try {
    await writeSkillFile(join(cwd, ".dsh", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: project\n---\n");
    await writeSkillFile(join(home, "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: user\n---\n");
    const skills = await discoverSkills({ cwd, dshHome: home, agentsHome: join(home, "agents") });
    const winner = skills.find((s) => s.name === "dup" && !s.shadowed);
    const loser = skills.find((s) => s.name === "dup" && s.shadowed);
    assert.equal(winner?.source, "project-dsh");
    assert.equal(loser?.source, "user-dsh");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

/** A minimal in-memory Workspace for the install/remove seam tests. */
function fakeWorkspace(): Workspace & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const ws = {
    files,
    list: async () => ({ path: "", entries: [] }),
    stat: async (relPath: string): Promise<FileStat> => {
      if (!files.has(relPath)) throw new WorkspaceNotFoundError(relPath);
      return { path: relPath, name: relPath.split("/").pop() ?? relPath, kind: "file" } as FileStat;
    },
    open: async () => {
      throw new Error("not used");
    },
    write: async (relPath: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<FileStat> => {
      const bytes = data instanceof Uint8Array ? data : await streamToBytes(data);
      files.set(relPath, new TextDecoder().decode(bytes));
      return { path: relPath, name: relPath, kind: "file" } as FileStat;
    },
    delete: async (relPath: string): Promise<void> => {
      const matches = [...files.keys()].filter((p) => p === relPath || p.startsWith(`${relPath}/`));
      if (matches.length === 0) throw new WorkspaceNotFoundError(relPath);
      for (const key of matches) files.delete(key);
    },
    toAgentPath: (relPath: string) => relPath,
    toWorkspacePath: (agentPath: string) => agentPath,
  };
  return ws as unknown as Workspace & { files: Map<string, string> };
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

test("installProjectSkill writes the bundle and returns the project skill", async () => {
  const workspace = fakeWorkspace();
  const info = await installProjectSkill(workspace, {
    skill: serializeSkill({ name: "alpha", description: "A", body: "Do it." }),
    files: { "references/syntax.md": "# Syntax\n" },
  });
  assert.equal(info.name, "alpha");
  assert.equal(info.scope, "project");
  assert.equal(info.source, "project-dsh");
  assert.equal(workspace.files.get(`${PROJECT_SKILL_DIR}/alpha/SKILL.md`)?.includes("name: alpha"), true);
  assert.equal(workspace.files.get(`${PROJECT_SKILL_DIR}/alpha/references/syntax.md`), "# Syntax\n");
});

test("installProjectSkill refuses an existing name without overwrite", async () => {
  const workspace = fakeWorkspace();
  const skill = serializeSkill({ name: "alpha", description: "A", body: "Do it." });
  await installProjectSkill(workspace, { skill });
  await assert.rejects(installProjectSkill(workspace, { skill }), SkillExistsError);
  const replaced = await installProjectSkill(workspace, {
    skill: serializeSkill({ name: "alpha", description: "A2", body: "Do it better." }),
    overwrite: true,
  });
  assert.equal(replaced.description, "A2");
});

test("installProjectSkill detects and replaces a flat skill file", async () => {
  const workspace = fakeWorkspace();
  workspace.files.set(`${PROJECT_SKILL_DIR}/alpha.md`, "---\nname: alpha\ndescription: flat\n---\n");
  const skill = serializeSkill({ name: "alpha", description: "A", body: "b" });
  await assert.rejects(installProjectSkill(workspace, { skill }), SkillExistsError);
  await installProjectSkill(workspace, { skill, overwrite: true });
  assert.equal(workspace.files.has(`${PROJECT_SKILL_DIR}/alpha.md`), false, "the flat form is removed");
  assert.equal(workspace.files.has(`${PROJECT_SKILL_DIR}/alpha/SKILL.md`), true);
});

test("installProjectSkill rejects an invalid skill document", async () => {
  const workspace = fakeWorkspace();
  await assert.rejects(installProjectSkill(workspace, { skill: "nope" }), SkillInvalidError);
});

test("removeProjectSkill deletes the bundle and reports an unknown name", async () => {
  const workspace = fakeWorkspace();
  await installProjectSkill(workspace, { skill: serializeSkill({ name: "alpha", description: "A", body: "b" }) });
  await removeProjectSkill(workspace, "alpha");
  assert.equal(workspace.files.has(`${PROJECT_SKILL_DIR}/alpha/SKILL.md`), false);
  await assert.rejects(removeProjectSkill(workspace, "alpha"), SkillNotFoundError);
  await assert.rejects(removeProjectSkill(workspace, "Bad Name"), SkillNameInvalidError);
});
