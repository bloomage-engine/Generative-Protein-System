"use client";

import { useState } from "react";
import { createCronTask, SCHEDULE_PRESETS, presetToExpression, type SchedulePreset } from "@gps/transport-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function NewCronTaskDialog({
  open,
  onOpenChange,
  projectId,
  sessionId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  sessionId: string | null;
  onCreated: (task: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<SchedulePreset>("daily");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const task = await createCronTask("/api/cron", { projectId }, {
        name: name.trim() || "Scheduled task",
        schedule: presetToExpression(preset, { hour, minute }),
        prompt,
        ...(sessionId ? { sessionId } : {}),
        enabled: true,
      });
      onCreated({ id: task.id, name: task.name });
      onOpenChange(false);
      setName("");
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New scheduled task</DialogTitle>
          <DialogDescription>Runs the prompt on a Session at the schedule below.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            Name
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily digest" />
          </label>
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs">
              Repeat
              <select
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                value={preset}
                onChange={(event) => setPreset(event.target.value as SchedulePreset)}
              >
                {SCHEDULE_PRESETS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Hour
              <Input
                type="number"
                min={0}
                max={23}
                className="w-20"
                value={hour}
                onChange={(event) => setHour(Number(event.target.value))}
                disabled={preset === "hourly"}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Minute
              <Input
                type="number"
                min={0}
                max={59}
                className="w-20"
                value={minute}
                onChange={(event) => setMinute(Number(event.target.value))}
                disabled={preset === "hourly"}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs">
            Prompt
            <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} />
          </label>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
