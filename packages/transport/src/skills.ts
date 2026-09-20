/**
 * The dsh skills contract (docs/adr/0020).
 *
 * A Skill is a runtime-owned, on-demand capability description: the model loads
 * its instructions only when a task matches, rather than carrying the full text
 * every session. It is a filesystem file (or a runtime registration) — never a
 * record entity — so these types carry no `Id`.
 *
 * They are the deep-module surface over the runtime's OWN skill system: the
 * service stays runtime-agnostic and only routes, while the adapter owns the
 * discovery rules and the frontmatter format. The optional `RuntimeAdapter`
 * methods that produce and mutate these values live in `types.ts`.
 */

/** Where a skill lives: shared across Projects, or owned by one Project. */
export type SkillScope = "global" | "project";

/** The two independent faces a skill declares (docs/adr/0020). */
export interface SkillInvocationPolicy {
  /** May the model see it in its catalog and load it? */
  modelInvocable: boolean;
  /** May a user trigger it with a `/name` gesture? */
  userInvocable: boolean;
}

/** One discovered skill, as the adapter reports it. */
export interface SkillInfo {
  /** Exact kebab-case name the runtime and the model use. */
  name: string;
  description: string;
  scope: SkillScope;
  /**
   * The discovery source / rank label the adapter assigned, e.g.
   * `project-dsh`, `project-agents`, `user-dsh`, `user-agents`.
   */
  source: string;
  /** Host path (global) or workspace-relative path (project), for display. */
  path: string;
  invocation: SkillInvocationPolicy;
  /** A nearer-scope same-name skill overrides this entry. */
  shadowed?: boolean;
}

/** The structured install input. `copyFrom` copies an existing global skill. */
export interface SkillInstallInput {
  /** Target kebab-case name. Required unless `copyFrom` supplies one. */
  name?: string;
  description?: string;
  /** Markdown instructions body. */
  body?: string;
  invocation?: Partial<SkillInvocationPolicy>;
  /** Copy a global skill's bundle instead of the form fields. */
  copyFrom?: { name: string };
  /** Replace an existing project skill of the same name. */
  overwrite?: boolean;
}

/** The supplied skill input is invalid (a bad name, or an empty description). */
export class SkillInvalidError extends Error {
  constructor(readonly detail: string) {
    super(`invalid skill: ${detail}`);
    this.name = "SkillInvalidError";
  }
}

/** The supplied skill name is not a valid kebab-case name. */
export class SkillNameInvalidError extends SkillInvalidError {
  constructor(detail: string) {
    super(detail);
    this.name = "SkillNameInvalidError";
    this.message = `invalid skill name: ${detail}`;
  }
}

/** A Project skill of that name already exists and `overwrite` was not set. */
export class SkillExistsError extends Error {
  constructor(readonly skillName: string) {
    super(`skill already exists: ${skillName}`);
    this.name = "SkillExistsError";
  }
}

/** The named Project skill does not exist. */
export class SkillNotFoundError extends Error {
  constructor(readonly skillName: string) {
    super(`skill not found: ${skillName}`);
    this.name = "SkillNotFoundError";
  }
}
