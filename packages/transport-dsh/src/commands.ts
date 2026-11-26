import type { CommandDescriptor } from "@science-studio/transport";

/**
 * The dsh runtime command layer (docs/adr/0003, docs/adr/0010, docs/adr/0011):
 * two layers under one menu.
 *
 * openclaw's catalog is the GATEWAY's own command list, curated by the adapter.
 * dsh's SDK stdio profile speaks exactly three methods
 * (`initialize`/`session/prompt`/`shutdown`) — no command plane — but the
 * harness's own command registry IS mounted in our child (the `/compact`,
 * `/plan`, `/goal` and `/feedback` plugins the base profile mounts). The bridge
 * plugin this package ships into that child over a per-launch profile patch
 * exposes it, so:
 *
 * - the LOCAL layer below (`/status`, `/new`) is what the adapter answers from
 *   its own state, with no harness at all — it must keep working where the
 *   harness could not launch;
 * - everything else is the HARNESS's registry, executed in the child and
 *   rendered as its own result text.
 *
 * Either way the seam rules hold verbatim (docs/adr/0003): a `/`-prefixed
 * message is a command, it is answered as an ordinary assistant row in the
 * transcript, it never becomes a research `Run`, and it is NEVER downgraded to a
 * model prompt — an unknown or malformed command line is answered here, not sent
 * to the model, which is also how the harness's own command adapter treats one.
 */

/** What a command may read about the session it is invoked in. */
export interface DshCommandFacts {
  /** The Science Studio session key (1:1 with the record's Session). */
  sessionKey: string;
  /** Harness profile this adapter's child was launched with. */
  profile: string;
  provider: string;
  model: string;
  /** The agent's working directory — the active Project's workspace. */
  cwd: string;
  /** The harness session this session talks to, or `null` before its first turn. */
  harnessSessionId: string | null;
}

/** What one invocation resolves to. */
export interface DshCommandResult {
  /** Markdown reply, written to the transcript as an assistant row. */
  reply: string;
  /** `/new`: drop the harness conversation, so the next turn starts a fresh one. */
  resetConversation?: boolean;
}

interface DshCommand {
  descriptor: CommandDescriptor;
  run(facts: DshCommandFacts): DshCommandResult;
}

