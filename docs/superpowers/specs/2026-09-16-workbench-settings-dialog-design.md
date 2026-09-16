# Workbench settings dialog — model / model API, plugins, agent (design)

Date: 2026-09-16
Status: draft

## Goal

Add a settings button at the far left of the workbench's bottom status bar. It
opens a configuration dialog whose LEFT side is a vertical tab list and whose
RIGHT side is the selected tab's options:

1. **Model** — the active runtime's model route: `Provider`, `Model`,
   `Endpoint`, plus the route's `API Key`.
2. **Plugins** — reserved; an empty state in v1.
3. **Agent** — reserved; an empty state in v1.

Saving persists the configuration on the SERVICE (not per browser), and it takes
effect after a service restart. The API key is stored write-only: the service
never returns it.

## Motivation

Today the only model/provider configuration surface is the desktop Electron
`Settings` window (`apps/desktop/src/renderer/config.ts`), which writes
`<userData>/config.env` and is reachable only in a packaged app — the browser dev
workbench (`npm run dev`) has no way to configure a route at all, and even in
desktop the workbench cannot edit it. The bottom status bar already reports the
runtime route (`RuntimeChip`) but offers no way to change it. A single in-product
settings surface — same origin as the workbench, working in dev and packaged —
removes the split-brain between `config.env` and the harness route.

## Scope

In scope:

- A seam-level settings contract shared by the service and the client.
- Service: a settings file store + `GET/PUT /api/settings`, layered over the
  launch env at boot (`settings > env > default`).
- `transport-dsh`: apply the model route to the harness home
  (`<dshHome>/settings.yaml`) and inject the credential into the child launch
  env, so Endpoint and API Key actually take effect.
- transport-client: settings fetch/update helpers + response types.
- Web: the status-bar button, the tabbed dialog, the proxy hop.
- Desktop: narrow `config.env` to paths, retire the standalone Settings window,
  make the workbench dialog the sole editor.

Out of scope (deferred, tabs render empty states):

- The `plugins` and `agent` settings themselves: types + persistence are wired,
  but no plugin inventory or agent capability is configured in v1.
- The openclaw runtime: its provisioning is a gateway URL/token, not a
  provider/model route, so the Model tab does not apply to it. It keeps working
  and shows the persisted values read-only alongside a note.
- Hot reload: a saved change requires a service restart.

## Decisions

- **Service owns the settings.** The store is a service file
  (`SS_SETTINGS_PATH`, default `$XDG_DATA_HOME/science-studio/settings.json`;
  desktop `<userData>/settings.json`), mode `0600`, atomic write (temp file +
  rename). The record stays authoritative for Project/Session identity; settings
  are deployment configuration, not record rows.
- **Persisted, not hot-applied.** Settings are read once at boot and folded into
  the launch env before `plugin.localBinding(env)`. Applying live would require
  rebuilding every Project's `Environment`/adapter and risking an in-flight run;
  the product already declares restart-to-apply for desktop, and this keeps the
  single-user composition deterministic.
