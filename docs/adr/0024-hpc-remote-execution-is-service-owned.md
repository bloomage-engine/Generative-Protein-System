# HPC remote execution is service-owned and a Compute Job is a record entity

Science Studio submits **Compute Jobs** to configured **HPC Endpoints** (Slurm
clusters or plain Linux machines) over SSH. The transport-service is the only
process that talks to the remote system: the dsh child plugin registers `hpc_*`
tools that merely fetch the service — the `computeInteraction` pattern — because
the durable Jobs panel needs a server-side reconciler anyway, and a child is
per-Project, lazily spawned and killed on restart (docs/adr/0008), so it cannot
hold connection state the product depends on.

- **Status**: accepted
- **Context**: the product wants agents to run long compute on external HPC
  systems and a panel to watch those jobs. *Considered and rejected*: the child
  plugin SSHing itself (credentials and connection state would exist in two
  places — the child and the service's poller — and die with every child
  restart). *Considered and rejected*: no integration at all — just a skill
  teaching the agent to `ssh host sbatch …`; cheapest, but it yields no durable
  job history, no panel, and no place to put per-Project defaults.
  *Considered and rejected*: an `ssh2`-style npm library — it re-implements keys,
  agents, and config poorly against what HPC sites actually run.
- **Decisions**:
  - **The service owns SSH, via the system OpenSSH binaries.** It spawns
    `ssh`/`scp`/`sftp` (with `ControlMaster` connection reuse) rather than
    embedding an SSH client in Node, so real keys, `ssh-agent`, and
    `~/.ssh/config` work as the Researcher's ops team expects. The credential is
    a key-file PATH; passphrases ride the agent. Host keys use
    `StrictHostKeyChecking=accept-new` in v1 (TOFU pinning deferred).
  - **Two Scheduler Kinds only: `slurm` and `linux`.** A `slurm` Endpoint submits
    with `sbatch` and reconciles from `squeue`/`sacct`; a `linux` Endpoint runs
    the job as a tracked remote background process (pid, exit marker, log files).
    LSF/PBS/k8s are explicitly out of v1; `kind` is the extension point.
  - **Connection config is deployment settings; use is Project state.** Endpoint
    definitions (id, name, kind, host, user, key path, defaults) live in the
    service settings file under a new `hpc` section — HPC tab of the workbench
    dialog, manager-gated PUT per docs/adr/0015. A Project **binds** one endpoint
    through a file in its own Project Workspace (docs/adr/0020's split: secrets
    are deployment-scoped, project state is not a settings blob), which also
    carries the per-Project Remote Work Dir and default partition.
  - **Files move only by explicit Staging.** No auto-mirror: a Compute Job reads
    and writes the project's Remote Work Dir (`~/science-studio/<projectId>/` by
    convention), never the Project Workspace; upload/download are tools, and
    large datasets are assumed to already live on the cluster.
  - **The job ledger is a record entity; the scheduler stays live authority.**
    A `ComputeJob` row is written on submit (id, projectId, endpointId, remote
    job id, submitting session, script/command snapshot, resources, state,
    timestamps) following the Subagent precedent (docs/adr/0016, 0019), and a
    service-owned poller reconciles live state into it (it must copy the cron
    scheduler's shape: decorated, `isMain`-started, re-reads state). This is the
    deliberate exception to docs/adr/0017's "no record entity for non-Run
    concepts": the panel must show finished jobs after `squeue` purges them and
    after a service restart, and the Remote Work Dir is not the ledger's home
    because a `linux` job's truth is a process, not a file.
  - **The Jobs surface is runtime-agnostic; the agent tools are dsh-only.**
    `/api/hpc/*` reads the record and the endpoint config — any runtime's panel
    works; only dsh gets the `hpc_*` child plugin for now, and openclaw parity is
    deferred rather than blocking.
  - **The child plugin is the tool surface only, and never a writer of the
    Binding.** A fifth per-launch patch ships `hpc-plugin.ts`: five discrete
    tools (`hpc_submit`, `hpc_jobs`, `hpc_cancel`, `hpc_logs`, `hpc_files` —
    upload and download as one tool) plus one `systemPrompt` section, all of
    which just fetch the service. There is no `/hpc` slash command (the command
    bridge is child-side; the truth is service-side). Binding a Project to an
    endpoint is a human decision the UI writes (through the Workspace seam);
    the agent may read it but never change it.
  - **The ledger is the read model; only the poller talks SSH for state.**
    The panel and `hpc_jobs` read `ComputeJob` rows — a GET never queries the
    cluster, because a 5 s client poll × live SSH would hammer the connection.
    `HpcJobPoller` (the cron scheduler's shape: decorated, `isMain`-started,
    `tick()` drivable) refreshes non-terminal rows every 15 s — `squeue` batched
    by our own job ids, one `sacct` pass when a job turns terminal; `linux`
    liveness is a pid probe plus an exit-marker file. It tracks only jobs this
    product submitted, idles to zero SSH when nothing is open, and a per-Project
    Refresh button forces one `tick()`. States: `submitted/pending/running`
    non-terminal, `completed/failed/cancelled` terminal, `unknown` keeps the
    last known value.
  - **A ledger row exists only after the remote prints a job id; a runaway
    guard caps submission.** A submit whose output cannot be parsed returns
    "job may be queued — check before retrying" and writes no row. The guard is
    an optional per-endpoint `maxConcurrentJobs` (default unlimited — the
    single-user posture; a shared deployment should set it) plus prompt rules
    (check `hpc_jobs` before submitting; never duplicate-submit). No approval
    gate and no cost cap: dsh has no approvals capability and billing does not
    exist yet.
  - **Deleting a Project cascades its ComputeJob rows and never touches the
    cluster.** The panel lists every job of the Project (no recent-window —
    cluster jobs are low-frequency), and the delete dialog must warn that
    running jobs keep running: the cluster is outside the product's authority
    (mirrors docs/adr/0014's boundary).
- **Consequences**: the service host needs OpenSSH binaries on PATH (the Desktop
  App does; a slim container must install them). `ControlMaster` sockets are
  process-local, so a hosted multi-replica deployment must re-home the SSH layer
  behind one owning instance before scale-out. Credentials are per-deployment,
  not per-Principal: in hosted mode every Project member submits as the endpoint
  user — per-user HPC credentials are a known gap, deliberately unmade.
