import { test } from "node:test";
import type { RecordStoreLike } from "@science-studio/transport";
import type { Id, PersistedTranscript, Subagent } from "@science-studio/record";

test("empty RecordStoreLike type-checks against the new contract", async () => {
  const impl: RecordStoreLike = {
    async addRun() {},
    async saveSessionTranscript() {},
    async loadSessionTranscript() { return null; },
    async upsertSubagent() {},
    async loadSubagent() { return null; },
    async listSubagents() { return []; },
  };
  const d: Promise<PersistedTranscript | null> = impl.loadSessionTranscript!("x");
  const s: Promise<Subagent | null> = impl.loadSubagent!("s");
  const list: Promise<Subagent[]> = impl.listSubagents!("p");
  const _a = [impl, d, s, list, "x" as Id];
});