- **Precedence is `settings > env > built-in default`.** A saved value must win
  even in dev, where the service `dev` script exports `DSH_PROVIDER`/`DSH_MODEL`.
  The fold happens on an environment COPY passed to `localBinding`, so the
  process env (and the child's inherited env) is not mutated globally.
- **The API key is write-only.** `GET` returns `apiKeyConfigured: boolean`
  instead of the value. `PUT` semantics: field ABSENT = keep, `null` = clear,
  non-empty string = replace. The key is never logged.
- **The contract lives in the seam package.** `RuntimeSettings` /
  `RuntimeSettingsView` / `RuntimeSettingsPatch` live in
  `packages/transport` because both the service (which already depends on it)
  and `@science-studio/transport-client` (which depends on it) need one shape;
  a type duplicated across the two would drift silently.
- **dsh route application belongs to `transport-dsh`.** The route file location,
  the `llm-pi-ai.providers` section and the credential-env mechanism are dsh
  version-pinned facts. `packages/transport-dsh` already owns `Dsh*` knowledge
  and pins the harness at `0.1.5-alpha.1`, so the merge code lives there and the
  service never names `settings.yaml`.
- **Route application is best-effort.** Exactly like the existing bridge and
  project patches: a failure (unwritable home, malformed document) logs and
  leaves the runtime working on whatever route is already configured; it never
  fails `init`.

## Components

### `packages/transport/src/settings.ts` (new, seam types)

```ts
export interface ModelSettings {
  provider?: string;
  model?: string;
  endpoint?: string;   // the route's baseURL
  apiKey?: string;     // write-only; never present in a response
}
export interface RuntimeSettings {
  model: ModelSettings;
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
}
/** GET/PUT response: apiKey replaced by a configured flag. */
export interface RuntimeSettingsView {
  model: Omit<ModelSettings, "apiKey"> & { apiKeyConfigured: boolean };
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
  runtime: string;
  settingsPath: string;
}
/** PUT body: merge semantics, not replace. */
export interface RuntimeSettingsPatch {
  model?: Partial<ModelSettings> & { apiKey?: string | null };
  plugins?: Record<string, unknown>;
  agent?: Record<string, unknown>;
}
```

Exported from `./seams` and re-exported by the package root (explicit exports,
no `export *`; pinned by `packages/transport/test/seams.test.ts`).

### `services/transport-service/src/settings.ts` (new)

- `resolveSettingsPath(env)`: `SS_SETTINGS_PATH` else
  `$XDG_DATA_HOME/science-studio/settings.json` (else `~/.local/share/...`).
- `loadSettings(path): Promise<RuntimeSettings>`: absent → `{ model: {}, plugins:
  {}, agent: {} }`; malformed/unreadable → log + same defaults (never throw).
- `saveSettings(path, next)`: `mkdir -p`, write to `<path>.tmp` with mode `0600`,
  `rename`. Reject non-object `plugins`/`agent`.
- `mergeSettings(current, patch): RuntimeSettings`: apply the apiKey
  absent/null/string rule; `plugins`/`agent` shallow-merge when supplied.
- `viewOf(settings, env): RuntimeSettingsView`: `apiKeyConfigured =
  Boolean(settings.model.apiKey)`; `runtime = env.TRANSPORT_RUNTIME ?? "openclaw"`.
- `applySettingsToEnv(env, settings): NodeJS.ProcessEnv`: a copy of `env` where
  the model route wins over the ambient values. Provider/Model are written to
  `DSH_PROVIDER`/`DSH_MODEL` (the names `dshLocalBinding` already copies);
  Endpoint/API-Key are written to the service-owned names `SS_MODEL_ENDPOINT` /
  `SS_MODEL_API_KEY` (the dsh package reads those into its binding; openclaw
  ignores them). The input `env` object is not mutated.

### `services/transport-service/src/server.ts` (extend)

- `GET /api/settings` → `viewOf(await loadSettings(path), env)`.
- `PUT /api/settings` → validate, `mergeSettings`, `saveSettings`, return the new
  view. No project scoping (deployment-global).
- The settings path and loaded settings are resolved once at server build (a
  small holder the routes close over), so a request never re-reads per call.

### `services/transport-service/src/composition.ts` (extend)

- `localBackend`: after resolving the plugin, `const settings = await
  loadSettings(resolveSettingsPath(env))`, then `const runtimeEnv =
  applySettingsToEnv(env, settings)` and pass `runtimeEnv` to
  `plugin.localBinding(runtimeEnv)` (instead of raw `env`). The `env` handed to
  `adapter.init` stays `{ ...runtimeEnv }`.

### `packages/transport-dsh/src/binding.ts` (extend)

- `DshBinding` gains `endpoint?: string` and `apiKey?: string` (the latter is a
  raw secret held only for this launch; never persisted by this package).
- `dshLocalBinding` copies them from service-owned env names
  (`SS_MODEL_ENDPOINT`, `SS_MODEL_API_KEY`) so the service maps values into the
  binding without the dsh package naming any service module.

### `packages/transport-dsh/src/route-settings.ts` (new)

- `applyRouteSettings({ home, provider, endpoint, apiKey }): Promise<{ env:
  Record<string, string> } | null>`:
  - no endpoint and no apiKey → `null` (nothing to do);
  - read `<home>/settings.yaml` (fall back to `settings.json`); parse YAML;
  - locate `llm-pi-ai.providers[<provider>]`; when absent and an endpoint is
    given, create a minimal route `{ api: "openai-completions", baseURL,
    models: [{ id: model }] }`;
  - set `baseURL` when an endpoint is given;
  - resolve the credential env name: keep an existing `apiKeyEnv`, else derive
    `<PROVIDER>_API_KEY` (uppercase, non-alphanumeric → `_`); set it on the
    route;
  - write back with a comment-preserving YAML `Document` patch
    (`setIn` per changed leaf) via temp file + rename;
  - return `{ env: { [credentialEnvName]: apiKey } }` when an apiKey is given.

### `packages/transport-dsh/src/adapter.ts` (extend)

- In `init`, after `provider`/`model` are resolved and before the client is
  created: call `applyRouteSettings` when `binding.endpoint`/`binding.apiKey` are
  set, wrap in try/catch (log, continue), and merge its `env` into the client
  launch options.

### `packages/transport-dsh/src/client.ts` (extend)

- `DshClientLaunchOptions` gains `env?: NodeJS.ProcessEnv`; the constructor
  forwards it to `DeepSeekHarness` (the SDK's launch already accepts `env`).

### `packages/transport-client/src/settings.ts` (new)

- `fetchSettings(api): Promise<RuntimeSettingsView>` → `GET ${api}/settings`.
- `updateSettings(api, patch): Promise<RuntimeSettingsView>` → `PUT` JSON.
- `index.ts` exports the helpers and re-exports the seam types.

### `apps/web/app/api/settings/route.ts` (new)

- `GET`/`PUT` → `proxyToService(request, { path: "/api/settings", method, body })`
  (one policy hop; forwards `Authorization`; relays status/body verbatim).

### `apps/web/store/studio-store.ts` (extend)

- `settingsOpen: boolean` + `openSettings()` / `closeSettings()` (chrome state,
  like `leftView`; NOT in the `SessionView` key, so opening the dialog never
  remounts the runtime owner).

### `apps/web/components/studio/settings-dialog.tsx` (new)

- `Dialog` + `DialogContent className="sm:max-w-3xl"`, two-pane: a vertical
  `Tabs` list (`模型` / `插件` / `Agent`) and the active panel.
- Model panel: a `模型` section (`Provider`, `Model`, `Endpoint` inputs) and a
  `模型 API` section (an API-key input that shows `apiKeyConfigured`; typing
  replaces, a `Clear` action sends `null`). `Save` → `updateSettings`; on success
  show `已保存，重启服务后生效` and, when `window.scienceStudioDesktop?.restartHost`
  exists, a `Restart service` action.
- Plugins / Agent panels: an empty-state note ("即将支持").
- On open: `fetchSettings`; a fetch failure shows the error inline, not a throw.

### `apps/web/components/studio/status-bar.tsx` (extend)

- Render a `Settings` (gear) `Button` at the far left of the footer, before
  `WorkspaceChip`; `onClick` → `openSettings()`. Mount `SettingsDialog` (reads
  `settingsOpen`).

### Desktop (`apps/desktop`) — narrowing `config.env`

- `shared/config.ts`: `DesktopConfig` drops `provider`/`model` (keeping only the
  generic `vars` that carry non-route env, if any); `buildChildEnv` drops the
  `DSH_PROVIDER`/`DSH_MODEL` lines and adds `SS_SETTINGS_PATH =
  <userData>/settings.json`.
- Remove the config window: `createConfigWindow`, `renderer/config.{ts,html}`,
  the `desktop:getConfig`/`desktop:setConfig` IPC, and the first-run branch that
  opened it. The app always opens the workbench.
- `preload/workbench.cts`: add `restartHost` (already an IPC handler) so the
  dialog can offer restart.
- Menu `Settings…`: open/focus the workbench (the dialog is one gear-click away)
  rather than a separate window.
- `status-bar.tsx` `RuntimeChip`: read the route from `fetchSettings` instead of
  `runtimeStatus`; keep the dsh-path portion from IPC when present.

## Data flow

```
SettingsDialog ──PUT /api/settings──▶ web proxy ──▶ transport-service
                                                       │ settings.ts (0600 file)
                                                       ▼
                       restart ──▶ composition loads settings
                                       │ applySettingsToEnv(env, settings)
                                       ▼
                         plugin.localBinding(runtimeEnv) ──▶ DshBinding
                                       │
                    adapter.init ──▶ route-settings.ts ──▶ <dshHome>/settings.yaml
                                       │                     (baseURL + apiKeyEnv)
                                       └──▶ child launch env: { apiKeyEnv: <key> }
```

## Error handling

- Absent/malformed settings file → defaults, one warning; the service still
  boots and every route works.
- `PUT` with a non-object `plugins`/`agent` or a non-http(s) non-empty
  `endpoint` → `400` naming the field; no partial write.
- Scope-less `GET` when the runtime is openclaw → the view still returns the
  persisted model fields with `runtime: "openclaw"`; the dialog notes the Model
  tab does not apply to that runtime.
- `applyRouteSettings` failure → warning, init continues; the route is simply
  not changed.
- Web proxy → relays the upstream status/body verbatim (existing policy), so a
  `400` from validation is what the dialog displays.

## Security

- The settings file is `0600`; the key is never logged, never returned by `GET`
  and never included in an error message.
- The dialog holds the key only in a transient input's local state and clears it
  after a successful save.
- The API key field is `type="password"` with `autoComplete="off"`.

## Testing

- `services/transport-service/test/settings.test.ts`: load defaults on absent /
  malformed; save → mode `0600` and round-trip; apiKey absent/null/string merge;
  `viewOf` never contains the key; `applySettingsToEnv` precedence over ambient
  env and no mutation of the input.
- `services/transport-service/test/settings-routes.test.ts`: `GET` shape and
  redaction; `PUT` merge + `400` on bad input; body round-trip.
- `packages/transport-dsh/test/route-settings.test.ts`: comment-preserving merge
  into an existing route (fixture with comments); route creation when absent;
  credential-name reuse vs derivation; no-op when endpoint and key are absent.
- `packages/transport-dsh/test/adapter.test.ts`: a binding with endpoint/apiKey
  passes the credential env into the launch client; a failing route write does
  not fail init.
- `packages/transport-client/test/settings.test.ts`: fetch/update URL, method,
  body, and view parsing.
- `packages/transport/test/seams.test.ts`: the new settings types are exported.
- `apps/web` e2e (`test/settings-dialog.test.mjs`): gear → dialog → tab switch →
  save under a mocked `/api/settings`; the runtime-owner re-render invariant is
  unaffected (opening the dialog does not remount `SessionView`).
- `npm run build` — the real type gate (`typecheck:tests` included).

## Risks

- **Writing the user's harness settings.** `applyRouteSettings` edits
  `<dshHome>/settings.yaml`, a file the user may hand-maintain. The merge is
  confined to the selected provider route's `baseURL`/`apiKeyEnv` and preserves
  every other node/comment; a malformed document aborts the write and logs.
- **dsh version pinning.** `llm-pi-ai.providers.<route>` is a harness-release
  fact. The pinned `0.1.5-alpha.1` is what the fixture reflects; a harness bump
  must revisit `route-settings.ts`.
- **Restart-to-apply UX.** In dev the user must restart `npm run dev`; the dialog
  says so and (desktop) offers a restart action. A future iteration could
  hot-apply by rebuilding Environments.
- **`apiKeyConfigured` is persisted-only.** A key supplied via env (e.g.
  `OLLAMA_LOCAL_API_KEY` in `.env`) is not reflected, because the service cannot
  resolve a route's `apiKeyEnv` name without the harness. The dialog shows the
  persisted truth; this is a cosmetic gap.

## Phasing

One spec, delivered in three phases so each is independently shippable:

1. **Settings surface + provider/model apply** — seam types, service store/API,
   proxy, dialog (with Model fields; Endpoint/API Key persisted), composition
   precedence, provider/model take effect on restart.
2. **dsh route apply** — `route-settings.ts`, binding fields, launch env, so
   Endpoint/API Key actually reach the harness.
3. **Desktop unification** — `config.env` narrowed, Settings window retired,
   RuntimeChip reads the service, dialog gains the restart action.
