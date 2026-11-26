import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryRecordStore, createJsonlRecordStore } from "@gps/record";
import { testTranscriptAndSubagent } from "../src/index.js";

testTranscriptAndSubagent("in-memory record", async () => ({ store: createInMemoryRecordStore() }));

testTranscriptAndSubagent("jsonl record", async () => {
  const d = await mkdtemp(join(tmpdir(), "ct-rec-"));
  return {
    store: await createJsonlRecordStore(join(d, "record.jsonl")),
    dispose: async () => {
      await rm(d, { recursive: true, force: true });
    },
  };
});
