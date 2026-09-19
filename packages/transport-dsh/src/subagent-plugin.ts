/**
 * The CHILD-side parent-reporting plugin: a dependency-free cordis plugin
 * loaded into the dsh harness child via a per-launch profile patch. It
 * registers ONE host-scope system-prompt section that reaches the MAIN
 * agent (and any subagent child, unless shadowed) — telling the parent to
 * pick up each delegated subagent's result and report it to the user in
 * plain terms.
 *
 * The dsh harness already delivers the child's result to the parent
 * (foreground → a tool result; background, the `sdk` default → a settlement
 * notice); this section closes the "and now report it" step.
 *
 * Like `bridge-plugin.ts` / `project-plugin.ts` it imports NOTHING from
 * `@deepseek-ai/*`, never writes to stdout, and fails soft.
 */

export const name = "science-studio-subagent-reporting";
export const inject: readonly string[] = ["systemPrompt"];

interface PromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

interface SubagentHost {
  readonly systemPrompt?: { readonly section: (s: PromptSection) => () => void };
  readonly effect?: (register: () => (() => void), name: string) => void;
}

const SECTION: PromptSection = {
  name,
  order: 455, // alongside the science-studio sections (450 project, 460 cron); distinct + non-colliding
  text: [
    "When you delegate work to a subagent (the `subagent` or `subagent_fork` tool), its result comes back to you — either as a tool result (a foreground call) or as a later settlement notice (a background call).",
    "After each delegated subagent completes and its result arrives, read it and summarize the key finding and conclusion in plain language, and report that to the user.",
    "Never silently drop a subagent's result: if a subagent finished, say what it did and what it found, even if you will keep working on the larger task.",
    "If a subagent errored or left no closing message, say so plainly and what you will do about it.",
  ].join("\n"),
};

function warn(message: string, detail: unknown): void {
  const text = detail instanceof Error ? detail.message : String(detail);
  process.stderr.write(`[dsh subagent-reporting] ${message}: ${text}\n`);
}

export function apply(ctx: SubagentHost): void {
  const register = (): (() => void) => {
    const disposes: Array<() => void> = [];
    if (ctx.systemPrompt) {
      try {
        disposes.push(ctx.systemPrompt.section(SECTION));
      } catch (err) {
        warn("prompt section registration failed", err);
      }
    }
    return () => {
      for (let i = disposes.length - 1; i >= 0; i--) {
        try { disposes[i]?.(); } catch (err) { warn("dispose failed", err); }
      }
    };
  };
  try {
    if (ctx.effect) ctx.effect(register, name);
    else register();
  } catch (err) {
    /* best-effort: a host without a surface still registers nothing, but say so */
    warn("subagent-reporting plugin disabled", err);
  }
}
