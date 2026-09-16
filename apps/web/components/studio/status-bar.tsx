"use client";

import * as React from "react";
import { Activity, Cpu, Folder, FolderTree, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DEFAULT_PROJECTS_API,
  fetchSettings,
  formatTokens,
  useSessionMetrics,
  useWorkspaceAvailability,
} from "@science-studio/transport-client";
import { useStudioStore } from "@/store/studio-store";
import { SettingsDialog } from "./settings-dialog";
import { desktopBridge } from "@/lib/desktop-bridge";

const PROJECTS_API = process.env.NEXT_PUBLIC_PROJECTS_URL ?? DEFAULT_PROJECTS_API;

export function StatusBar() {
  return (
    <footer className="flex h-7 items-center justify-between border-t bg-background px-3 text-xs text-muted-foreground">
      <div className="flex flex-1 items-center justify-start">
        <SettingsButton />
        <WorkspaceChip />
        <RuntimeChip />
      </div>
      <div className="flex flex-1 items-center justify-center">
        <SessionStatusChip />
      </div>
      <div className="flex flex-1 items-center justify-end">
        <ProjectChip />
      </div>
      <SettingsDialog />
    </footer>
  );
}

function WorkspaceChip() {
  const projectId = useStudioStore((s) => s.projectId);
  const { available, reason } = useWorkspaceAvailability({ project: projectId });
  const ok = available === true;
  const label = ok ? "workspace: enabled" : available === false ? "workspace: off" : "workspace: …";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-5 gap-1.5 px-1.5">
          <FolderTree className={ok ? "size-3.5 text-emerald-500" : "size-3.5 opacity-50"} />
          <span className="max-w-[14rem] truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="text-sm font-semibold">Workspace</div>
        <p className="text-xs text-muted-foreground">
          {ok
            ? "File browsing is enabled for this Project."
            : (reason ?? "Workspace status is loading or temporarily unreachable.")}
        </p>
        <div className="mt-2 text-xs text-muted-foreground">
          <span className="text-foreground">Project</span> · {projectId ?? "(default)"}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RuntimeChip() {
  const [status, setStatus] = React.useState<{ dshPath: string | null; ready: boolean } | null>(null);
  const [route, setRoute] = React.useState<string | null>(null);
  const [present, setPresent] = React.useState(false);

  React.useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.runtimeStatus) return;
    setPresent(true);
    let active = true;
    void bridge
      .runtimeStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    let active = true;
    void fetchSettings()
      .then((view) => {
        if (!active) return;
        setRoute(`${view.model.provider ?? "not set"} / ${view.model.model ?? "not set"}`);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!present) return null;
  const ready = status?.ready === true;
  const label = status === null ? "runtime: …" : ready ? "runtime: ready" : "runtime: dsh missing";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-5 gap-1.5 px-1.5">
          <Cpu className={ready ? "size-3.5 text-emerald-500" : "size-3.5 opacity-50"} />
          <span className="max-w-[14rem] truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="text-sm font-semibold">Runtime</div>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">dsh</dt>
            <dd className="break-all">{status?.dshPath ?? "missing"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">route</dt>
            <dd className="break-all">{route ?? "…"}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          {ready
            ? "The desktop app found dsh. Configure the model route in Settings."
            : "Install dsh, then configure the model route in Settings."}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function SessionStatusChip() {
  const activeSessionId = useStudioStore((s) => s.activeSessionId);
  const projectId = useStudioStore((s) => s.projectId);
  const sessions = useStudioStore((s) => s.sessions);
  const runsRevision = useStudioStore((s) => s.runsRevision);
  const active = sessions.find((s) => s.id === activeSessionId) ?? null;
  const metrics = useSessionMetrics({
    api: PROJECTS_API,
    projectId,
    sessionId: activeSessionId,
    revision: runsRevision,
  });

  const usage = metrics?.latest?.usage;
  const used = usage?.inputTokens;
  const contextWindow = metrics?.model?.contextWindow;
  const contextLabel =
    used === undefined
      ? null
      : contextWindow === undefined
        ? formatTokens(used)
        : `${formatTokens(used)} / ${formatTokens(contextWindow)}`;
  // The inline readout stays terse: just the model id and the context gauge.
  const inline = [metrics?.model?.model, contextLabel].filter(
    (value): value is string => Boolean(value),
  );
  const modelLabel = metrics?.model
    ? metrics.model.provider && metrics.model.model
      ? `${metrics.model.provider}/${metrics.model.model}`
      : (metrics.model.model ?? "—")
    : "—";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-5 gap-1.5 px-1.5">
          <Activity className="size-3.5 opacity-60" />
          <span className="max-w-[20rem] truncate">
            {active?.title ?? active?.id ?? "no session"}
            {inline.length > 0 ? ` · ${inline.join(" · ")}` : ""}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-72 p-3">
        <div className="text-sm font-semibold">Session</div>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>
              {active?.updatedAt ? new Date(active.updatedAt).toLocaleString() : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Project</dt>
            <dd>{active?.projectId ?? "—"}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Agent</dt>
            <dd>{active?.agentId ?? "—"}</dd>
          </div>
        </dl>
        <div className="mt-3 border-t pt-2 text-sm font-semibold">Token usage</div>
        {metrics && metrics.cumulative.runs > 0 ? (
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="break-all">{modelLabel}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Context</dt>
              <dd>{contextLabel ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last turn</dt>
              <dd>
                {usage
                  ? `${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Total (last)</dt>
              <dd>
                {usage
                  ? formatTokens(usage.totalTokens ?? usage.inputTokens + usage.outputTokens)
                  : "—"}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-muted-foreground">Session total</dt>
              <dd>
                {formatTokens(metrics.cumulative.input)} in /{" "}
                {formatTokens(metrics.cumulative.output)} out ·{" "}
                {formatTokens(metrics.cumulative.total)} total · {metrics.cumulative.runs}{" "}
                {metrics.cumulative.runs === 1 ? "turn" : "turns"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No turns yet.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ProjectChip() {
  const projectId = useStudioStore((s) => s.projectId);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-5 gap-1.5 px-1.5">
          <Folder className="size-3.5" />
          <span className="max-w-[14rem] truncate">{projectId ?? "—"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="text-sm font-semibold">Project</div>
        <p className="text-xs text-muted-foreground">The identity this session is scoped to.</p>
        <div className="mt-2 text-xs">
          <div className="text-muted-foreground">id</div>
          <div className="break-all">{projectId ?? "—"}</div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SettingsButton() {
  const openSettings = useStudioStore((s) => s.openSettings);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-5 gap-1.5 px-1.5"
      aria-label="Settings"
      onClick={() => openSettings()}
    >
      <Settings className="size-3.5" />
    </Button>
  );
}