const STATUS: DshCommand = {
  descriptor: {
    id: "status",
    label: "/status",
    description: "Show this session's runtime route, workspace and agent conversation",
    category: "status",
    invocationText: "/status",
  },
  run(facts) {
    return {
      reply: [
        `**dsh** · harness profile \`${facts.profile}\` · session \`${facts.sessionKey}\``,
        "",
        `- model: \`${facts.provider}/${facts.model}\``,
        `- workspace: \`${facts.cwd}\``,
        `- agent conversation: ${
          facts.harnessSessionId
            ? `\`${facts.harnessSessionId}\``
            : "not started yet — the next message starts one"
        }`,
      ].join("\n"),
    };
  },
};

const NEW: DshCommand = {
  descriptor: {
    id: "new",
    label: "/new",
    description: "Start a fresh agent conversation — the agent no longer sees earlier turns here",
    category: "session",
    invocationText: "/new",
  },
  run() {
    return {
      reply:
        "Started a fresh agent conversation. Earlier turns stay in this transcript, but the agent no longer sees them.",
      resetConversation: true,
    };
  },
};

/**
 * The harness commands the pinned `sdk` profile mounts: the COLD fallback under
 * the live harness catalog.
 *
 * The harness's registry is agent-scoped: `list(agent)`/`find(agent, name)` both
 * resolve through the receiving agent, and no agent exists until a session
 * prompts — so there is NO way to enumerate it before the first turn of a
 * Project. Without this layer a fresh page load (or every service restart, which
 * kills the child) would show only the local pair, and the harness's own
 * commands would look missing until the user had already sent a message.
 *
 * This is a CURATION, the way the openclaw adapter curates its gateway catalog,
 * and it is version-tied: the pinned `@deepseek-ai/dsh-sdk-client` launches the
 * same-version harness whose base profile mounts these (docs/adr/0011). It is
 * only ever a fallback — the moment the live catalog answers with anything, that
 * IS the menu, so a command this harness dropped disappears again (and a name
 * this list gets wrong answers with {@link harnessCommandReply}'s
 * `Unknown command` line rather than failing). One row is this package's OWN:
 * the project plugin's `/project` (docs/adr/0012), listed here for the same
 * reason the pinned profile's commands are.
 */
export const DSH_HARNESS_FALLBACK_DESCRIPTORS: readonly CommandDescriptor[] = [
  {
    id: "compact",
    label: "/compact",
    description: "Compact older conversation history",
    invocationText: "/compact",
  },
  {
    id: "feedback",
    label: "/feedback",
    description: "record feedback about this session",
    invocationText: "/feedback",
  },
  {
    id: "goal",
    label: "/goal",
    description: "set or view the goal for a long-running task",
    invocationText: "/goal",
  },
  {
    id: "permission",
    label: "/permission",
    description: "Switch the permission preset (sandbox mode + approval policy)",
    invocationText: "/permission",
  },
  {
    id: "plan",
    label: "/plan",
    description: "Enter or leave plan mode",
    invocationText: "/plan",
  },
  // This package's OWN project plugin registers `/project` in the harness
  // registry (docs/adr/0012), but a cold child cannot be asked for it, so its
  // menu row is curated here too — the same reason the pinned profile's own
  // commands are listed above.
  {
    id: "project",
    label: "/project",
    description: "确保项目目录结构与 PROJECT.md 简报就绪，并报告状态",
    invocationText: "/project",
  },
  // This package's own cron plugin registers `/cron` in the harness registry
  // (like `/project`), listed here for the same cold-menu reason.
  {
    id: "cron",
    label: "/cron",
    description: "列出本项目的定时任务",
    invocationText: "/cron",
  },
  // This package's own worktree plugin registers `/worktree` in the harness
  // registry (like `/project` and `/cron`), listed here for the same cold-menu
  // reason: a cold child cannot be asked for it.
  {
    id: "worktree",
    label: "/worktree",
    description: "列出本项目的 worktree 分支",
    invocationText: "/worktree",
  },
];

/** The dsh command catalog, in menu order. */
export const DSH_COMMANDS: readonly DshCommand[] = [STATUS, NEW];

/** The dsh command descriptors (the slash menu's view of {@link DSH_COMMANDS}). */
export const DSH_COMMAND_DESCRIPTORS: readonly CommandDescriptor[] = DSH_COMMANDS.map(
  (command) => command.descriptor,
);

/**
 * What one HARNESS command invocation resolved to. The bridge client
 * (`bridge.ts`) returns exactly this union, so there is no second shape for a
 * transport failure to hide in.
 */
export type HarnessBridgeOutcome =
  | { status: "ok"; kind: "success" | "error"; text?: string }
  | { status: "unknown" }
  | { status: "no-agent" }
  | { status: "unavailable"; message: string };

/**
 * What one invocation resolved to for the behavior.
 *
 * `cold` is not a bridge answer: it is the handoff for a session this harness
 * child has no agent for (it has not prompted yet, or `/new` dropped its
 * conversation). The registry is agent-scoped, so there is nothing to execute
 * the line against — and the SDK wire only creates an agent through a prompt.
 * The behavior therefore drives the line as that session's FIRST prompt, which
 * is what creates the agent, while the child's bridge plugin intercepts it at
 * `agent/pre-step` and runs the registry instead of the model (docs/adr/0011).
 */
export type HarnessCommandOutcome = HarnessBridgeOutcome | { status: "cold" };

/**
 * The harness's own command registry for this Project's runtime (the bridge,
 * cached, with readiness) — the second layer under {@link DSH_COMMANDS}.
 */
export interface DshHarnessCommands {
  /** The harness's commands, `[]` when the harness is cold or unavailable. */
  list(): Promise<CommandDescriptor[]>;
  /**
   * Resolve one trimmed command line for `sessionId`'s harness agent — or, when
   * the session has none yet (`null`), hand it back as the cold case the
   * behavior drives as that session's first prompt.
   */
  execute(sessionId: string | null, line: string): Promise<HarnessCommandOutcome>;
  /**
   * Cancel the harness agent's active turn for one harness session id (a real
   * mid-turn abort the SDK wire cannot express — docs/adr/0004). Resolves once
   * the child acknowledges; a missing agent is a no-op.
   */
  interrupt(harnessSessionId: string): Promise<void>;
}

/**
 * The menu: this adapter's own commands first, then every harness command whose
 * name they do not claim.
 *
 * One rule serves the catalog AND execution: `/status` and `/new` are the
 * commands that must work with no harness at all, so a name claimed twice
 * resolves to the local one — and the behavior never forwards those names to
 * the harness.
 */
export function mergeCommandDescriptors(
  harness: readonly CommandDescriptor[],
  local: readonly CommandDescriptor[],
): CommandDescriptor[] {
  return [...local, ...harness.filter((descriptor) => !local.some((own) => own.id === descriptor.id))];
}

/**
 * The menu list of every invocation this runtime answers, for the
 * unknown-command reply.
 */
export function knownCommandList(descriptors: readonly CommandDescriptor[]): string {
  return descriptors.map((descriptor) => `\`${descriptor.invocationText}\``).join(", ");
}

/**
 * The reply text for one harness BRIDGE outcome — the transcript row the user
 * sees. The cold handoff has no row here: it is answered by the harness's own
 * `command/done` (or, for a line the registry does not resolve, by the same
 * `unknown` line this renders).
 */
export function harnessCommandReply(
  outcome: HarnessBridgeOutcome,
  name: string,
  descriptors: readonly CommandDescriptor[],
): string {
  switch (outcome.status) {
    case "ok":
      // The harness's markdown, unchanged. Its own result type makes `text`
      // mandatory for an error, so the text-less error below is unreachable —
      // and answering "completed" for it would be a lie, hence the failure line.
      if (outcome.text !== undefined) return outcome.text;
      return outcome.kind === "success" ? `\`/${name}\` completed.` : `\`/${name}\` failed.`;
    case "unknown":
      return `Unknown command \`/${name}\`. This runtime answers: ${knownCommandList(descriptors)}.`;
    case "no-agent":
      return `\`/${name}\` needs this session's agent, which has not started yet — send a message first, then run it again.`;
    case "unavailable":
      return `The dsh harness is not available, so \`/${name}\` cannot run — see the transport-service logs.`;
  }
}

/** A command line's name and its raw input. */
export interface ParsedCommandLine {
  name: string;
  /** Everything after the name and its separating whitespace. */
  args: string;
}

/**
 * The harness's own command-line grammar: a leading slash, a lowercase name of
 * letters/digits/`_`/`-`, then optional raw input. Anything else is not a
 * command line — and a message that is not one is answered with a syntax reply
 * rather than becoming a model prompt.
 */
const COMMAND_LINE = /^\/([a-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/;

/** Parse one command line, or `null` when the text is not one. */
export function parseCommandLine(text: string): ParsedCommandLine | null {
  const match = COMMAND_LINE.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!, args: (match[2] ?? "").trim() };
}

/** Every LOCAL command this adapter answers, as menu-ready invocation texts. */
function knownCommands(): string {
  return knownCommandList(DSH_COMMAND_DESCRIPTORS);
}

/**
 * Execute one command line. Always answers — an unknown name and a malformed
 * line get a reply too, so no `/`-prefixed message ever falls through to the
 * model (docs/adr/0003).
 */
export function executeDshCommand(line: string, facts: DshCommandFacts): DshCommandResult {
  const parsed = parseCommandLine(line);
  if (!parsed) {
    return {
      reply: `Not a command line. A command is \`/\` and a lowercase name, e.g. ${knownCommands()}.`,
    };
  }
  const command = DSH_COMMANDS.find((candidate) => candidate.descriptor.id === parsed.name);
  if (!command) {
    return {
      reply: `Unknown command \`/${parsed.name}\`. This runtime answers: ${knownCommands()}.`,
    };
  }
  // v1 commands take no arguments (docs/adr/0003): there is no argument-entry
  // UX, so an argument is a usage error instead of a silently ignored word.
  if (parsed.args) {
    return { reply: `Usage: \`${command.descriptor.invocationText}\` (no arguments).` };
  }
  return command.run(facts);
}
