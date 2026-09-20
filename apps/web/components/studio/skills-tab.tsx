"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchSkills,
  installSkill,
  removeSkill,
  type SkillInfo,
  type SkillInstallInput,
  type SkillsView,
} from "@science-studio/transport-client";

/**
 * The Skills tab (docs/adr/0020): a read-only inventory of the GLOBAL skills the
 * dsh harness discovers, and install / remove for the active Project's own
 * skills. The project scope follows the workbench's active Project; the tab
 * talks only to `/api/skills*`, never the settings file.
 */
export function SkillsTab({ projectId }: { projectId: string | null }) {
  const [view, setView] = React.useState<SkillsView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showForm, setShowForm] = React.useState(false);

  // A failed refresh KEEPS the last good view (the same keep-last policy every
  // other surface uses); it only becomes the error state when there is nothing
  // to show.
  const load = React.useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      setView(await fetchSkills(projectId ? { projectId } : {}));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [projectId]);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    void load().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [load]);

  /** Run one action, then refresh. Returns false (keeping a form's input) on failure. */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await action();
      return await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading…
      </p>
    );
  }

  // A transport failure is NOT the `available:false` "no surface" answer
  // (docs/adr/0021) — it is an error the user can retry.
  if (view === null && error !== null) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Skills</h3>
        <p className="text-xs text-destructive">{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </section>
    );
  }

  if (view && !view.available) {
    return (
      <section className="space-y-1">
        <h3 className="text-sm font-semibold">Skills</h3>
        <p className="text-xs text-muted-foreground">
          Skills are available on the dsh runtime
          {view.runtime ? ` (the active runtime is ${view.runtime}).` : "."}
        </p>
      </section>
    );
  }

  const skills = view?.skills ?? [];
  const projectSkills = skills.filter((s) => s.scope === "project");
  const globalSkills = skills.filter((s) => s.scope === "global");

  return (
    <div className="space-y-6">
      <ProjectSection
        skills={projectSkills}
        error={error}
        onInstall={() => setShowForm((open) => !open)}
        showForm={showForm}
        onSubmit={(input) => run(() => installSkill(projectId ? { projectId } : {}, input))}
        onRemove={(name) => run(() => removeSkill(projectId ? { projectId } : {}, name))}
      />
      <GlobalSection
        skills={globalSkills}
        onCopy={(name) =>
          run(() => installSkill(projectId ? { projectId } : {}, { copyFrom: { name } }))
        }
      />
    </div>
  );
}

function ProjectSection({
  skills,
  showForm,
  error,
  onInstall,
  onSubmit,
  onRemove,
}: {
  skills: SkillInfo[];
  showForm: boolean;
  error: string | null;
  onInstall: () => void;
  onSubmit: (input: SkillInstallInput) => Promise<boolean>;
  onRemove: (name: string) => Promise<unknown>;
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [body, setBody] = React.useState("");
  const [modelInvocable, setModelInvocable] = React.useState(true);
  const [userInvocable, setUserInvocable] = React.useState(true);
  const [overwrite, setOverwrite] = React.useState(false);
  const [confirming, setConfirming] = React.useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const ok = await onSubmit({
      name: name.trim(),
      description: description.trim(),
      body,
      invocation: { modelInvocable, userInvocable },
      overwrite,
    });
    if (!ok) return; // keep the typed values so the user can fix and retry
    setName("");
    setDescription("");
    setBody("");
    setOverwrite(false);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Project skills</h3>
        <Button type="button" variant="outline" size="sm" onClick={onInstall}>
          {showForm ? "Cancel" : "Install skill"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        A skill installed here is a file in this Project&apos;s workspace; it applies to the active
        session.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {showForm ? (
        <div className="space-y-3 rounded-md border p-3">
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">Name (kebab-case)</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. molql" />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">Description</span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When should the model use this skill?"
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">Instructions</span>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Markdown instructions the model loads on demand."
              rows={5}
            />
          </label>
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={modelInvocable}
                onChange={(e) => setModelInvocable(e.target.checked)}
              />
              Model can invoke
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={userInvocable}
                onChange={(e) => setUserInvocable(e.target.checked)}
              />
              User can invoke
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              Overwrite existing
            </label>
          </div>
          <Button type="button" size="sm" onClick={() => void submit()}>
            Create skill
          </Button>
        </div>
      ) : null}

      {skills.length === 0 ? (
        <p className="text-xs text-muted-foreground">No project skills yet.</p>
      ) : (
        <ul className="space-y-2">
          {skills.map((skill) => (
            <li key={`${skill.source}/${skill.name}`} className="rounded-md border p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {skill.name}
                    {skill.shadowed ? (
                      <span className="ml-2 text-muted-foreground">(shadowed)</span>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground">{skill.description}</p>
                  <p className="mt-1 text-[0.7rem] text-muted-foreground">
                    {skill.source} · {skill.path}
                  </p>
                </div>
                {skill.source !== "project-dsh" ? (
                  <span className="shrink-0 text-muted-foreground">Read-only</span>
                ) : confirming === skill.name ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      aria-label={`Confirm remove ${skill.name}`}
                      onClick={() => {
                        setConfirming(null);
                        void onRemove(skill.name);
                      }}
                    >
                      Confirm remove
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Remove ${skill.name}`}
                    onClick={() => setConfirming(skill.name)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GlobalSection({
  skills,
  onCopy,
}: {
  skills: SkillInfo[];
  onCopy: (name: string) => Promise<unknown>;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Global skills</h3>
      <p className="text-xs text-muted-foreground">
        Discovered from the harness user roots. Read-only here; copy one into the Project to edit it.
      </p>
      {skills.length === 0 ? (
        <p className="text-xs text-muted-foreground">No global skills found.</p>
      ) : (
        <ul className="space-y-2">
          {skills.map((skill) => (
            <li key={`${skill.source}/${skill.name}`} className="rounded-md border p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {skill.name}
                    {skill.shadowed ? (
                      <span className="ml-2 text-muted-foreground">(shadowed by a project skill)</span>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground">{skill.description}</p>
                  <p className="mt-1 text-[0.7rem] text-muted-foreground">
                    {skill.source} · {skill.path}
                  </p>
                </div>
                {skill.shadowed ? null : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Copy ${skill.name} to project`}
                    onClick={() => void onCopy(skill.name)}
                  >
                    Copy to project
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
