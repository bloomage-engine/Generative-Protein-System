"use client";

import * as React from "react";
import { Loader2, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEFAULT_SETTINGS_API,
  fetchSettings,
  updateSettings,
  type RuntimeSettingsPatch,
  type RuntimeSettingsView,
} from "@science-studio/transport-client";
import { useStudioStore } from "@/store/studio-store";
import { desktopBridge } from "@/lib/desktop-bridge";

export const SETTINGS_API = process.env.NEXT_PUBLIC_SETTINGS_URL ?? DEFAULT_SETTINGS_API;

type Status = "idle" | "loading" | "saving" | "saved" | "error";

export function SettingsDialog() {
  const open = useStudioStore((s) => s.settingsOpen);
  const closeSettings = useStudioStore((s) => s.closeSettings);
  const [view, setView] = React.useState<RuntimeSettingsView | null>(null);
  const [provider, setProvider] = React.useState("");
  const [model, setModel] = React.useState("");
  const [endpoint, setEndpoint] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [clearKey, setClearKey] = React.useState(false);
  const [subagentsWindow, setSubagentsWindow] = React.useState("");
  const [subagentsWindowCleared, setSubagentsWindowCleared] = React.useState(false);
  const [status, setStatus] = React.useState<Status>("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    setStatus("loading");
    setError(null);
    fetchSettings(SETTINGS_API)
      .then((next) => {
        if (!active) return;
        setView(next);
        setProvider(next.model.provider ?? "");
        setModel(next.model.model ?? "");
        setEndpoint(next.model.endpoint ?? "");
        setApiKey("");
        setClearKey(false);
        const n = next.subagents?.visibleWindowHours;
        setSubagentsWindow(n === undefined ? "" : String(n));
        setSubagentsWindowCleared(false);
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
  }, [open]);

  const save = async (): Promise<void> => {
    setStatus("saving");
    setError(null);
    const patch: RuntimeSettingsPatch = {
      model: {
        provider: provider.trim(),
        model: model.trim(),
        endpoint: endpoint.trim(),
        ...(clearKey ? { apiKey: null } : apiKey !== "" ? { apiKey } : {}),
      },
    };
    // Blank + not an explicit reset = leave the stored subagents window untouched.
    if (!(subagentsWindow === "" && !subagentsWindowCleared)) {
      patch.subagents = {
        visibleWindowHours: subagentsWindow === "" ? null : Number(subagentsWindow),
      };
    }
    try {
      const next = await updateSettings(SETTINGS_API, patch);
      setView(next);
      setApiKey("");
      setClearKey(false);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  const canRestart = Boolean(desktopBridge()?.restartHost);
  const keyState = clearKey
    ? "will clear on save"
    : view?.model.apiKeyConfigured
      ? "configured"
      : "not configured";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        // Escape/backdrop/Close: drop any typed plaintext key so it cannot
        // linger in memory until the dialog is reopened.
        setApiKey("");
        setClearKey(false);
        closeSettings();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="size-4" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Deployment configuration. Saving persists it; a service restart applies it.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="model" orientation="vertical" className="min-h-[20rem]">
          <TabsList className="h-fit w-40 shrink-0">
            <TabsTrigger value="model">Model</TabsTrigger>
            <TabsTrigger value="plugins">Plugins</TabsTrigger>
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="subagents">Subagents</TabsTrigger>
          </TabsList>
          <TabsContent value="model" className="space-y-6">
            {status === "loading" ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </p>
            ) : (
              <>
                {view && view.runtime !== "dsh" ? (
                  <p className="text-xs text-muted-foreground">
                    The active runtime is <span className="font-medium">{view.runtime}</span>; the
                    model route applies to dsh.
                  </p>
                ) : null}
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Model</h3>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Provider</span>
                    <Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="e.g. ollama-local" />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Model</span>
                    <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. qwen3.8:latest" />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Endpoint</span>
                    <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://host/v1" />
                  </label>
                </section>
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Model API</h3>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">API key · {keyState}</span>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setClearKey(false);
                      }}
                      placeholder={view?.model.apiKeyConfigured ? "•••• (leave blank to keep)" : "not set"}
                    />
                  </label>
                  {view?.model.apiKeyConfigured ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setApiKey("");
                        setClearKey(true);
                      }}
                    >
                      Clear key
                    </Button>
                  ) : null}
                </section>
                <div className="flex items-center gap-3">
                  <Button type="button" onClick={() => void save()} disabled={status === "saving"}>
                    {status === "saving" ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save
                  </Button>
                  {canRestart ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void desktopBridge()?.restartHost?.()}
                    >
                      Restart service
                    </Button>
                  ) : null}
                  {status === "saved" ? (
                    <span className="text-xs text-muted-foreground">Saved — restart the service to apply.</span>
                  ) : null}
                  {error ? <span className="text-xs text-destructive">{error}</span> : null}
                </div>
              </>
            )}
          </TabsContent>
          <TabsContent value="plugins">
            <EmptySection title="Plugins" body="Plugin configuration is coming soon." />
          </TabsContent>
          <TabsContent value="agent">
            <EmptySection title="Agent" body="Agent configuration is coming soon." />
          </TabsContent>
          <TabsContent value="subagents" className="space-y-6">
            {status === "loading" ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </p>
            ) : (
              <>
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Subagents</h3>
                  <p className="text-xs text-muted-foreground">
                    How long a finished subagent stays in the default (non-history) view.
                  </p>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">Window (hours, 1–720; default 24)</span>
                    <Input
                      type="number"
                      min={1}
                      max={720}
                      value={subagentsWindow}
                      placeholder="24"
                      onChange={(e) => {
                        setSubagentsWindow(e.target.value.trim());
                        setSubagentsWindowCleared(false);
                      }}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSubagentsWindow("");
                      setSubagentsWindowCleared(true);
                    }}
                  >
                    Reset to default (24h)
                  </Button>
                </section>
                <div className="flex items-center gap-3">
                  <Button type="button" onClick={() => void save()} disabled={status === "saving"}>
                    {status === "saving" ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save
                  </Button>
                  {status === "saved" ? (
                    <span className="text-xs text-muted-foreground">Saved.</span>
                  ) : null}
                  {error ? <span className="text-xs text-destructive">{error}</span> : null}
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function EmptySection({ title, body }: { title: string; body: string }) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted-foreground">{body}</p>
    </section>
  );
}
