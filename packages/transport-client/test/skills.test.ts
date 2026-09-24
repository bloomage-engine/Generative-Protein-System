import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillsRequestError, fetchSkills, installSkill, removeSkill } from "../src/skills.js";

interface Call {
  url: string;
  method: string;
  body?: string;
}

async function withFetch(
  status: number,
  body: unknown,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const SKILL = {
  name: "alpha",
  description: "A",
  scope: "project" as const,
  source: "project-dsh",
  path: ".dsh/skills/alpha/SKILL.md",
  invocation: { modelInvocable: true, userInvocable: true },
};

test("fetchSkills GETs the catalog with the Project claim", async () => {
  await withFetch(200, { available: true, runtime: "dsh", skills: [SKILL] }, async (calls) => {
    const view = await fetchSkills({ api: "/api/skills", scope: { projectId: "proj-1" } });
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.url, "/api/skills?projectId=proj-1");
    assert.equal(view.available, true);
    assert.deepEqual(view.skills, [SKILL]);
  });
});

test("fetchSkills throws on a failed hop so the caller owns the decision", async () => {
  await withFetch(500, { error: "boom" }, async () => {
    await assert.rejects(() => fetchSkills(), (err: unknown) => {
      assert.ok(err instanceof SkillsRequestError);
      assert.equal(err.status, 500);
      assert.match(err.message, /boom/);
      return true;
    });
  });
});

test("installSkill POSTs the input and returns the skill", async () => {
  await withFetch(200, { skill: SKILL }, async (calls) => {
    const skill = await installSkill(
      { api: "/api/skills", scope: { projectId: "p" } },
      { name: "alpha", description: "A", body: "b" },
    );
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "/api/skills/install?projectId=p");
    assert.equal(calls[0]!.body, JSON.stringify({ name: "alpha", description: "A", body: "b" }));
    assert.deepEqual(skill, SKILL);
  });
});

test("removeSkill POSTs name + confirm and surfaces an error", async () => {
  await withFetch(200, { removed: "alpha" }, async (calls) => {
    await removeSkill({ api: "/api/skills" }, "alpha");
    assert.equal(calls[0]!.url, "/api/skills/remove");
    assert.equal(calls[0]!.body, JSON.stringify({ name: "alpha", confirm: true }));
  });
  await withFetch(404, { error: "skill not found: alpha" }, async () => {
    await assert.rejects(() => removeSkill({ api: "/api/skills" }, "alpha"), /skill not found/);
  });
});
