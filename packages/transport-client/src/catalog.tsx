"use client";

import type { CommandDescriptor } from "@science-studio/transport";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FC,
  type PropsWithChildren,
} from "react";
import { DEFAULT_API } from "./use-transport.js";

/**
 * Runtime command catalog (docs/adr/0003).
 *
 * The transport endpoint exposes the runtime adapter's command catalog at
 * `${api}/commands`; the frontend fetches it once on mount and renders the
 * composer slash menu from it. The catalog is runtime-agnostic
 * (`CommandDescriptor`s produced by whatever adapter is registered), so the
 * web app never hardcodes a runtime's command set.
 */

const TransportApiContext = createContext<string>(DEFAULT_API);

/** Provide the transport base URL (`/api/transport` by default) to children. */
export const TransportApiProvider: FC<PropsWithChildren<{ api: string }>> = ({
  api,
  children,
}) => <TransportApiContext.Provider value={api}>{children}</TransportApiContext.Provider>;

/** The transport base URL from the nearest `TransportApiProvider`. */
export function useTransportApi(): string {
  return useContext(TransportApiContext);
}

/** Fetch the runtime command catalog. Throws on transport/HTTP failure. */
export async function fetchCommandCatalog(api: string): Promise<CommandDescriptor[]> {
  const url = `${api.replace(/\/+$/, "")}/commands`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`command catalog request failed: ${res.status}`);
  const body = (await res.json()) as { commands?: CommandDescriptor[] };
  return Array.isArray(body.commands) ? body.commands : [];
}

/**
 * The runtime command catalog for the slash menu.
 *
 * Returns `null` while the catalog is still loading or unavailable — the
 * caller should disable the "/" trigger then (an open popover over an empty
 * list would swallow Enter). A resolved `[]` means the runtime exposes no
 * commands (or the fetch failed): the composer behaves as plain chat, and a
 * hand-typed "/command" message still reaches the runtime unchanged.
 */
export function useRuntimeCommands(): CommandDescriptor[] | null {
  const api = useTransportApi();
  const [commands, setCommands] = useState<CommandDescriptor[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCommands(null);
    fetchCommandCatalog(api)
      .then((list) => {
        if (!cancelled) setCommands(list);
      })
      .catch((error) => {
        console.error("[transport-client] failed to load command catalog", error);
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return commands;
}
