# The product is renamed Generative Protein System (GPS)

The product formerly named **Science Studio** is now **Generative Protein
System**, abbreviated **GPS**. The rename covers user-facing branding, package
names, runtime identifiers, storage paths, environment variables, and desktop
application identity. It is a hard cut: no previous name or path is kept as an
alias.

- **Status**: accepted
- **Context**: the original name described a generic scientific workbench,
  while the product's domain is generative protein design. The new name states
  the domain and keeps the compact **GPS** abbreviation for identifiers. The
  product has no installed user base yet, so the rename can be applied before a
  compatibility surface is needed.
- **Decisions**:
  - **Brand**: user-facing copy, window titles, documentation, and the desktop
    product name use **Generative Protein System**; compact labels may use
    **GPS**.
  - **npm scope**: every workspace package moves from `@science-studio/*` to
    `@gps/*`; the private root package is `generative-protein-system`.
  - **Runtime identifiers**: `SS_*` environment variables become `GPS_*`,
    `SCIENCE_STUDIO_SERVICE_URL` becomes `GPS_SERVICE_URL`, the package metadata
    key becomes `gps.runtimeModules`, the preload bridge becomes
    `window.gpsDesktop`, and the dsh default session becomes `gps`.
  - **Storage**: service state lives under `$XDG_DATA_HOME/gps/`; project-owned
    metadata lives under `.gps/`; remote HPC work lives under `~/gps/`; the
    desktop's default Projects directory is
    `~/Documents/Generative Protein System/projects`.
  - **Desktop identity**: `productName` is `Generative Protein System`, `appId`
    is `gps.hx-engine.com`, the executable and package/artifact names are `gps`.
  - **No compatibility layer**: the old environment names, paths, localStorage
    keys, `.science-studio/` directories, and desktop user-data location are not
    read or migrated. Existing development data must be moved or recreated by
    hand.
  - **Historical ADRs are not rewritten**: ADRs 0001–0028 keep their original
    text and references to the former name. This ADR is the record of the
    rename.
- **Consequences**: all workspace packages, imports, scripts, tests, docs, and
  desktop packaging use the new name; a stale `@science-studio` import or
  `SS_*` environment variable is a build/runtime error rather than a silent
  fallback. The old on-disk locations may remain on a developer machine but are
  no longer read.
