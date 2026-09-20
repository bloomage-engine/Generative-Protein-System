import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createInMemoryRecordStore } from "@science-studio/record";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  SkillExistsError,
  SkillNotFoundError,
  type Principal,
  type PrincipalResolver,
  type RuntimeAdapter,
  type SkillInfo,
  type SkillInstallInput,
} from "@science-studio/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

/**
 * The `/api/skills*` routes (docs/adr/0020): the catalog read degrades to
 * "unavailable" for a runtime without the surface, and the two writes are
 * gated, validated, and mapped from the adapter's seam errors.
 */

function adapterWith(overrides: Partial<RuntimeAdapter> = {}): RuntimeAdapter {
  return {
    runtime: "dsh",
    init: async () => {},
    run: async function* () {},
    abort: () => {},
    ...overrides,
  };
}

const SAMPLE: SkillInfo = {
  name: "alpha",
  description: "A",
  scope: "project",
  source: "project-dsh",
  path: ".dsh/skills/alpha/SKILL.md",
  invocation: { modelInvocable: true, userInvocable: true },
};

function fixedPrincipal(principal: Principal): PrincipalResolver {
  return { resolve: async () => principal };
}

function backend(adapter: RuntimeAdapter, principal: PrincipalResolver = new LocalPrincipalResolver()): Backend {
  return {
    principal,
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter, workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records: createInMemoryRecordStore(),
  };
}

async function withServer(backendInput: Backend, fn: (base: string) => Promise<void>): Promise<void> {
  const app = await createTransportService({ backend: backendInput });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

const json = { "content-type": "application/json" };

test("GET /api/skills lists a capable adapter and reports an incapable one unavailable", async () => {
  await withServer(backend(adapterWith({ skills: async () => [SAMPLE] })), async (base) => {
    const res = await fetch(`${base}/api/skills`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { available: true, runtime: "dsh", skills: [SAMPLE] });
  });
  await withServer(backend(adapterWith()), async (base) => {
    const res = await fetch(`${base}/api/skills`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { available: false, runtime: "dsh", skills: [] });
  });
});

test("POST /api/skills/install validates, installs, and maps errors", async () => {
  const installed: SkillInstallInput[] = [];
  const adapter = adapterWith({
    installSkill: async (input) => {
      installed.push(input);
      if (input.name === "taken") throw new SkillExistsError("taken");
      return SAMPLE;
    },
  });
  await withServer(backend(adapter), async (base) => {
    const bad = await fetch(`${base}/api/skills/install`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ description: "no name" }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetch(`${base}/api/skills/install`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "alpha", description: "A", body: "b" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { skill: SAMPLE });
    assert.equal(installed.length, 1);

    const conflict = await fetch(`${base}/api/skills/install`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "taken", description: "A", body: "b" }),
    });
    assert.equal(conflict.status, 409);
  });

  await withServer(backend(adapterWith()), async (base) => {
    const res = await fetch(`${base}/api/skills/install`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "alpha", description: "A", body: "b" }),
    });
    assert.equal(res.status, 501);
  });
});

test("POST /api/skills/remove requires confirm and maps errors", async () => {
  const removed: string[] = [];
  const adapter = adapterWith({
    removeSkill: async (name) => {
      if (name === "missing") throw new SkillNotFoundError(name);
      removed.push(name);
    },
  });
  await withServer(backend(adapter), async (base) => {
    const noConfirm = await fetch(`${base}/api/skills/remove`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "alpha" }),
    });
    assert.equal(noConfirm.status, 400);

    const ok = await fetch(`${base}/api/skills/remove`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "alpha", confirm: true }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(removed, ["alpha"]);

    const missing = await fetch(`${base}/api/skills/remove`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "missing", confirm: true }),
    });
    assert.equal(missing.status, 404);
  });
});

test("a non-local non-manager principal can read but not write skills", async () => {
  const researcher: Principal = {
    id: "u-1",
    tenant: "t-1",
    displayName: "Researcher",
    roles: ["researcher"],
    local: false,
  };
  const manager: Principal = { ...researcher, roles: ["researcher", "manager"] };
  const adapter = adapterWith({
    skills: async () => [SAMPLE],
    installSkill: async () => SAMPLE,
    removeSkill: async () => {},
  });
  const body = JSON.stringify({ name: "alpha", description: "A", body: "b" });

  await withServer(backend(adapter, fixedPrincipal(researcher)), async (base) => {
    assert.equal((await fetch(`${base}/api/skills`)).status, 200, "GET stays available");
    const install = await fetch(`${base}/api/skills/install`, { method: "POST", headers: json, body });
    assert.equal(install.status, 403);
    const remove = await fetch(`${base}/api/skills/remove`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "alpha", confirm: true }),
    });
    assert.equal(remove.status, 403);
  });

  await withServer(backend(adapter, fixedPrincipal(manager)), async (base) => {
    const install = await fetch(`${base}/api/skills/install`, { method: "POST", headers: json, body });
    assert.equal(install.status, 200, "a hosted manager may write");
  });
});
