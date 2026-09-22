import { test } from "node:test";
import assert from "node:assert/strict";
import { isTextMime, mimeFor } from "../src/mime.js";

test("well-known text formats keep their semantic mime types", () => {
  assert.equal(mimeFor("app.xml"), "application/xml");
  assert.equal(mimeFor("flow.yaml"), "application/yaml");
  assert.equal(mimeFor("model.cif"), "application/octet-stream");
});

test("common text formats are served inline as text, by name and from paths", () => {
  assert.equal(mimeFor("settings.toml"), "application/toml");
  assert.equal(mimeFor("settings.TOML"), "application/toml");
  assert.equal(mimeFor("config.ini"), "text/plain");
  assert.equal(mimeFor("app.properties"), "text/plain");
  assert.equal(mimeFor("query.sql"), "text/plain");
  assert.equal(mimeFor("table.csv"), "text/csv");
  assert.equal(mimeFor("page.html"), "text/html");
  // the map is keyed by the BASENAME, so a path must not poison the lookup
  assert.equal(mimeFor("a/b/settings.toml"), "application/toml");
  assert.equal(mimeFor("a/b/notes.txt"), "text/plain");
});

test("env files are text even though they carry no real extension", () => {
  assert.equal(mimeFor(".env"), "text/plain");
  assert.equal(mimeFor(".env.local"), "text/plain");
  assert.equal(mimeFor("a/b/.env"), "text/plain");
  // ...but only the conventional `.env` spellings
  assert.equal(mimeFor("env"), "application/octet-stream");
  assert.equal(mimeFor("env.txt"), "text/plain");
});

test("isTextMime admits the formats the client must read as text", () => {
  assert.equal(isTextMime("text/plain"), true);
  assert.equal(isTextMime("text/markdown"), true);
  assert.equal(isTextMime("application/json"), true);
  assert.equal(isTextMime("application/yaml"), true);
  assert.equal(isTextMime("application/xml"), true);
  assert.equal(isTextMime("application/toml"), true);
  assert.equal(isTextMime("application/octet-stream"), false);
  assert.equal(isTextMime("image/png"), false);
});
