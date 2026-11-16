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
