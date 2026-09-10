/**
 * The record-backed session directory.
 *
 * Science Studio owns the record (`docs/adr/0002`), so the normalized
 * `SessionState` a run is driven with must come from the record layer rather
 * than from fabricated constants. A runtime session key IS the Science Studio
 * Session id (1:1), and the first use of a key mints the Session — plus the
 * default Study it hangs off — so the record is authoritative from turn one.
 */
import type { Id, RecordStore, Session } from "@science-studio/record";

export interface SessionDefaults {
  projectId: Id;
  studyId: Id;
  agentBlueprintId: Id;
}

export const DEFAULT_SESSION_DEFAULTS: SessionDefaults = {
  projectId: "project-default",
  studyId: "study-default",
  agentBlueprintId: "main",
};

export interface SessionResolver {
  /** The Session a canonical runtime session key belongs to (creating it once). */
  resolve(sessionKey: string): Promise<Session>;
}

export function createSessionResolver(opts: {
  store: RecordStore;
  defaults?: SessionDefaults;
}): SessionResolver {
  const defaults = opts.defaults ?? DEFAULT_SESSION_DEFAULTS;
  /** De-duplicate concurrent first uses of the same key. */
  const inflight = new Map<string, Promise<Session>>();

  const create = async (sessionKey: string): Promise<Session> => {
    const study = await opts.store.getStudy(defaults.studyId);
    if (!study) {
      await opts.store.createStudy({
        id: defaults.studyId,
        projectId: defaults.projectId,
        objective: "Default study (created by the transport service on first use)",
        createdAt: new Date().toISOString(),
      });
    }
    const now = new Date().toISOString();
    return opts.store.addSession({
      id: sessionKey,
      studyId: defaults.studyId,
      agentBlueprintId: defaults.agentBlueprintId,
      createdAt: now,
      updatedAt: now,
    });
  };

  return {
    async resolve(sessionKey: string): Promise<Session> {
      const existing = await opts.store.getSession(sessionKey);
      if (existing) return existing;

      let pending = inflight.get(sessionKey);
      if (!pending) {
        pending = create(sessionKey).finally(() => inflight.delete(sessionKey));
        inflight.set(sessionKey, pending);
      }
      return pending;
    },
  };
}
