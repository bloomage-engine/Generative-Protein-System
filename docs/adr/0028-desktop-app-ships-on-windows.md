# The desktop app ships on Windows

The Desktop App is distributable on Windows x64 in addition to macOS and Linux.
Packaging is native to the target OS, the Windows artifact is a per-user NSIS
installer, and the embedded host got a Windows-aware lifecycle: Electron sends
an IPC shutdown and falls back to `taskkill /T /F` only when the graceful close
does not finish.

- **Status**: accepted
- **Context**: the desktop build grew up on POSIX: `build:web:standalone` used a
  `NEXT_OUTPUT=...` prefix, `dev`/`start` used `${VAR:-default}`, and the service
  `dev` script used `$HOME`, all of which cmd.exe cannot run. `electron-builder`
  had no `win` target. Windows also reports no SIGTERM to a forked child, so the
  host's signal-based shutdown would never run and the Next/dsh grandchildren
  could outlive the window. Two runtime assumptions were hidden by the POSIX
  path: `normalizeAgentRoot` turned `C:\...` into `/C:\...` (the dsh child's
  launch cwd), and the command bridge removed its socket path with `rmSync`,
  although a win32 named pipe is not a file. Separately, `build:host` listed the
  child plugins by hand, so the subagent/HPC/worktree plugins added later were
  missing from the package.
- **Decisions**:
  - **Build on the target OS.** Windows is built on Windows; there is no Wine or
    Linux cross-build path. Each platform keeps its native electron-builder
    target.
  - **Windows artifact.** `win.target: nsis`, `arch: x64`, `oneClick: false`,
    `perMachine: false`, so the installer is an ordinary per-user setup that
    does not need Administrator. Signing, auto-update and arm64 are deferred.
  - **Cross-platform scripts, not shell syntax.** `cross-env` supplies the one
    `NEXT_OUTPUT` variable; small Node launchers own the pieces shell syntax
    cannot express (a default `DESKTOP_DEV_URL`, a Linux-only `--no-sandbox`,
    the dsh dev defaults, and `--dsh`). `npm run pack` now works unchanged in
    PowerShell/cmd.
  - **The host build discovers its children.** `build:host` bundles the host and
    then every `packages/transport-dsh/dist/*-plugin.js`, so a new child plugin
    cannot be forgotten again.
  - **Windows shutdown is IPC-first.** Electron's main process sends the forked
    host `{type:"shutdown"}` (the same path the signal handles use), waits, then
    kills the tree with `taskkill /pid <pid> /T /F`. The Next grandchild is
    spawned with `windowsHide` so a console does not flash.
  - **Path and socket rules are platform-aware.** An agent root keeps a Windows
    drive prefix as a forward-slash absolute path (`C:/projects/x`), and the
    bridge skips filesystem cleanup for win32 named pipes.
  - **The desktop tells the child where the service is.** The host sets
    `SCIENCE_STUDIO_SERVICE_URL` to its ephemeral API base, so the HPC/worktree
    tools do not fall back to the dev port 3001 in the packaged app.
- **Considered and rejected**: **Wine/Linux cross-building** — extra toolchain,
  cannot smoke-test the result on the build host; **one-click installer** — less
  control over the install directory and no wizard for a normal desktop app;
  **portable/zip** — no Start-menu or uninstall integration; **arm64** — no
  tested ARM target yet; **code signing and auto-update now** — both need
  release infrastructure and are not needed to make Windows buildable.
- **Consequences**: Windows builds are unsigned, so SmartScreen may require an
  explicit "Run anyway" on first launch. The app still needs `dsh` on `PATH`
  and a model route configured in the workbench dialog. The bridge tests now
  use the platform socket path, but symlink-creation tests and HPC SSH shell
  shims still assume POSIX and need Windows skips/adaptation; HPC multiplexing
  on Windows is a separate follow-up. None of these blocks packaging or the
  desktop's core turn loop.

## Addendum (2026-11-17)

The first Windows package could not start. The esbuild host bundle declared
`createRequire` twice — once in its banner and once from the bundled
`services/transport-service/src/structure.ts` — so `host.mjs` failed to parse.
Even with that fixed, the host was shipped in `resources/host`, where its ESM
externals (`@deepseek-ai/dsh-sdk-client`, `dotenv`) could not resolve: ESM
ignores the `NODE_PATH` the main process sets. The host and its six child
plugins now ship inside `app.asar` (`build/host/...`), so they resolve
`app.asar/node_modules` through normal module resolution; the banner aliases its
`createRequire`, and `build:host` runs `node --check` over every output. A boot
failure now also surfaces as an Electron error dialog, and the host's stderr
tail is included in the error instead of disappearing into a GUI process's
stderr.

Booting the dsh child then exposed two more packaging gaps: sharp's libvips
shared library sat inside `app.asar` (the native loader cannot read it), and the
SDK's `@deepseek-ai/dsh-sdk-protocol` peer was not collected because
electron-builder only walks declared dependencies. `asarUnpack:
node_modules/@img/**` now keeps sharp's native runtime outside the archive, and
`@deepseek-ai/transport-dsh` declares the protocol package so it ships in
`app.asar/node_modules`.

A Windows GUI process receives a PATH snapshot at launch, so a Git installed or
added to the environment after Explorer started is invisible to the packaged
app; a PATH near the environment-block limit can also arrive truncated. The
desktop now reads the persisted User and Machine PATH from the registry, merges
it with the process PATH, resolves `git.exe` (including a `Git\cmd` directory
beside a `Git LFS` PATH entry or `GIT_LFS_PATH`), and pins `GIT_BINARY` in the
host env. A missing Git no longer blocks startup: the worktree list degrades to
`gitAvailable: false` and only its write actions answer 503.
