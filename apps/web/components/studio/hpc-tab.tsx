"use client";

import * as React from "react";
import { Loader2, Plus, Server, Trash2, Zap } from "lucide-react";
import type { HpcEndpointSettings } from "@science-studio/transport-client";
import {
  DEFAULT_HPC_API,
  fetchHpcBinding,
  fetchHpcEndpoints,
  probeHpcEndpoint,
  saveHpcBinding,
  updateSettings,
} from "@science-studio/transport-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SETTINGS_API } from "./settings-dialog";
import { cn } from "@/lib/utils";

/**
 * The workbench's HPC tab (docs/adr/0024). Two scopes on one screen:
 *
 * - **Endpoints** are DEPLOYMENT settings — the whole list is edited locally
 *   and replaced with one manager-gated `PUT /api/settings` (the `hpc` section
 *   semantics: a list replace). A key is referenced by PATH (no secret
 *   material), so the fields show as-is. "Test" runs the service's per-check
 *   probe.
 * - **This Project** is the HPC Binding — a workspace file the UI is the only
 *   writer of (the agent never binds). It reads/writes `/api/hpc/binding`.
 *
 * Like the Skills tab it owns its fetch/error/retry state (docs/adr/0021).
 */
export function HpcTab({ projectId }: { projectId: string | null }) {
  const [endpoints, setEndpoints] = React.useState<HpcEndpointSettings[]>([]);
  const [status, setStatus] = React.useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [error, setError] = React.useState<string | null>(null);

  // Binding scope.
  const [bound, setBound] = React.useState(false);
  const [bindEndpoint, setBindEndpoint] = React.useState("");
  const [bindPartition, setBindPartition] = React.useState("");
  const [bindWorkDir, setBindWorkDir] = React.useState("");
  const [bindDefaultTime, setBindDefaultTime] = React.useState("");
  const [bindNotes, setBindNotes] = React.useState("");
  const [bindingError, setBindingError] = React.useState<string | null>(null);
  const [bindingStatus, setBindingStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");

  React.useEffect(() => {
    let active = true;
    fetchHpcEndpoints(DEFAULT_HPC_API)
      .then((next) => {
        if (!active) return;
        setEndpoints(next);
        setStatus("idle");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    if (!projectId) return;
    let active = true;
    fetchHpcBinding(DEFAULT_HPC_API, { projectId })
      .then((view) => {
        if (!active) return;
        setBound(view.bound);
        setBindingError(view.error ?? null);
        if (view.binding) {
          setBindEndpoint(view.binding.endpoint);
          setBindPartition(view.binding.partition ?? "");
          setBindWorkDir(view.binding.workDir ?? "");
          setBindDefaultTime(view.binding.defaultTime ?? "");
          setBindNotes(view.binding.notes ?? "");
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        setBindingError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const [probing, setProbing] = React.useState<string | null>(null);
  const [probeResults, setProbeResults] = React.useState<Record<string, { ok: boolean; text: string }>>({});

  const patchEndpoint = (index: number, patch: Partial<HpcEndpointSettings>) =>
    setEndpoints((list) => list.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  const addEndpoint = () => {
    const taken = new Set(endpoints.map((e) => e.id));
    let id = "cluster-1";
    for (let n = 2; taken.has(id); n += 1) id = `cluster-${n}`;
    setEndpoints((list) => [...list, { id, name: id, kind: "slurm", host: "" }]);
  };

  const save = async () => {
    setStatus("saving");
    setError(null);
    try {
      // Drop blank optional fields; the service is the validator (a violation
      // is a 400 whose message we show verbatim).
      const cleaned = endpoints.map(({ id, name, kind, host, user, port, keyPath, defaultPartition, defaultTime, maxConcurrentJobs }) => ({
        id: id.trim(),
        name: name.trim(),
        kind,
        host: host.trim(),
        ...(user?.trim() ? { user: user.trim() } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(keyPath?.trim() ? { keyPath: keyPath.trim() } : {}),
        ...(defaultPartition?.trim() ? { defaultPartition: defaultPartition.trim() } : {}),
        ...(defaultTime?.trim() ? { defaultTime: defaultTime.trim() } : {}),
        ...(maxConcurrentJobs !== undefined ? { maxConcurrentJobs } : {}),
      }));
      await updateSettings(SETTINGS_API, { hpc: { endpoints: cleaned } });
      setEndpoints(cleaned);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  const test = async (id: string) => {
    setProbing(id);
    try {
      const res = await probeHpcEndpoint(DEFAULT_HPC_API, id);
      const text = res.ok
        ? [res.os, res.scheduler].filter(Boolean).join(" · ")
        : res.errors.join("; ");
      setProbeResults((map) => ({ ...map, [id]: { ok: res.ok, text } }));
    } catch (err) {
      setProbeResults((map) => ({ ...map, [id]: { ok: false, text: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setProbing(null);
    }
  };

  const saveBinding = async () => {
    setBindingStatus("saving");
    try {
      await saveHpcBinding(
        {
          endpoint: bindEndpoint,
          ...(bindPartition.trim() ? { partition: bindPartition.trim() } : {}),
          ...(bindWorkDir.trim() ? { workDir: bindWorkDir.trim() } : {}),
          ...(bindDefaultTime.trim() ? { defaultTime: bindDefaultTime.trim() } : {}),
          notes: bindNotes,
        },
        DEFAULT_HPC_API,
        { projectId },
      );
      setBound(true);
      setBindingError(null);
      setBindingStatus("saved");
    } catch (err) {
      setBindingStatus("error");
      setBindingError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">HPC Endpoints</h3>
          <Button type="button" variant="outline" size="sm" onClick={addEndpoint}>
            <Plus className="size-3.5" /> Add endpoint
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Deployment configuration: the service is the only SSH client (system OpenSSH; a key is referenced by PATH).
          Saving replaces the whole list and applies WITHOUT a restart; Test connection checks the SAVED endpoint.
        </p>
        {status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : endpoints.length === 0 ? (
          <p className="text-xs text-muted-foreground">No endpoints yet — add one and save.</p>
        ) : (
          <ul className="space-y-3">
            {endpoints.map((entry, index) => {
              const probe = probeResults[entry.id];
              return (
              <li key={`${entry.id}-${index}`} className="border-border/60 space-y-2 rounded-md border p-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">id</span>
                    <Input value={entry.id} onChange={(e) => patchEndpoint(index, { id: e.target.value })} />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Name</span>
                    <Input value={entry.name} onChange={(e) => patchEndpoint(index, { name: e.target.value })} />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Kind</span>
                    <select
                      className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                      value={entry.kind}
                      onChange={(e) => patchEndpoint(index, { kind: e.target.value === "linux" ? "linux" : "slurm" })}
                    >
                      <option value="slurm">slurm</option>
                      <option value="linux">linux</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Host</span>
                    <Input value={entry.host} onChange={(e) => patchEndpoint(index, { host: e.target.value })} placeholder="cluster.example / ssh alias" />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">User</span>
                    <Input value={entry.user ?? ""} onChange={(e) => patchEndpoint(index, { user: e.target.value || undefined })} />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Port</span>
                    <Input
                      type="number"
                      value={entry.port ?? ""}
                      onChange={(e) => patchEndpoint(index, { port: e.target.value === "" ? undefined : Number(e.target.value) })}
                    />
                  </label>
                  <label className="col-span-2 grid gap-1 text-xs">
                    <span className="text-muted-foreground">Key path (optional — else ssh-agent/config)</span>
                    <Input value={entry.keyPath ?? ""} onChange={(e) => patchEndpoint(index, { keyPath: e.target.value || undefined })} placeholder="~/.ssh/id_ed25519" />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Default partition</span>
                    <Input value={entry.defaultPartition ?? ""} onChange={(e) => patchEndpoint(index, { defaultPartition: e.target.value || undefined })} disabled={entry.kind !== "slurm"} />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Default time</span>
                    <Input value={entry.defaultTime ?? ""} onChange={(e) => patchEndpoint(index, { defaultTime: e.target.value || undefined })} placeholder="2:00:00" />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Max concurrent (0 = unlimited)</span>
                    <Input
                      type="number"
                      min={0}
                      value={entry.maxConcurrentJobs ?? ""}
                      onChange={(e) => patchEndpoint(index, { maxConcurrentJobs: e.target.value === "" ? undefined : Number(e.target.value) })}
                    />
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={probing === entry.id || entry.host.trim() === ""}
                    onClick={() => void test(entry.id)}
                  >
                    {probing === entry.id ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                    Test connection
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setEndpoints((list) => list.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                  {probe ? (
                    <span className={cn("truncate text-xs", probe.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                      {probe.text}
                    </span>
                  ) : null}
                </div>
              </li>
              );
            })}
          </ul>
        )}
        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void save()} disabled={status === "saving" || status === "loading"}>
            {status === "saving" ? <Loader2 className="size-4 animate-spin" /> : null}
            Save endpoints
          </Button>
          {status === "saved" ? <span className="text-xs text-muted-foreground">Saved — applies immediately.</span> : null}
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">This Project</h3>
        <p className="text-xs text-muted-foreground">
          The binding file <code>.science-studio/hpc.md</code> selects one endpoint (and per-Project defaults) for
          agent submissions. {projectId === null ? "No Project is active." : bound ? "Bound." : "This Project is not bound yet."}
        </p>
        {projectId === null || endpoints.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {endpoints.length === 0
              ? "Add and save an endpoint above first."
              : "No Project is active."}
          </p>
        ) : (
          <div className="space-y-2">
            {bound && bindEndpoint !== "" && !endpoints.some((entry) => entry.id === bindEndpoint) ? (
              <p className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-2 text-xs">
                This Project is bound to <span className="font-medium">{bindEndpoint}</span>, which no longer
                exists in the endpoint list — jobs cannot be submitted until it is fixed.
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="grid gap-1 text-xs">
                <span className="text-muted-foreground">Endpoint</span>
                <select
                  className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                  value={bindEndpoint}
                  onChange={(event) => {
                    setBindEndpoint(event.target.value);
                    setBindingStatus("idle");
                  }}
                >
                  <option value="">— select —</option>
                  {endpoints.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name} ({entry.kind})
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-muted-foreground">Partition override</span>
                <Input value={bindPartition} onChange={(event) => setBindPartition(event.target.value)} placeholder={endpoints.find((e) => e.id === bindEndpoint)?.defaultPartition ?? "endpoint default"} />
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-muted-foreground">Default time</span>
                <Input value={bindDefaultTime} onChange={(event) => setBindDefaultTime(event.target.value)} placeholder="2:00:00" />
              </label>
            </div>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Remote Work Dir (optional — default ~/science-studio/&lt;projectId&gt;)</span>
              <Input value={bindWorkDir} onChange={(event) => setBindWorkDir(event.target.value)} placeholder="~/scratch/my-project" />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Cluster notes (the agent reads these)</span>
              <textarea
                className="border-input bg-background min-h-20 w-full rounded-md border p-2 text-xs"
                value={bindNotes}
                onChange={(event) => setBindNotes(event.target.value)}
                placeholder="Queues, modules to load, data locations…"
              />
            </label>
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={projectId === null || bindEndpoint === "" || endpoints.length === 0 || bindingStatus === "saving"}
            onClick={() => void saveBinding()}
          >
            {bindingStatus === "saving" ? <Loader2 className="size-4 animate-spin" /> : null}
            Save binding
          </Button>
          {bindingStatus === "saved" ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
          {bindingError ? <span className="flex items-center gap-1 text-xs text-destructive"><Server className="size-3.5" />{bindingError}</span> : null}
        </div>
      </section>
    </div>
  );
}
