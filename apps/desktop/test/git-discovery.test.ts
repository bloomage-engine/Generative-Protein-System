import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandWindowsEnv,
  findGitBinary,
  mergePathLists,
  parseRegPathOutput,
  prependPathEntry,
  splitPathList,
} from "../src/shared/git-discovery.js";
import { resolveWindowsGit } from "../src/main/win-env.js";

const ENV = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  USERPROFILE: "C:\\Users\\me",
  ProgramData: "C:\\ProgramData",
};

test("Windows PATH lists are merged and deduplicated case-insensitively", () => {
  const merged = mergePathLists(
    ["C:\\Windows;C:\\Tools\\Git\\cmd", "C:\\tools\\git\\cmd;D:\\ARRRRR\\Easier\\Git LFS"],
    "win32",
  );
  assert.deepEqual(merged, [
    "C:\\Windows",
    "C:\\Tools\\Git\\cmd",
    "D:\\ARRRRR\\Easier\\Git LFS",
  ]);
  assert.equal(prependPathEntry("D:\\Git\\cmd", merged.join(";"), "win32"), "D:\\Git\\cmd;C:\\Windows;C:\\Tools\\Git\\cmd;D:\\ARRRRR\\Easier\\Git LFS");
});

test("a Git directory beside Git LFS is found from the persisted PATH", () => {
  const entries = splitPathList("D:\\ARRRRR\\Easier\\Git LFS", "win32");
  const expected = "D:\\ARRRRR\\Easier\\Git\\cmd\\git.exe";
  assert.equal(findGitBinary(entries, "win32", (p) => p === expected, ENV), expected);
});

test("the Git LFS environment variable is a fallback when PATH only knows Git LFS", () => {
  const expected = "D:\\ARRRRR\\Easier\\Git\\cmd\\git.exe";
  const git = findGitBinary(
    [],
    "win32",
    (p) => p === expected,
    { ...ENV, GIT_LFS_PATH: "D:\\ARRRRR\\Easier\\Git LFS" },
  );
  assert.equal(git, expected);
});

test("a standard Git for Windows install is found without PATH entries", () => {
  const expected = "C:\\Program Files\\Git\\cmd\\git.exe";
  assert.equal(findGitBinary([], "win32", (p) => p === expected, ENV), expected);
});

test("resolveWindowsGit merges the persisted PATH and pins GIT_BINARY", () => {
  const expected = "D:\\ARRRRR\\Easier\\Git\\cmd\\git.exe";
  const resolved = resolveWindowsGit({
    basePath: "C:\\Windows",
    env: ENV,
    persistedPaths: ["D:\\ARRRRR\\Easier\\Git LFS;D:\\ARRRRR\\Easier\\Git\\cmd"],
    exists: (p) => p === expected,
  });
  assert.equal(resolved.git, expected);
  assert.match(resolved.path, /D:\\ARRRRR\\Easier\\Git\\cmd/);
});

test("resolveWindowsGit leaves GIT_BINARY unset when Git is absent", () => {
  const resolved = resolveWindowsGit({
    basePath: "C:\\Windows",
    env: ENV,
    persistedPaths: ["D:\\ARRRRR\\Easier\\Git LFS"],
    exists: () => false,
  });
  assert.equal(resolved.git, null);
  assert.match(resolved.path, /D:\\ARRRRR\\Easier\\Git LFS/);
});

test("reg.exe output parsing expands the persisted environment references", () => {
  const output =
    "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    D:\\ARRRRR\\Easier\\Git\\cmd;%USERPROFILE%\\bin\r\n";
  assert.equal(
    parseRegPathOutput(output),
    "D:\\ARRRRR\\Easier\\Git\\cmd;%USERPROFILE%\\bin",
  );
  assert.equal(
    expandWindowsEnv("D:\\ARRRRR\\Easier\\Git\\cmd;%USERPROFILE%\\bin", { USERPROFILE: "C:\\Users\\me" }),
    "D:\\ARRRRR\\Easier\\Git\\cmd;C:\\Users\\me\\bin",
  );
  assert.equal(parseRegPathOutput("no path value here"), null);
});
