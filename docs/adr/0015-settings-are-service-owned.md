# Deployment settings are service-owned, not record rows

The workbench now needs an in-product surface for the model route
(provider/model/endpoint plus its API key) that works in both `npm run dev` and
the packaged desktop app. Before this, the only editor was the desktop
`Settings` window writing `<userData>/config.env` (ADR-0013), which the browser
dev workbench could not reach and which the workbench itself could not edit —
the same route was configured in two places with no shared truth.

We add a **deployment settings** layer, distinct from the record layer.

**Settings are deployment configuration, not record rows.** The record remains
authoritative for `Project`/`Session`/`Run` identity (ADR-0002, ADR-0007);
settings describe the host's runtime provision and are never scoped to a
Project or a tenant user. The service owns them, so every browser and both
server entrypoints read one value.

**The service keeps one settings file.** `SS_SETTINGS_PATH` names it
(`<userData>/settings.json` on desktop, else
`$XDG_DATA_HOME/science-studio/settings.json`). It is written `0600` with a
unique temp file plus `rename` (atomic), and read once at boot. A malformed or
absent file logs once and yields empty settings, so the service still boots and
every route works.

**The API key is write-only over HTTP.** `GET /api/settings` returns
`apiKeyConfigured: boolean` instead of the value; `PUT` semantics are field
ABSENT = keep, `null` = clear, non-empty string = replace. The key is never
logged and never serialized into an error. It is stored plaintext (a
single-user install has no secret store), which is why the file is `0600` and
why the section below gates writes.

**Precedence is `settings > env > built-in default`.** At boot the service loads
the file, folds it over a COPY of the launch env (`applySettingsToEnv`), and
builds the runtime binding from that copy. A saved value therefore wins even in
dev, where the `dev` script exports `DSH_PROVIDER`/`DSH_MODEL`. An empty-string
`provider`/`model`/`endpoint` means "unset" (it is deleted from the file, not
persisted as `""`), so a clear reaches the env layer instead of silently losing
to an ambient value at a truthiness check. `apiKey: ""` stays a real value;
only `null` clears it.

**Applying is restart-to-apply.** Settings are read once at boot and folded into
the launch env before `plugin.localBinding(env)`. Hot-applying would require
rebuilding every Project's `Environment`/adapter and risk an in-flight run; the
desktop already declares restart-to-apply, and this keeps the single-user
composition deterministic. The dialog says so and, under desktop, offers a
restart action.

**The workbench dialog is the one editor.** A gear at the far left of the status
bar opens a tabbed dialog (Model / Plugins / Agent). Model edits
provider/model/endpoint and the API key; Plugins and Agent are reserved empty
states in v1. The web app reaches the routes through the same single
`service-proxy` hop as every other `/api` call, so the caller's `Authorization`
is forwarded and the upstream status/body relayed verbatim.

**`transport-dsh` applies the route to the harness.** The provider ROUTE
(`llm-pi-ai.providers.<id>`) carries the `baseURL` and the NAME of its
credential env (`apiKeyEnv`) in `<dshHome>/settings.yaml`; there is no launch-env
override for the base URL. `transport-dsh` owns the version-pinned merge: a
comment-preserving YAML leaf patch that keeps an existing `apiKeyEnv`, derives
`<PROVIDER>_API_KEY` only when a key is actually supplied, and returns the child
launch env for the credential. A failure logs and leaves the configured route in
place — route application never fails `init`. The plaintext key travels to the
adapter through `DshBinding`, not through the generic adapter env.

**Desktop `config.env` is narrowed to paths.** The standalone Settings window is
retired; `config.env` carries only path/extra vars, and `buildChildEnv` sets
`SS_SETTINGS_PATH` so the service owns the route. The workbench dialog is the
sole editor in both dev and packaged builds.

**Hosted writes require a manager.** `PUT /api/settings` is rejected with `403`
unless the request's `Principal` is `local` or has the `manager` role, so a
hosted researcher cannot overwrite the shared route. `GET` stays available to
any authenticated principal (it contains no secret). `LocalPrincipalResolver`
sets `local: true`, so single-user installs are unaffected.

- **Status**: accepted
- **Considered options**:
  - *Store settings as record rows* — rejected: they are deployment/host facts,
    not per-Project research state, and the record's authority is
    Project/Session/Run (ADR-0007).
  - *Keep `config.env` as the route editor and add only a browser UI* — rejected:
    the desktop window would still be a second editor of the same route, and the
    browser dev pair needs the override to take effect too.
  - *Hot-apply on save* — deferred: it would tear down live
    `Environment`/adapter state and risk a running turn; restart is honest and
    already the desktop story.
  - *Return the key masked instead of a flag* — rejected: write-only is the
    simplest contract that makes leaking it impossible by construction.
- **Consequences**: `packages/transport` gains the type-only settings contract
  (`ModelSettings`/`RuntimeSettings`/`RuntimeSettingsView`/`RuntimeSettingsPatch`);
  `transport-service` gains the settings store and the two HTTP routes;
  `transport-client` gains `fetchSettings`/`updateSettings`; the web app gains
  the proxy hop and the dialog; `transport-dsh` gains `route-settings.ts` and
  `DshBinding.endpoint`/`apiKey`; the desktop app loses its Settings window and
  narrows `config.env`. A saved change takes effect after a service restart. The
  `apiKeyConfigured` flag reflects only the persisted key, not one supplied via
  an env var, because the service cannot resolve a route's `apiKeyEnv` name
  without the harness — a known cosmetic gap.
