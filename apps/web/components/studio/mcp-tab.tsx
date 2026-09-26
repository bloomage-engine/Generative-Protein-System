"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import type { McpServerPatch, McpServerView } from "@science-studio/transport-client";
import { fetchSettings, updateSettings } from "@science-studio/transport-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SETTINGS_API } from "./settings-dialog";

/**
 * The workbench's MCP tab (docs/adr/0026). One scope: the DEPLOYMENT's external
 * MCP servers — the whole list is edited locally and replaced with one
 * manager-gated `PUT /api/settings` (the `mcp` section is a list replace).
 *
 * Secrets (stdio `env` / http `headers` values) are WRITE-ONLY over HTTP: the
 * view shows only each secret map's configured KEY names, and the merge rule
 * (absent = keep, null = delete) is what the form encodes with the
 * "leave blank to keep" / Clear affordance. Renaming a server or switching its
 * transport starts a NEW row — the old stored secrets do not follow.
 *
 * The list mounts into every dsh child as a launch patch; saving applies it to
 * NEWLY LAUNCHED processes (a cached child keeps its launch-time list until
 * its environment is released). Like the Skills/HPC tabs it owns its
 * fetch/error/retry state (docs/adr/0021).
 */

interface SecretRow {
  key: string;
  /** The typed value. Empty on a stored key = KEEP (the field is simply absent). */
  value: string;
  /** The key already holds a stored value (its name came from the GET view). */
  configured: boolean;
  /** Clear was pressed — the save sends the delete marker (null). */
  clear: boolean;
}

interface ServerRow {
  serverName: string;
  transport: "stdio" | "streamable-http";
  enabled: boolean;
  /** stdio: the executable. */
  command: string;
  /** stdio: one argument per line — execve argv, never space-split. */
  args: string;
  /** stdio: optional working directory. */
  cwd: string;
  /** streamable-http: the endpoint URL. */
  url: string;
  /** stdio `env` (stdio rows) or http `headers` (streamable-http rows). */
  secrets: SecretRow[];
  /** The serverName as loaded, for the rename warning (null on a new row). */
  originalName: string | null;
  /** The transport as loaded, for the transport-change warning (null on a new row). */
  originalTransport: "stdio" | "streamable-http" | null;
}

function rowFromView(server: McpServerView): ServerRow {
  // The view masked the secret map to its key names — the edit form starts
  // from those (value blank = keep, Clear = delete).
  const configuredKeys =
    "envConfigured" in server ? server.envConfigured : "headersConfigured" in server ? server.headersConfigured : [];
  const secrets: SecretRow[] = configuredKeys.map((key) => ({ key, value: "", configured: true, clear: false }));
  return {
    serverName: server.serverName,
    transport: server.transport,
    enabled: server.enabled !== false,
    command: server.transport === "stdio" ? server.command : "",
    args: server.transport === "stdio" ? (server.args ?? []).join("\n") : "",
    cwd: server.transport === "stdio" ? server.cwd ?? "" : "",
    url: server.transport === "streamable-http" ? server.url : "",
    secrets,
    originalName: server.serverName,
    originalTransport: server.transport,
  };
}

/** Encode the secret rows by the merge rule: changed keys only, null = delete. */
function secretPatch(rows: SecretRow[]): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    if (row.clear) out[key] = null;
    else if (row.configured && row.value === "") continue; // absent = keep the stored value
    else out[key] = row.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function patchFromRow(row: ServerRow): McpServerPatch {
  const patch: McpServerPatch = {
    serverName: row.serverName.trim(),
    transport: row.transport,
    enabled: row.enabled,
  };
  const secrets = secretPatch(row.secrets);
  if (row.transport === "stdio") {
    patch.command = row.command.trim();
    const args = row.args.split("\n").map((arg) => arg.trim()).filter((arg) => arg !== "");
    if (args.length > 0) patch.args = args;
    if (row.cwd.trim() !== "") patch.cwd = row.cwd.trim();
    if (secrets !== undefined) patch.env = secrets;
  } else {
    patch.url = row.url.trim();
    if (secrets !== undefined) patch.headers = secrets;
  }
  return patch;
}

