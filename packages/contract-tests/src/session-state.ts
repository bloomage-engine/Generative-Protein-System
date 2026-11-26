/**
 * The `SessionState` fixture an adapter's tests drive.
 *
 * Adapter test suites used to hand-write this literal, and because no test file
 * was type-checked, ten of them drifted onto a field the seam does not have
 * (`studyId` — v1 dropped `Study`; docs/adr/0007) while still claiming to be a
 * Session. A fixture published HERE cannot drift: it is checked against the seam
 * it describes, and an adopter inherits a correct one instead of copying a
 * malformed literal out of a sibling test.
 */
import type { SessionState } from "@gps/transport/seams";

/** A minimal, valid `SessionState`; each entry of `over` replaces a whole field. */
export function sessionState(over: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "session-1",
    projectId: "project-1",
    agentId: "main",
    status: "idle",
    messages: [],
    ...over,
  };
}

/**
 * `sessionId` here is an arbitrary but VALID Session id, which is enough for the
 * contract cases that never involve runtime events. It is not a promise that the
 * id is canonical for any particular runtime: an adapter keys its per-session
 * state on the `sessionId` it is handed while routing runtime events by its own
 * canonical session key (`resolveSessionKey` — `agent:…` for openclaw), so a
 * case whose runtime namespaces sessions must pass its own key via
 * `AdapterLifecycleCase.session`. The SERVICE is what maps a client's claimed
 * threadId to that key before building the `SessionState` it hands to `run()`
 * (docs/adr/0002, 0007); an adapter must not re-map it.
 */
