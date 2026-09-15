/**
 * The seam-level rule for runtime commands (docs/adr/0003), shared by every
 * adapter so no two runtimes can disagree about what a command message is.
 *
 * A command is ordinary user text, not a wire type: any message whose text
 * starts with `/` is a runtime command — from the slash menu, typed by hand, or
 * written by a remote client. An adapter answers it inside its own runtime and
 * NEVER persists a `Run` for it, because a command is not a research turn.
 */
export function isCommandText(text: string): boolean {
  return text.trimStart().startsWith("/");
}
