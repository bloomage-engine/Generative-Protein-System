"use client";

import { useState } from "react";
import { createWorktree, type Worktree } from "@gps/transport-client";
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

const WORKTREES_API = process.env.NEXT_PUBLIC_WORKTREES_URL ?? "/api/worktrees";

/**
 * Create a linked Worktree under a Project (docs/adr/0025). The name is the only
 * required field: the branch defaults to the minted id and the base to `main`
 * server-side (the service is the single git writer), so both stay optional.
 */
export function WorktreeCreateDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onCreated: (worktree: Worktree) => void;
}) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setBranch("");
    setBase("");
    setError(null);
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const worktree = await createWorktree(WORKTREES_API, projectId, {
        name: trimmed,
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        ...(base.trim() ? { base: base.trim() } : {}),
      });
      onCreated(worktree);
      close(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            该项目的一个独立 git checkout，拥有自己的分支；在这里创建的会话会在其中运行。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            Name
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="exp-a"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Branch (optional)
            <Input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="defaults to the worktree id"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Base (optional)
            <Input
              value={base}
              onChange={(event) => setBase(event.target.value)}
              placeholder="defaults to main"
            />
          </label>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
