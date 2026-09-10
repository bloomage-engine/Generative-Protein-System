import type { Study, Id, Run, Artifact, Evidence, Conclusion, Session } from "./types.js";
import type { RecordStore } from "./index.js";

/**
 * Dev/test-grade in-memory implementation of the authoritative record store.
 * Entities are stored by id and returned as copies; deletions are not part of
 * the interface, so entries are never removed.
 */
export function createInMemoryRecordStore(): RecordStore {
  const studies = new Map<Id, Study>();
  const sessions = new Map<Id, Session>();
  const runs = new Map<Id, Run>();
  const artifacts = new Map<Id, Artifact>();
  const evidence = new Map<Id, Evidence>();
  const conclusions = new Map<Id, Conclusion>();

  const clone = <T>(v: T): T => structuredClone(v);

  return {
    async createStudy(study: Study): Promise<Study> {
      studies.set(study.id, clone(study));
      return clone(study);
    },
    async getStudy(id: Id): Promise<Study | null> {
      const s = studies.get(id);
      return s ? clone(s) : null;
    },
    async addSession(session: Session): Promise<Session> {
      sessions.set(session.id, clone(session));
      return clone(session);
    },
    async getSession(id: Id): Promise<Session | null> {
      const s = sessions.get(id);
      return s ? clone(s) : null;
    },
    async addRun(run: Run): Promise<Run> {
      runs.set(run.id, clone(run));
      return clone(run);
    },
    async updateRun(id: Id, patch: Partial<Run>): Promise<Run> {
      const prev = runs.get(id);
      if (!prev) throw new Error(`run not found: ${id}`);
      const next = { ...prev, ...patch };
      runs.set(id, clone(next));
      return clone(next);
    },
    async addArtifact(artifact: Artifact): Promise<Artifact> {
      artifacts.set(artifact.id, clone(artifact));
      return clone(artifact);
    },
    async addEvidence(evidenceRow: Evidence): Promise<Evidence> {
      evidence.set(evidenceRow.id, clone(evidenceRow));
      return clone(evidenceRow);
    },
    async getConclusions(studyId: Id): Promise<Conclusion[]> {
      return [...conclusions.values()]
        .filter((c) => c.studyId === studyId)
        .map(clone);
    },
  };
}