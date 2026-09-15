import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv, parseConfigEnv, serializeConfigEnv } from "../src/shared/config.js";
import { resolveDesktopPaths } from "../src/shared/paths.js";

test("parseConfigEnv reads KEY=VALUE, ignoring blanks and comments", () => {
  const config = parseConfigEnv("# route\nDSH_PROVIDER=ollama-local\n\nDSH_MODEL=qwen3.8:latest\nOLLAMA_LOCAL_API_KEY=secret\n");
  assert.deepEqual(config, {
    provider: "ollama-local",
    model: "qwen3.8:latest",
    vars: { OLLAMA_LOCAL_API_KEY: "secret" },
  });
});

test("serializeConfigEnv round-trips through parseConfigEnv", () => {
  const config = { provider: "deepseek-official", model: "deepseek-v4-flash", vars: { DEEPSEEK_API_KEY: "k" } };
  assert.deepEqual(parseConfigEnv(serializeConfigEnv(config)), config);
});

test("buildChildEnv pins dsh and the app's directories", () => {
  const paths = resolveDesktopPaths({ userDataDir: "/ud", homeDir: "/home/me" });
  const env = buildChildEnv({ base: { PATH: "/bin" }, config: { provider: "p", model: "m" }, paths });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.TRANSPORT_RUNTIME, "dsh");
  assert.equal(env.DSH_PROVIDER, "p");
  assert.equal(env.DSH_MODEL, "m");
  assert.equal(env.DSH_DEFAULT_SESSION, "science-studio");
  assert.equal(env.DSH_HOME, "/ud/dsh");
  assert.equal(env.DSH_TRANSCRIPT_DIR, "/ud/transcripts");
  assert.equal(env.PROJECT_ROOT, "/home/me/Documents/Science Studio/projects");
  assert.equal(env.RECORD_STORE_PATH, "/ud/record.jsonl");
  assert.equal(env.SS_ENTERPRISE_MODULE, undefined);
});
