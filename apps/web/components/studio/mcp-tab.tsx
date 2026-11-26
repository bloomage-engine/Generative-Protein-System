"use client";

import * as React from "react";
import { Loader2, Pencil, Plus, RefreshCw, Server, Trash2, Zap } from "lucide-react";
import type {
  McpProbeResult,
  McpServerDraft,
  McpServerView,
} from "@gps/transport-client";
import {
  DEFAULT_MCP_API,
  createMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  probeMcpServer,
  updateMcpServer,
} from "@gps/transport-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface SecretRow {
  key: string;
  value: string;
  existing: boolean;
  remove: boolean;
}

interface DraftState {
  id: string;
  scope: "global" | "project";
  enabled: boolean;
  transport: "stdio" | "streamable-http";
  command: string;
  argsText: string;
  cwd: string;
  url: string;
  timeout: string;
  env: SecretRow[];
  headers: SecretRow[];
}

type SaveStatus = "idle" | "saving" | "saved" | "error";
type ProbeState = { state: "idle" | "running" | "done"; result?: McpProbeResult };

function viewDraft(server: McpServerView | null): DraftState {
  return {
    id: server?.id ?? "",
    scope: server?.scope ?? "global",
    enabled: server?.enabled ?? true,
    transport: server?.transport ?? "streamable-http",
    command: server?.command ?? "",
    argsText: (server?.args ?? []).join("\n"),
    cwd: server?.cwd ?? "",
    url: server?.url ?? "",
    timeout:
      server?.toolCallTimeoutMs === undefined ? "" : String(server.toolCallTimeoutMs),
    env: (server?.envKeys ?? []).map((key) => ({
      key,
      value: "",
      existing: true,
      remove: false,
    })),
    headers: (server?.headerKeys ?? []).map((key) => ({
      key,
      value: "",
      existing: true,
      remove: false,
    })),
  };
}

