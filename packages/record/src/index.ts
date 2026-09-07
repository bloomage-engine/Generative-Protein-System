import type { Study, Id, Run, Artifact, Evidence, Conclusion } from "./types.js";

export * from "./types.js";
export { createInMemoryRecordStore } from "./memory.js";

/**
 * The authoritative storage boundary for the research record.
 *
 * Science Studio owns the record; runtimes are adapters behind a transport seam
 * and never own it (see docs/adr/0002). The record layer implements this
 * interface; transport-service writes Runs/Artifacts/Evidence here.
 */
export interface RecordStore {
  createStudy(study: Study): Promise<Study>;
  getStudy(id: Id): Promise<Study | null>;
  addRun(run: Run): Promise<Run>;
  updateRun(id: Id, patch: Partial<Run>): Promise<Run>;
  addArtifact(artifact: Artifact): Promise<Artifact>;
  addEvidence(evidence: Evidence): Promise<Evidence>;
  getConclusions(studyId: Id): Promise<Conclusion[]>;
}
