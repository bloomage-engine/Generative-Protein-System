"use client";

/**
 * Frontend Action Registry.
 *
 * The agent's tools arrive as ordinary `tool-call` message parts; some of them
 * are *instructions to the UI* rather than data (the `molql` tool tells the
 * structure viewer what to highlight). This registry maps a tool name to the
 * handler that performs the UI change, and `FrontendBridge` dispatches each
 * completed tool call exactly once.
 *
 * Kept app-local (not in `@gps/transport-client`): the handlers are
 * bound to this app's viewer, and the concept is young — promote the generic
 * dispatch part only if the examples need it too.
 */

export type ActionHandler = (payload: unknown) => void | Promise<void>;

const registry = new Map<string, ActionHandler>();

/** Register (or replace) the handler for a tool name. */
export function registerAction(name: string, handler: ActionHandler): void {
  if (registry.has(name)) {
    console.warn(`[frontend-actions] handler for "${name}" replaced`);
  }
  registry.set(name, handler);
}

/**
 * Run the handler registered for `name`. Rejects when no handler is registered
 * or the handler throws/fails, so the caller can reflect the outcome.
 */
export async function executeAction(name: string, payload: unknown): Promise<void> {
  const handler = registry.get(name);
  if (!handler) throw new Error(`no handler registered for "${name}"`);
  await handler(payload);
}

/** The tool names the bridge should render/dispatch. */
export function getRegisteredActions(): string[] {
  return Array.from(registry.keys());
}
