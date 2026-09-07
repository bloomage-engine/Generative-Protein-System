import {
  GatewayProtocolClient,
  buildGatewayConnectAuth,
  resolveGatewayConnectScopes,
  selectGatewayConnectAuth,
  type EventFrame,
  type GatewayProtocolRequestError,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";
import { GATEWAY_CLIENT_CAPS } from "@openclaw/gateway-protocol/client-info";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import type { ConnectParams } from "@openclaw/gateway-protocol";

export const DEFAULT_SCOPES: readonly string[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
];

export const DEFAULT_CAPS: readonly string[] = [
  GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
  GATEWAY_CLIENT_CAPS.APPROVALS,
  GATEWAY_CLIENT_CAPS.EXEC_APPROVALS,
  GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS,
  GATEWAY_CLIENT_CAPS.AGENT_KIND,
];

export interface BackendGatewayOptions {
  url: string;
  token: string;
  version: string;
  scopes?: readonly string[];
  caps?: readonly string[];
  client?: Partial<Pick<ConnectParams["client"], "displayName">>;
}

export type BackendGateway = {
  readonly connected: boolean;
  start: () => void;
  stop: () => void;
  request: <T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ) => Promise<T>;
  onEvent: (listener: (event: EventFrame) => void) => () => void;
  onReady: (listener: () => void) => () => void;
};

type GatewayConnectPlan = {
  clientId: string;
  role: "operator";
  identity: null;
  selectedAuth: ReturnType<typeof selectGatewayConnectAuth>;
  scopes: string[];
  auth: ReturnType<typeof buildGatewayConnectAuth>;
};

/**
 * Server-side connection to the OpenClaw gateway. Unlike the browser adapter
 * (which device-pairs for scopes), this connects as an operator client with the
 * shared token — appropriate for the backend transport-service.
 */
export function createBackendGateway(opts: BackendGatewayOptions): BackendGateway {
  const scopes = opts.scopes?.length ? [...opts.scopes] : [...DEFAULT_SCOPES];
  const caps = [...(opts.caps ?? DEFAULT_CAPS)];
  const role = "operator" as const;
  const client = {
    id: "cli",
    version: opts.version,
    platform: "node",
    mode: "cli",
    ...(opts.client?.displayName ? { displayName: opts.client.displayName } : {}),
  } as unknown as ConnectParams["client"];

  const readyListeners = new Set<() => void>();
  let ready = false;

  const wireClient = new GatewayProtocolClient<GatewayConnectPlan>({
    createSocket: (handlers) => makeNodeSocket(opts.url, handlers),
    createRequestId: () => createId(),
    handshake: { mode: "require-challenge", timeoutMs: 15_000 },
    reconnect: { initialMs: 1_000, multiplier: 2, maxMs: 30_000 },
    buildConnectPlan: async () => {
      const selectedAuth = selectGatewayConnectAuth({
        token: opts.token,
        bootstrapToken: undefined,
        password: undefined,
      });
      return {
        clientId: client.id,
        role,
        identity: null,
        selectedAuth,
        scopes,
        auth: buildGatewayConnectAuth(selectedAuth),
      } satisfies GatewayConnectPlan;
    },
    buildConnectParams: (plan) => ({
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client,
      role,
      scopes: resolveGatewayConnectScopes({ requestedScopes: plan.scopes, defaultScopes: scopes }),
      caps,
      auth: plan.auth,
      locale: "en-US",
    }),
    onHello: () => {
      if (!ready) {
        ready = true;
        for (const l of readyListeners) l();
      }
    },
    onConnectFailure: (_error: GatewayProtocolRequestError) => ({ closeCode: 4000, closeReason: "connect failed" }),
    resolveClose: () => ({ retry: true, notify: true }),
  });

  return {
    get connected() {
      return wireClient.connected;
    },
    start: () => wireClient.start(),
    stop: () => wireClient.stop(),
    request: (method, params, options) => wireClient.request(method, params, options),
    onEvent: (listener) => wireClient.addEventListener(listener),
    onReady: (listener) => {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
  };
}

function sanitizeCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return 4000;
}

/** Node WebSocket factory (Node 22+ exposes a global WebSocket). */
function makeNodeSocket(url: string, handlers: GatewayProtocolSocketHandlers): GatewayProtocolSocket {
  const WS: new (url: string) => {
    readyState: number;
    onopen: (() => void) | null;
    onmessage: ((e: { data: unknown }) => void) | null;
    onclose: ((e: { code: number; reason: string }) => void) | null;
    onerror: ((e: unknown) => void) | null;
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
  } = (globalThis as { WebSocket: typeof WS }).WebSocket;
  const ws = new WS(url);
  ws.onopen = handlers.open;
  ws.onmessage = (e) => handlers.message(String(e.data));
  ws.onclose = (e) => handlers.close(e.code, e.reason);
  ws.onerror = () => handlers.error(new Error("websocket error"));
  return {
    isOpen: () => ws.readyState === 1,
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code === undefined ? undefined : sanitizeCloseCode(code), reason),
  };
}

function createId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