export function McpTab() {
  const [rows, setRows] = React.useState<ServerRow[]>([]);
  const [runtime, setRuntime] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setStatus("loading");
    setError(null);
    fetchSettings(SETTINGS_API)
      .then((view) => {
        setRuntime(view.runtime);
        setRows((view.mcp?.servers ?? []).map(rowFromView));
        setStatus("idle");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
  }, []);

  React.useEffect(load, [load]);

  const patchRow = (index: number, patch: Partial<ServerRow>) =>
    setRows((list) => list.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const patchSecret = (index: number, secretIndex: number, patch: Partial<SecretRow>) =>
    setRows((list) =>
      list.map((row, i) =>
        i === index ? { ...row, secrets: row.secrets.map((s, j) => (j === secretIndex ? { ...s, ...patch } : s)) } : row,
      ),
    );

  const addServer = () =>
    setRows((list) => [
      ...list,
      {
        serverName: "",
        transport: "stdio",
        enabled: true,
        command: "",
        args: "",
        cwd: "",
        url: "",
        secrets: [],
        originalName: null,
        originalTransport: null,
      },
    ]);

  const save = async () => {
    setStatus("saving");
    setError(null);
    try {
      // The service is the validator (a violation is a 400 whose message we
      // show verbatim, docs/adr/0021); blank secret fields ride the keep rule.
      const patches = rows.map(patchFromRow);
      const next = await updateSettings(SETTINGS_API, { mcp: { servers: patches } });
      setRows((next.mcp?.servers ?? []).map(rowFromView));
      setRuntime(next.runtime);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">MCP Servers</h3>
          <Button type="button" variant="outline" size="sm" onClick={addServer}>
            <Plus className="size-3.5" /> Add server
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Deployment configuration: each enabled server mounts into every dsh process and adds{" "}
          <code>mcp__&lt;name&gt;__&lt;tool&gt;</code> tools (the harness&apos;s own MCP client). Secret
          values are stored write-only — leave a configured field blank to keep it.
        </p>
        {runtime !== null && runtime !== "dsh" ? (
          <p className="text-xs text-muted-foreground">
            The active runtime is <span className="font-medium">{runtime}</span>; only the dsh runtime
            mounts these servers.
          </p>
        ) : null}
        {status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No servers yet — add one and save.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row, index) => {
              const renamed =
                row.originalName !== null && row.serverName.trim() !== row.originalName &&
                row.secrets.some((s) => s.configured);
              const transportSwitched =
                row.originalTransport !== null && row.transport !== row.originalTransport &&
                row.secrets.some((s) => s.configured);
              return (
                <li key={index} className="border-border/60 space-y-2 rounded-md border p-3">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <label className="grid gap-1 text-xs">
                      <span className="text-muted-foreground">Server name</span>
                      <Input
                        value={row.serverName}
                        onChange={(e) => patchRow(index, { serverName: e.target.value })}
                        placeholder="github"
                      />
                    </label>
                    <label className="grid gap-1 text-xs">
                      <span className="text-muted-foreground">Transport</span>
                      <select
                        className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                        value={row.transport}
                        onChange={(e) =>
                          patchRow(index, {
                            transport: e.target.value === "streamable-http" ? "streamable-http" : "stdio",
                          })
                        }
                      >
                        <option value="stdio">stdio</option>
                        <option value="streamable-http">streamable-http</option>
                      </select>
                    </label>
                    <label className="col-span-2 flex items-center gap-2 text-xs sm:justify-end">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-current"
                        checked={row.enabled}
                        onChange={(e) => patchRow(index, { enabled: e.target.checked })}
                      />
                      <span className={row.enabled ? "" : "text-muted-foreground"}>Enabled</span>
                    </label>
                    {row.transport === "stdio" ? (
                      <>
                        <label className="col-span-2 grid gap-1 text-xs">
                          <span className="text-muted-foreground">Command</span>
                          <Input
                            value={row.command}
                            onChange={(e) => patchRow(index, { command: e.target.value })}
                            placeholder="npx"
                          />
                        </label>
                        <label className="col-span-2 grid gap-1 text-xs">
                          <span className="text-muted-foreground">Working dir (optional)</span>
                          <Input
                            value={row.cwd}
                            onChange={(e) => patchRow(index, { cwd: e.target.value })}
                            placeholder="/srv/mcp"
                          />
                        </label>
                        <label className="col-span-2 sm:col-span-4 grid gap-1 text-xs">
                          <span className="text-muted-foreground">Arguments (one per line)</span>
                          <textarea
                            className="border-input bg-background min-h-16 w-full rounded-md border p-2 font-mono text-xs"
                            value={row.args}
                            onChange={(e) => patchRow(index, { args: e.target.value })}
                            placeholder={"-y\n@modelcontextprotocol/server-github"}
                          />
                        </label>
                      </>
                    ) : (
                      <label className="col-span-2 sm:col-span-4 grid gap-1 text-xs">
                        <span className="text-muted-foreground">URL</span>
                        <Input
                          value={row.url}
                          onChange={(e) => patchRow(index, { url: e.target.value })}
                          placeholder="http://localhost:3000/mcp"
                        />
                      </label>
                    )}
                  </div>
                  {renamed || transportSwitched ? (
                    <p className="text-xs text-destructive">
                      {renamed
                        ? "Renaming starts a new server — its stored secrets will be dropped."
                        : "Changing the transport starts a new server — its stored secrets will be dropped."}
                    </p>
                  ) : null}
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">
                      {row.transport === "stdio" ? "Environment" : "Headers"}
                    </span>
                    {row.secrets.map((secret, secretIndex) => (
                      <div key={secretIndex} className="flex items-center gap-2">
                        <Input
                          className="w-44"
                          value={secret.key}
                          onChange={(e) => patchSecret(index, secretIndex, { key: e.target.value })}
                          placeholder="GITHUB_TOKEN"
                          disabled={secret.configured}
                        />
                        <Input
                          className="flex-1"
                          type="password"
                          autoComplete="off"
                          value={secret.value}
                          onChange={(e) => patchSecret(index, secretIndex, { value: e.target.value, clear: false })}
                          placeholder={secret.clear ? "will clear on save" : secret.configured ? "••• (leave blank to keep)" : "value"}
                        />
                        {secret.configured ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              patchSecret(index, secretIndex, {
                                clear: !secret.clear,
                                ...(secret.clear ? {} : { value: "" }),
                              })
                            }
                          >
                            {secret.clear ? "Undo" : "Clear"}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() =>
                              setRows((list) =>
                                list.map((r, i) =>
                                  i === index ? { ...r, secrets: r.secrets.filter((_, j) => j !== secretIndex) } : r,
                                ),
                              )
                            }
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setRows((list) =>
                          list.map((r, i) =>
                            i === index ? { ...r, secrets: [...r.secrets, { key: "", value: "", configured: false, clear: false }] } : r,
                          ),
                        )
                      }
                    >
                      <Plus className="size-3.5" /> {row.transport === "stdio" ? "Variable" : "Header"}
                    </Button>
                  </div>
                  <div className="flex items-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setRows((list) => list.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="size-3.5" /> Remove server
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void save()} disabled={status === "saving" || status === "loading"}>
            {status === "saving" ? <Loader2 className="size-4 animate-spin" /> : null}
            Save servers
          </Button>
          {status === "saved" ? (
            <span className="text-xs text-muted-foreground">Saved — applies to newly launched dsh processes.</span>
          ) : null}
          {error ? (
            <span className="flex items-center gap-2 text-xs text-destructive">
              {error}
              <Button type="button" variant="outline" size="sm" onClick={load}>
                Retry
              </Button>
            </span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
