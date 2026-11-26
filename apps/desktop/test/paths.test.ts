import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDesktopPaths } from "../src/shared/paths.js";

test("internal state lives under userData", () => {
  const p = resolveDesktopPaths({ userDataDir: "/ud", homeDir: "/home/me" });
  assert.equal(p.configPath, "/ud/config.env");
  assert.equal(p.settingsPath, "/ud/settings.json");
  assert.equal(p.recordStorePath, "/ud/record.jsonl");
  assert.equal(p.dshHome, "/ud/dsh");
  assert.equal(p.transcriptDir, "/ud/transcripts");
});

test("Projects default to ~/Documents/Generative Protein System/projects", () => {
  const p = resolveDesktopPaths({ userDataDir: "/ud", homeDir: "/home/me" });
  assert.equal(p.projectRoot, "/home/me/Documents/Generative Protein System/projects");
});

test("an explicit PROJECT_ROOT wins", () => {
  const p = resolveDesktopPaths({ userDataDir: "/ud", homeDir: "/home/me", env: { PROJECT_ROOT: "/data/ss" } });
  assert.equal(p.projectRoot, "/data/ss");
});
