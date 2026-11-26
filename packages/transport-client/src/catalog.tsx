"use client";

import type { CommandDescriptor } from "@gps/transport";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FC,
  type PropsWithChildren,
} from "react";
import { DEFAULT_API } from "./use-transport.js";
import { scopedUrl, type ClientScope } from "./scope.js";

/**
 * Runtime command catalog (docs/adr/0003).
 *
 * The transport endpoint exposes the runtime adapter's command catalog at
 * `${api}/commands`; the frontend fetches it once on mount and renders the
 * composer slash menu from it. The catalog is runtime-agnostic
 * (`CommandDescriptor`s produced by whatever adapter is registered), so the
 * web app never hardcodes a runtime's command set.
 */

/**
 * What the transport client is scoped to: the API base plus the Project whose
 * adapter serves it (`null` → the service's default Project) and the Worktree
 * that selects which of its Environments (docs/adr/0025). The scope rides in
 * context because the catalog is fetched deep in the registry composer, where
 * no prop reaches — the workspace provider has the same shape. It is not
 * decoration: the service provisions ONE adapter per (Project, Worktree)
 * (docs/adr/0008/0025), and those adapters can differ (route, workspace,
 * catalog), so a catalog fetched without the scope would describe another
 * Project's runtime.
 */
export interface TransportScope {
  api: string;
  scope: ClientScope;
}

const TransportApiContext = createContext<TransportScope>({
  api: DEFAULT_API,
  scope: { projectId: null },
});

/** Provide the transport base URL (`/api/transport` by default) and Project/Worktree. */
export const TransportApiProvider: FC<
  PropsWithChildren<{ api: string; project?: string | null; worktree?: string | null }>
> = ({ api, project = null, worktree = null, children }) => {
  const value = useMemo<TransportScope>(
    () => ({ api, scope: { projectId: project, worktreeId: worktree } }),
    [api, project, worktree],
  );
  return <TransportApiContext.Provider value={value}>{children}</TransportApiContext.Provider>;
};

/** The transport scope (API base + the Project/Worktree claim) from the nearest provider. */
export function useTransportApi(): TransportScope {
  return useContext(TransportApiContext);
}

/** Fetch the runtime command catalog for one (Project, Worktree). Throws on HTTP failure. */
export async function fetchCommandCatalog(
  api: string,
  scope: ClientScope = { projectId: null },
): Promise<CommandDescriptor[]> {
  const res = await fetch(scopedUrl(api, "/commands", scope), { headers: { accept: "application/json" } });
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
 *
 * `refreshToken` (optional) is anything whose CHANGE should re-read the catalog
 * — the web composer passes the thread's running flag, because a runtime whose
 * catalog only exists once it is warm (a spawned harness child, say) cannot
 * report its full catalog before the first run (docs/adr/0011). Only a change of
 * (api, project) clears the list: a refetch keeps the previously resolved
 * catalog rendered until the new one arrives, so the menu never blinks off, and
 * a failed refetch degrades to `[]` without a retry loop. Deliberately NOT read
 * from the thread state here — this hook is a public export that must work
 * without an assistant-ui runtime provider.
 */
export function useRuntimeCommands(refreshToken?: unknown): CommandDescriptor[] | null {
  const { api, scope } = useTransportApi();
  const { projectId, worktreeId } = scope;
  const [commands, setCommands] = useState<CommandDescriptor[] | null>(null);

  useEffect(() => {
    setCommands(null);
  }, [api, projectId, worktreeId]);

  useEffect(() => {
    let cancelled = false;
    fetchCommandCatalog(api, { projectId, worktreeId })
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
  }, [api, projectId, worktreeId, refreshToken]);

  return commands;
}
