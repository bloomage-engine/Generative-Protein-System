/**
 * The `/api/hpc/*` surface (docs/adr/0024). Every route is Project-scoped
 * through `ProjectScopes` like the rest of the service, and NONE of the reads
 * touches the cluster: the panel and the tools read the ComputeJob ledger and
 * the settings view; only the poller (and an explicit submit/cancel/probe
 * POST) runs SSH. Failures follow docs/adr/0021: the service formats once,
 * the proxy relays verbatim, the client surface owns the degrade.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputeJob, RecordStore } from "@gps/record";
import { isOpenComputeJobState } from "@gps/hpc";
import {
  HPC_BINDING_PATH,
  isSafeRemotePath,
  isValidComputeJobId,
  isValidEndpointId,
  parseHpcBinding,
  serializeHpcBinding,
  type HpcBinding,
} from "@gps/hpc";
import {
  WorkspaceNotFoundError,
  type HpcEndpointSettings,
  type Workspace,
  type WorkspaceLimits,
} from "@gps/transport";
import { loadSettings } from "../settings.js";
import type { ProjectScopes } from "../project-scope.js";
import type { HpcJobPoller } from "./poller.js";
import { remotePath, type SshRunner } from "./ssh.js";
import {
  HpcError,
  parseSubmitBody,
  resolveEndpoint,
  submitJob,
  type BindingView,
} from "./submit.js";

export interface HpcRouteDeps {
  scope: ProjectScopes;
  records: RecordStore;
  settingsPath: string;
  ssh: SshRunner;
  poller: HpcJobPoller;
  workspaceLimits?: WorkspaceLimits;
}

/** Map a recognized error to a reply; `null` means "not mine — rethrow". */
function sendHpcError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof HpcError) return reply.code(err.status).send({ error: err.message });
  return null;
}

/** Read one workspace text file, `null` when absent (missing ≠ failure). */
async function readText(workspace: Workspace, path: string): Promise<string | null> {
  try {
    const content = await workspace.open(path);
    return await new Response(content.body).text();
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) return null;
    throw err;
  }
}

function bindingView(binding: HpcBinding | null): BindingView | null {
  if (!binding) return null;
  return {
    endpoint: binding.endpoint,
    ...(binding.workDir ? { workDir: binding.workDir } : {}),
    ...(binding.partition ? { partition: binding.partition } : {}),
    ...(binding.defaultTime ? { defaultTime: binding.defaultTime } : {}),
  };
}

function isOpen(job: ComputeJob): boolean {
  return isOpenComputeJobState(job.state);
}

/** The panel's order: open rows first, then newest submissions. */
export function sortJobs(jobs: ComputeJob[]): ComputeJob[] {
  return [...jobs].sort((a, b) => {
    if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
    return b.submittedAt.localeCompare(a.submittedAt);
  });
}

function remoteRelPath(value: unknown): string {
  if (typeof value !== "string" || value === "" || !isSafeRemotePath(value) || value.startsWith("/")) {
    throw new HpcError(400, "remoteRelPath must be a safe relative path");
  }
  return value;
}