/** Only changed/removed/added credentials are sent; untouched stored values stay. */
function secretPatch(rows: SecretRow[]): Record<string, string | null> | undefined {
  const patch: Record<string, string | null> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (row.remove) patch[key] = null;
    else if (!row.existing || row.value !== "") patch[key] = row.value;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function toDraft(draft: DraftState, projectId: string | null): McpServerDraft {
  const env = secretPatch(draft.env);
  const headers = secretPatch(draft.headers);
  const args = draft.argsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const timeout = draft.timeout.trim() === "" ? undefined : Number(draft.timeout);
  return {
    ...(draft.id.trim() ? { id: draft.id.trim() } : {}),
    scope: draft.scope,
    ...(draft.scope === "project" && projectId ? { projectId } : {}),
    enabled: draft.enabled,
    transport: draft.transport,
    ...(draft.transport === "stdio"
      ? {
          command: draft.command.trim(),
          args,
          ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
          ...(env ? { env } : {}),
        }
      : {
          url: draft.url.trim(),
          ...(headers ? { headers } : {}),
        }),
    ...(timeout === undefined ? {} : { toolCallTimeoutMs: timeout }),
  };
}

function SecretEditor({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
}) {
  const patch = (index: number, next: Partial<SecretRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...next } : row)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([...rows, { key: "", value: "", existing: false, remove: false }])
          }
        >
          <Plus className="size-3.5" /> Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">None configured.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li key={`${row.key}-${index}`} className="flex items-center gap-2">
              <Input
                className="w-40"
                value={row.key}
                disabled={row.existing}
                placeholder="KEY"
                onChange={(e) => patch(index, { key: e.target.value })}
              />
              <Input
                className="min-w-0 flex-1"
                type="password"
                autoComplete="off"
                value={row.value}
                disabled={row.remove}
                placeholder={
                  row.existing ? "•••• (leave blank to keep)" : "value"
                }
                onChange={(e) => patch(index, { value: e.target.value })}
              />
              {row.existing ? (
                <Button
                  type="button"
                  variant={row.remove ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => patch(index, { remove: !row.remove })}
                >
                  {row.remove ? "Undo" : "Remove"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove"
                  onClick={() => onChange(rows.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The workbench's MCP tab (docs/adr/0026). Global servers apply to every
 * Project; project servers only to the active one. The catalog is deployment
 * configuration (settings.json), so credentials are write-only and saving
 * applies at the next service start. Test connection probes the current draft
 * without saving it.
 */
export function McpTab({
  open,
  projectId,
  worktreeId,
}: {
  open: boolean;
  projectId: string | null;
  worktreeId: string | null;
}) {
  const [servers, setServers] = React.useState<McpServerView[]>([]);
  const [available, setAvailable] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<DraftState | null>(null);
  const [status, setStatus] = React.useState<SaveStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [probe, setProbe] = React.useState<ProbeState>({ state: "idle" });
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      const next = await fetchMcpServers(
        DEFAULT_MCP_API,
        { projectId, worktreeId },
        signal,
      );
      setServers(next.servers);
      setAvailable(next.available);
    },
    [projectId, worktreeId],
  );

  React.useEffect(() => {
    if (open) return;
    // Closing the dialog drops typed credentials from React state.
    setDraft(null);
    setEditingId(null);
    setProbe({ state: "idle" });
    setStatus("idle");
    setError(null);
  }, [open]);

  React.useEffect(() => {
    setDraft(null);
    setEditingId(null);
    setProbe({ state: "idle" });
    setStatus("idle");
    setError(null);
    setLoadError(null);
  }, [projectId, worktreeId]);

  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    load(controller.signal)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, open]);

  const startNew = () => {
    setEditingId(null);
    setDraft(viewDraft(null));
    setStatus("idle");
    setError(null);
    setProbe({ state: "idle" });
  };

  const startEdit = (server: McpServerView) => {
    setEditingId(server.id);
    setDraft(viewDraft(server));
    setStatus("idle");
    setError(null);
    setProbe({ state: "idle" });
  };

  const save = async () => {
    if (!draft) return;
    setStatus("saving");
    setError(null);
    try {
      const body = toDraft(draft, projectId);
      const response = editingId
        ? await updateMcpServer(DEFAULT_MCP_API, editingId, body)
        : await createMcpServer(DEFAULT_MCP_API, body);
      setEditingId(response.server.id);
      setDraft(viewDraft(response.server));
      setStatus("saved");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  const remove = async () => {
    if (!editingId) return;
    if (!window.confirm(`Delete MCP server “${editingId}”?`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMcpServer(DEFAULT_MCP_API, editingId);
      setEditingId(null);
      setDraft(null);
      setStatus("idle");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    } finally {
      setDeleting(false);
    }
  };

  const test = async () => {
    if (!draft) return;
    setProbe({ state: "running" });
    try {
      const result = await probeMcpServer(DEFAULT_MCP_API, {
        ...(editingId ? { id: editingId } : {}),
        projectId,
        worktreeId,
        server: toDraft(draft, projectId),
      });
      setProbe({ state: "done", result });
    } catch (err) {
      setProbe({
        state: "done",
        result: { ok: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  };

  const patchDraft = (next: Partial<DraftState>) =>
    setDraft((current) => (current ? { ...current, ...next } : current));
  const canSave = draft
    ? draft.id.trim() !== "" &&
      (draft.scope !== "project" || projectId !== null) &&
      (draft.transport === "stdio"
        ? draft.command.trim() !== ""
        : draft.url.trim() !== "")
    : false;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">MCP Servers</h3>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setLoading(true);
                setLoadError(null);
                void load()
                  .catch((err: unknown) =>
                    setLoadError(err instanceof Error ? err.message : String(err)),
                  )
                  .finally(() => setLoading(false));
              }}
            >
              <RefreshCw className="size-3.5" /> Refresh
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={startNew}>
              <Plus className="size-3.5" /> Add server
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Deployment configuration. Global servers apply to every Project; project servers
          apply only to the current Project. Credentials are write-only. Saving applies at
          the next service start.
        </p>
        {!available ? (
          <p className="text-xs text-amber-600">
            The active runtime does not consume this catalog; dsh does. The rows are saved
            and take effect when the service runs dsh.
          </p>
        ) : null}
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : loadError ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : servers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No MCP servers for this scope yet — add one and run Test connection.
          </p>
        ) : (
          <ul className="space-y-2">
            {servers.map((server) => (
              <li
                key={server.id}
                className="border-border/60 flex items-start justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Server className="size-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium">{server.id}</span>
                    <span className="border-border/60 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                      {server.scope === "global" ? "Global" : "This project only"}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {server.transport}
                      {server.enabled ? "" : " · disabled"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {server.transport === "stdio"
                      ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
                      : server.url}
                  </p>
                  {server.envKeys.length > 0 || server.headerKeys.length > 0 ? (
                    <p className="text-[10px] text-muted-foreground">
                      secrets:{" "}
                      {[...server.envKeys, ...server.headerKeys].join(", ")}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => startEdit(server)}
                >
                  <Pencil className="size-3.5" /> Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {draft ? (
        <section className="border-border/60 space-y-4 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              {editingId ? `Edit ${editingId}` : "New server"}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(null);
                setEditingId(null);
                setProbe({ state: "idle" });
              }}
            >
              Cancel
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Server Name</span>
              <Input
                value={draft.id}
                disabled={editingId !== null}
                placeholder="github"
                onChange={(e) => patchDraft({ id: e.target.value })}
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Scope</span>
              <select
                className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                value={draft.scope}
                onChange={(e) =>
                  patchDraft({ scope: e.target.value === "project" ? "project" : "global" })
                }
              >
                <option value="global">Global — all projects</option>
                <option value="project" disabled={!projectId}>
                  This project only
                </option>
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Transport</span>
              <select
                className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                value={draft.transport}
                onChange={(e) =>
                  patchDraft({
                    transport:
                      e.target.value === "streamable-http" ? "streamable-http" : "stdio",
                  })
                }
              >
                <option value="stdio">stdio</option>
                <option value="streamable-http">streamable-http</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Tool timeout (ms)</span>
              <Input
                type="number"
                min={1000}
                max={600000}
                value={draft.timeout}
                placeholder="60000"
                onChange={(e) => patchDraft({ timeout: e.target.value })}
              />
            </label>
          </div>

          {draft.transport === "stdio" ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 text-xs">
                  <span className="text-muted-foreground">Command</span>
                  <Input
                    value={draft.command}
                    placeholder="npx"
                    onChange={(e) => patchDraft({ command: e.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-xs">
                  <span className="text-muted-foreground">Working directory (optional)</span>
                  <Input
                    value={draft.cwd}
                    placeholder="defaults to the agent's worktree"
                    onChange={(e) => patchDraft({ cwd: e.target.value })}
                  />
                </label>
              </div>
              <label className="grid gap-1 text-xs">
                <span className="text-muted-foreground">Arguments (one per line)</span>
                <Textarea
                  className="min-h-20 font-mono text-xs"
                  value={draft.argsText}
                  placeholder={"-y\n@modelcontextprotocol/server-github"}
                  onChange={(e) => patchDraft({ argsText: e.target.value })}
                />
              </label>
              <SecretEditor
                label="Environment"
                rows={draft.env}
                onChange={(env) => patchDraft({ env })}
              />
            </>
          ) : (
            <>
              <label className="grid gap-1 text-xs">
                <span className="text-muted-foreground">URL</span>
                <Input
                  value={draft.url}
                  placeholder="http://localhost:3000/mcp"
                  onChange={(e) => patchDraft({ url: e.target.value })}
                />
              </label>
              <SecretEditor
                label="Headers"
                rows={draft.headers}
                onChange={(headers) => patchDraft({ headers })}
              />
            </>
          )}

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => patchDraft({ enabled: e.target.checked })}
            />
            Enabled
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => void save()}
              disabled={!canSave || status === "saving" || deleting}
            >
              {status === "saving" ? <Loader2 className="size-4 animate-spin" /> : null}
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void test()}
              disabled={!canSave || probe.state === "running"}
            >
              {probe.state === "running" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Zap className="size-3.5" />
              )}
              Test connection
            </Button>
            {editingId ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void remove()}
                disabled={deleting}
              >
                <Trash2 className="size-3.5" /> Delete
              </Button>
            ) : null}
            {status === "saved" ? (
              <span className="text-xs text-muted-foreground">Saved — restart the service to apply.</span>
            ) : null}
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
          </div>

          {probe.state === "done" && probe.result ? (
            <div className="border-border/60 space-y-1 rounded-md border p-2 text-xs">
              {probe.result.ok ? (
                <>
                  <p className="text-muted-foreground">
                    Connected
                    {probe.result.serverInfo
                      ? ` to ${probe.result.serverInfo.name} ${probe.result.serverInfo.version}`
                      : ""}
                    {" · "}
                    {probe.result.toolCount ?? probe.result.tools?.length ?? 0} tool(s)
                  </p>
                  {probe.result.tools && probe.result.tools.length > 0 ? (
                    <ul className="max-h-40 space-y-0.5 overflow-y-auto font-mono text-[11px] text-muted-foreground">
                      {probe.result.tools.map((tool) => (
                        <li key={tool.name}>
                          {tool.name}
                          {tool.description ? ` — ${tool.description}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="text-destructive">{probe.result.error}</p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
