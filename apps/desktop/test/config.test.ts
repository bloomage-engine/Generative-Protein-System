import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv, parseConfigEnv, serializeConfigEnv } from "../src/shared/config.js";
import { resolveDesktopPaths } from "../src/shared/paths.js";

test("parseConfigEnv reads KEY=VALUE, ignoring blanks and comments", () => {
  const config = parseConfigEnv("# route\nOLLAMA_LOCAL_API_KEY=secret\n\nEXTRA=1\n");
  assert.deepEqual(config, { vars: { OLLAMA_LOCAL_API_KEY: "secret", EXTRA: "1" } });
});

test("serializeConfigEnv round-trips through parseConfigEnv", () => {
  const config = { vars: { DEEPSEEK_API_KEY: "k", A: "b" } };
  assert.deepEqual(parseConfigEnv(serializeConfigEnv(config)), config);
});

test("an empty config round-trips through parseConfigEnv", () => {
  assert.deepEqual(parseConfigEnv(serializeConfigEnv({})), {});
});

test("buildChildEnv pins dsh and the app's directories", () => {
  const paths = resolveDesktopPaths({ userDataDir: "/ud", homeDir: "/home/me" });
  const env = buildChildEnv({
    base: { PATH: "/bin", SS_ENTERPRISE_MODULE: "x" },
    config: { vars: { OLLAMA_LOCAL_API_KEY: "k" } },
    paths,
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.TRANSPORT_RUNTIME, "dsh");
  assert.equal(env.DSH_PROVIDER, undefined);
  assert.equal(env.DSH_MODEL, undefined);
  assert.equal(env.OLLAMA_LOCAL_API_KEY, "k");
  assert.equal(env.SS_SETTINGS_PATH, "/ud/settings.json");
  assert.equal(env.DSH_DEFAULT_SESSION, "science-studio");
  assert.equal(env.DSH_HOME, "/ud/dsh");
  assert.equal(env.DSH_TRANSCRIPT_DIR, "/ud/transcripts");
  assert.equal(env.PROJECT_ROOT, "/home/me/Documents/Science Studio/projects");
  assert.equal(env.RECORD_STORE_PATH, "/ud/record.jsonl");
  assert.equal(env.SS_ENTERPRISE_MODULE, undefined);
});
