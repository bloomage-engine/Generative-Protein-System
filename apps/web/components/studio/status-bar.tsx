"use client";

import * as React from "react";
import { Activity, Cpu, Folder, FolderTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useWorkspaceAvailability } from "@science-studio/transport-client";
import { useStudioStore } from "@/store/studio-store";

interface DesktopRuntimeStatus {
  dshPath: string | null;
  provider: string | null;
  model: string | null;
  ready: boolean;
}

interface DesktopBridge {
  runtimeStatus?: () => Promise<DesktopRuntimeStatus>;
}

declare global {
  interface Window {
    scienceStudioDesktop?: DesktopBridge;
  }
}

export function StatusBar() {
  return (
    <footer className="flex h-7 items-center justify-between border-t bg-background px-3 text-xs text-muted-foreground">
      <div className="flex flex-1 items-center justify-start">
        <WorkspaceChip />
        <RuntimeChip />
      </div>
      <div className="flex flex-1 items-center justify-center">
        <SessionStatusChip />
      </div>
      <div className="flex flex-1 items-center justify-end">
        <ProjectChip />
      </div>
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
  const [status, setStatus] = React.useState<DesktopRuntimeStatus | null>(null);
  const [present, setPresent] = React.useState(false);

  React.useEffect(() => {
    const bridge = window.scienceStudioDesktop;
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

  if (!present) return null;
  const ready = status?.ready === true;
  const label = status === null ? "runtime: …" : ready ? "runtime: ready" : "runtime: dsh missing";
  const route = status?.provider && status.model ? `${status.provider} / ${status.model}` : "not set";

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
            <dd className="break-all">{route}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          {ready
            ? "The desktop app found dsh and a configured provider/model."
            : "Set up dsh and the provider/model in Science Studio Settings, then restart the service. Sending is not blocked."}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function SessionStatusChip() {
  const activeSessionId = useStudioStore((s) => s.activeSessionId);
  const sessions = useStudioStore((s) => s.sessions);
  const active = sessions.find((s) => s.id === activeSessionId) ?? null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-5 gap-1.5 px-1.5">
          <Activity className="size-3.5 opacity-60" />
          <span className="max-w-[14rem] truncate">
            {active?.title ?? active?.id ?? "no session"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-3">
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