export function registerHpcRoutes(app: FastifyInstance, deps: HpcRouteDeps): void {
  const { scope, records, settingsPath, ssh, poller } = deps;
  const endpoints = async (): Promise<HpcEndpointSettings[]> =>
    (await loadSettings(settingsPath)).hpc?.endpoints ?? [];

  // -- Endpoints (deployment settings view) ----------------------------------
  app.get("/api/hpc/endpoints", async () => ({ endpoints: await endpoints() }));

  app.post("/api/hpc/endpoints/:id/probe", async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id || !isValidEndpointId(id)) return reply.code(400).send({ error: "a valid endpoint id is required" });
    const endpoint = (await endpoints()).find((e) => e.id === id);
    if (!endpoint) return reply.code(404).send({ error: `endpoint not found: ${id}` });
    const errors: string[] = [];
    const uname = await ssh.run(endpoint, "uname -srm");
    if (uname.code !== 0) {
      return { ok: false, errors: [`connect: ${uname.stderr.trim() || `exit ${uname.code}`}`] };
    }
    const out: Record<string, unknown> = { ok: true, os: uname.stdout.trim(), errors };
    if (endpoint.kind === "slurm") {
      const sbatch = await ssh.run(endpoint, "sbatch --version");
      if (sbatch.code === 0) out.scheduler = sbatch.stdout.trim();
      else errors.push(`sbatch: ${sbatch.stderr.trim() || `exit ${sbatch.code}`}`);
      // `sbatch --version` answers even on a node that cannot reach slurmctld
      // — the connectivity truth is a bounded live squeue query. Without this
      // the probe reports a false green and the first real submit is where the
      // user discovers the controller is unreachable.
      const ctl = await ssh.run(endpoint, `timeout 12 squeue -h -o "%i" -a >/dev/null 2>&1 || echo SLURM-CTL-FAIL`);
      if (ctl.stdout.includes("SLURM-CTL-FAIL")) {
        errors.push("slurm controller unreachable from this host (squeue failed) — sbatch will not work here");
      }
    }
    // Prove the remote home is writable without touching a Project's dir.
    const touch = await ssh.run(endpoint, `mkdir -p ${remotePath("~/gps")}`);
    if (touch.code !== 0) errors.push(`~/gps: ${touch.stderr.trim() || `exit ${touch.code}`}`);
    out.ok = errors.length === 0;
    return out;
  });

  // -- The Project HPC Binding (workspace file; the UI is its only writer) ---
  app.get("/api/hpc/binding", async (request, reply) =>
    scope.withWorkspace(request, reply, async ({ environment }) => {
      const text = await readText(environment.workspace, HPC_BINDING_PATH);
      if (text === null) return { bound: false };
      const parsed = parseHpcBinding(text);
      if ("error" in parsed) return { bound: true, raw: text, error: parsed.error };
      return { bound: true, raw: text, binding: parsed.binding };
    }),
  );

  app.put("/api/hpc/binding", async (request, reply) => {
    const principal = request.principal!;
    if (!principal.local && !principal.roles.includes("manager")) {
      return reply.code(403).send({ error: "binding a Project to an endpoint requires a local or manager principal" });
    }
    const raw = (request.body ?? {}) as Record<string, unknown>;
    if (typeof raw.endpoint !== "string" || !isValidEndpointId(raw.endpoint)) {
      return reply.code(400).send({ error: "endpoint (a valid id) is required" });
    }
    if (!(await endpoints()).some((e) => e.id === raw.endpoint)) {
      return reply.code(400).send({ error: `unknown endpoint "${raw.endpoint}"` });
    }
    const binding: HpcBinding = {
      endpoint: raw.endpoint,
      notes: typeof raw.notes === "string" ? raw.notes : "",
      ...(["partition", "workDir", "defaultTime"] as const).reduce<Record<string, string>>((acc, key) => {
        const value = raw[key];
        if (typeof value === "string" && value.trim() !== "") acc[key] = value.trim();
        return acc;
      }, {}),
    };
    if (binding.workDir && !isSafeRemotePath(binding.workDir)) {
      return reply.code(400).send({ error: "workDir must be a safe remote path (no spaces, no '..')" });
    }
    return scope.withWorkspace(request, reply, async ({ environment }) => {
      await environment.workspace.write(HPC_BINDING_PATH, new TextEncoder().encode(serializeHpcBinding(binding)), {
        createParents: true,
      });
      return { binding };
    });
  });

  // -- The Compute Job ledger (the panel's and the tools' read model) --------
  app.get("/api/hpc/jobs", async (request) => {
    const { projectId } = await scope.acquire(request);
    const { state } = request.query as { state?: string };
    const jobs = await records.listComputeJobs(projectId);
    return {
      jobs: sortJobs(state ? jobs.filter((job) => job.state === state) : jobs),
    };
  });

  app.get("/api/hpc/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id || !isValidComputeJobId(id)) return reply.code(400).send({ error: "a valid job id is required" });
    const { projectId } = await scope.acquire(request);
    const job = await records.loadComputeJob(id);
    if (!job || job.projectId !== projectId) return reply.code(404).send({ error: `compute job not found: ${id}` });
    return { job };
  });

  app.post("/api/hpc/jobs", async (request, reply) =>
    scope.withWorkspace(request, reply, async ({ projectId, environment }) => {
      try {
        const input = parseSubmitBody(request.body);
        // Best-effort session attribution (docs/adr/0024): only a claimed key
        // the record actually knows under THIS Project is kept.
        if (input.sessionKey) {
          const known = await records.getSession(input.sessionKey);
          if (!known || known.projectId !== projectId) delete input.sessionKey;
        }
        const text = await readText(environment.workspace, HPC_BINDING_PATH);
        let binding: HpcBinding | null = null;
        if (text !== null) {
          const parsed = parseHpcBinding(text);
          if ("error" in parsed) throw new HpcError(400, `binding: ${parsed.error}`);
          binding = parsed.binding;
        }
        const job = await submitJob(
          { ssh, records, endpoints, bindingOf: async () => bindingView(binding) },
          {
            projectId,
            input,
            getOpenJobs: async () => (await records.listComputeJobs(projectId)).filter(isOpen),
          },
        );
        return reply.code(201).send({ job });
      } catch (err) {
        const mapped = sendHpcError(reply, err);
        if (mapped) return mapped;
        throw err;
      }
    }),
  );

  // Reconcile now (the panel's Refresh): resets strikes and ticks this Project.
  app.post("/api/hpc/jobs/refresh", async (request) => {
    const { projectId } = await scope.acquire(request);
    await poller.tick({ projectId, resetStrikes: true });
    return { jobs: sortJobs(await records.listComputeJobs(projectId)) };
  });

  app.post("/api/hpc/jobs/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id || !isValidComputeJobId(id)) return reply.code(400).send({ error: "a valid job id is required" });
    const { projectId } = await scope.acquire(request);
    const job = await records.loadComputeJob(id);
    if (!job || job.projectId !== projectId) return reply.code(404).send({ error: `compute job not found: ${id}` });
    if (!isOpen(job)) return reply.code(409).send({ error: `the job already settled (${job.state})` });
    const endpoint = (await endpoints()).find((e) => e.id === job.endpointId);
    if (!endpoint) {
      return reply.code(409).send({ error: "the endpoint was deleted — cancel this job on the cluster directly" });
    }
    if (!job.remoteJobId) return reply.code(409).send({ error: "the job has no remote id — nothing to cancel" });
    // slurm reaps the whole job; linux kills the process GROUP (setsid made the
    // leader its own session, so -pid reaches the command's children too).
    const cmd =
      endpoint.kind === "slurm" ? `scancel ${job.remoteJobId}` : `kill -TERM -${job.remoteJobId} 2>/dev/null; true`;
    const res = await ssh.run(endpoint, cmd);
    if (res.code !== 0 && endpoint.kind === "slurm") {
      return reply.code(502).send({ error: `scancel failed: ${res.stderr.trim() || `exit ${res.code}`}` });
    }
    const at = new Date().toISOString();
    const cancelled: ComputeJob = { ...job, state: "cancelled", finishedAt: at, updatedAt: at, error: undefined };
    await records.upsertComputeJob(cancelled);
    return { job: cancelled };
  });

  // A bounded tail of one stored log file — still never a live cluster query.
  app.get("/api/hpc/jobs/:id/logs", async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id || !isValidComputeJobId(id)) return reply.code(400).send({ error: "a valid job id is required" });
    const query = request.query as { stream?: string; tailBytes?: string };
    const stream = query.stream === "stderr" ? "stderr" : "stdout";
    const tailBytes = Math.min(1_048_576, Math.max(1024, Number(query.tailBytes) || 65_536));
    const { projectId } = await scope.acquire(request);
    const job = await records.loadComputeJob(id);
    if (!job || job.projectId !== projectId) return reply.code(404).send({ error: `compute job not found: ${id}` });
    if (!job.remoteDir) return reply.code(409).send({ error: "the job has no remote log home" });
    const endpoint = (await endpoints()).find((e) => e.id === job.endpointId);
    if (!endpoint) return reply.code(409).send({ error: "the endpoint was deleted" });
    const res = await ssh.run(endpoint, `tail -c ${tailBytes} ${remotePath(`${job.remoteDir}/${stream}`)}`);
    if (res.code !== 0) {
      return { text: "", error: `tail failed: ${res.stderr.trim() || `exit ${res.code}`}` };
    }
    return { text: res.stdout };
  });

  // -- Staging (explicit, the only file movement; docs/adr/0024) -------------
  app.post("/api/hpc/files", async (request, reply) =>
    scope.withWorkspace(request, reply, async ({ projectId, environment }) => {
      try {
        const raw = (request.body ?? {}) as Record<string, unknown>;
        const action = raw.action === "download" ? "download" : raw.action === "upload" ? "upload" : null;
        if (!action) throw new HpcError(400, "action must be upload or download");
        if (typeof raw.workspacePath !== "string" || raw.workspacePath === "") {
          throw new HpcError(400, "workspacePath is required");
        }
        const remoteRel = remoteRelPath(raw.remoteRelPath);
        const text = await readText(environment.workspace, HPC_BINDING_PATH);
        if (text === null) throw new HpcError(400, "this Project is not bound to an HPC endpoint");
        const parsed = parseHpcBinding(text);
        if ("error" in parsed) throw new HpcError(400, `binding: ${parsed.error}`);
        const binding = parsed.binding;
        const endpoint = resolveEndpoint(await endpoints(), bindingView(binding));
        const workDir = binding.workDir ?? `~/gps/${projectId}`;
        if (!isSafeRemotePath(workDir)) throw new HpcError(400, "the Binding's workDir is not a safe remote path");
        const remote = `${workDir.endsWith("/") ? workDir.slice(0, -1) : workDir}/${remoteRel}`;

        const dir = await mkdtemp(join(tmpdir(), "gps-hpc-stage-"));
        const staging = join(dir, "file");
        try {
          if (action === "upload") {
            const content = await environment.workspace.open(raw.workspacePath, {
              maxBytes: deps.workspaceLimits?.maxUploadBytes,
            });
            const chunks: Buffer[] = [];
            const source = Readable.fromWeb(content.body as Parameters<typeof Readable.fromWeb>[0]);
            for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array));
            await writeFile(staging, Buffer.concat(chunks));
            // scp/sftp parses the remote path ITSELF (it expands a leading
            // `~` but does not shell-quote), so the path crosses RAW — which is
            // why `remoteRelPath`/`workDir` must satisfy the safe grammar.
            const res = await ssh.copyTo(endpoint, staging, remote);
            if (res.code !== 0) {
              throw new HpcError(502, `upload failed: ${res.stderr.trim() || `exit ${res.code}`}`);
            }
            return { ok: true, remotePath: remote };
          }
          const res = await ssh.copyFrom(endpoint, remote, staging);
          if (res.code !== 0) {
            throw new HpcError(502, `download failed: ${res.stderr.trim() || `exit ${res.code}`}`);
          }
          const bytes = await readFile(staging);
          await environment.workspace.write(raw.workspacePath, new Uint8Array(bytes), { createParents: true });
          return { ok: true, workspacePath: raw.workspacePath };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      } catch (err) {
        const mapped = sendHpcError(reply, err);
        if (mapped) return mapped;
        throw err;
      }
    }),
  );
}
