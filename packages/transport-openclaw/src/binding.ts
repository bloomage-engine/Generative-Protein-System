/**
 * The openclaw runtime's OWN launch surface. It is deliberately NOT part of the
 * shared seam: the seam carries an opaque `RuntimeBinding`, and this module is
 * the only place that knows an openclaw gateway is a url/token pair.
 */
import {
  RuntimeBindingError,
  bindingOptionalString,
  bindingString,
  type RuntimeBinding,
  type RuntimeCapabilities,
} from "@science-studio/transport";

/** The private config shape of an openclaw `RuntimeBinding`. */
export interface GatewayBinding {
  url: string;
  token: string;
  /** Canonical session for thread ids the gateway does not namespace. */
  defaultSession?: string;
}

/** Validate an opaque binding against the openclaw shape, or throw. */
export function parseGatewayBinding(binding: RuntimeBinding): GatewayBinding {
  if (binding.runtime !== "openclaw") {
    throw new RuntimeBindingError(binding.runtime, 'expected runtime "openclaw"');
  }
  return {
    url: bindingString(binding, "url"),
    token: bindingOptionalString(binding, "token") ?? "",
    defaultSession: bindingOptionalString(binding, "defaultSession"),
  };
}

/** Build an openclaw binding (used by the local composition and tests). */
export function openClawBinding(url: string, token: string): RuntimeBinding {
  return { runtime: "openclaw", config: { url, token } };
}

/**
 * Single-user binding from the deployment env — the `LocalSandboxProvider` role
 * for openclaw, kept here so no core package names a gateway url/token.
 */
export function openClawLocalBinding(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeBinding {
  const defaultSession = env["OPENCLAW_DEFAULT_SESSION"];
  return {
    runtime: "openclaw",
    config: {
      url: env["OPENCLAW_GATEWAY_URL"] ?? "ws://127.0.0.1:18789",
      token: env["OPENCLAW_GATEWAY_TOKEN"] ?? "",
      ...(defaultSession ? { defaultSession } : {}),
    },
  };
}

export const OPENCLAW_CAPABILITIES: RuntimeCapabilities = {
  commandCatalog: true,
  remoteSettleWatch: true,
  tokenStreaming: true,
  approvals: true,
  hostedSandbox: true,
  perSessionCwd: false,
  subagents: false,
  subagentTranscript: false,
  /** MCP servers are gateway-managed, not consumed from the deployment catalog. */
  mcp: false,
};
