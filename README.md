# Generative Protein System

> 中文: [README.zh.md](./README.zh.md)

## Overview

Generative Protein System is an agentic research workbench for protein design. It brings structure and sequence analysis, scientific tools, remote computation, and research records into a shared project environment. Researchers can conduct analyses through conversation, inspect evidence in structure and sequence views, and retain files and analytical histories for subsequent work.

It supports browser access and desktop clients for Windows, macOS, and Linux.

## Installation and quick start

### Web deployment

You need Node.js 22.12+, npm, Git, and a `dsh` CLI compatible with the pinned
`@deepseek-ai/dsh-sdk-client` (`0.1.5-alpha.1`). The model route is declared
harness-side in `~/.dsh/settings.yaml`.

Install dependencies and build the workspace packages and service:

```bash
npm install
npm run build
```

For development the root build is enough: `next dev` compiles the web app on
demand.

Create `services/transport-service/.env` from the
[configuration example](./services/transport-service/.env.example):

```dotenv
TRANSPORT_RUNTIME=dsh
PROJECT_ROOT=/absolute/path/to/projects
# Credential for the route you configure:
# OLLAMA_LOCAL_API_KEY=ollama
# DEEPSEEK_API_KEY=<your-deepseek-api-key>
```

- `PROJECT_ROOT` is the parent of every Project workspace; the default Project
  lives at `<PROJECT_ROOT>/project-default`. On Windows use
  `D:/GPS/projects` and quote paths with spaces. In WSL use
  `/mnt/d/GPS/projects`.
- The service does not hardcode a model provider. It uses the workbench
  Settings → Model, then `agent-default-model` in `~/.dsh/settings.yaml`, then
  the only configured `llm-pi-ai` route. If none is present it falls back to
  the built-in `deepseek-official`/`deepseek-v4-flash` route, which needs
  `DEEPSEEK_API_KEY`.
- For a local Ollama route, add both the default selection and the pi-ai route
  to `~/.dsh/settings.yaml` (see below). Any non-empty
  `OLLAMA_LOCAL_API_KEY` works for Ollama; the harness only requires it to be
  set.
- For DeepSeek instead, put `DEEPSEEK_API_KEY` in `.env` and start with
  `DSH_PROVIDER=deepseek-official DSH_MODEL=deepseek-v4-flash`.
- `OPENCLAW_*` variables are legacy and are not used by the dsh setup.
- `DSH_*` variables must be set in the launch environment, never in `.env`:
  the harness child reads `.env` from its cwd and refuses those names.

The provider route itself lives in `~/.dsh/settings.yaml`, for example:

```yaml
agent-default-model:
  provider: ollama-local
  model: qwen3.8:latest

llm-pi-ai:
  providers:
    ollama-local:
      api: openai-completions
      baseURL: http://localhost:11434/v1
      models: [{ id: qwen3.8:latest }]
      apiKeyEnv: OLLAMA_LOCAL_API_KEY
```

Start the service and web app:

```bash
npm run dev
```

`npm run dev:dsh` also works and additionally forces the dsh runtime. Open
[http://localhost:3000](http://localhost:3000), create a project and a session,
and start working.

For a production web build, build `apps/web` separately; the root
`npm run build` only builds the workspace packages and service:

```bash
npm run build -w @gps/web
npm start -w @gps/web
```

Natural-language structure analysis also requires the
[MolQL tool plugin](./packages/plugins/molql-tool-dsh/README.md). Configure
external scientific services and remote computation in the workbench's MCP and
HPC settings, respectively.

### Desktop client

The desktop client starts and manages its local services automatically; no separate Web service is required. The `dsh` executable must be available on PATH, and Git must be installed to use worktrees.

After installing dependencies and building as above, build and launch the client from source:

```bash
npm run start -w @gps/desktop
```

Configure the model provider in the workbench settings. Projects are stored under `Documents/Generative Protein System/projects` in your home directory by default.

To create an installer, run this command on the target operating system:

```bash
npm run pack -w @gps/desktop
```

Supported formats are Windows x64 NSIS, macOS DMG, and Linux AppImage and DEB.

## Features

### Research dashboard

The workbench brings agent conversations, file viewing, and research activities into one interface. Central tabs display molecular structures, sequence alignments, and analysis files, while the side panel provides access to project files, subagents, scheduled tasks, and Compute Jobs. Researchers can inspect data, track execution progress, and review results alongside the conversation.

![Research dashboard with conversation, sequence alignment, and activity panels](./images/fig-dashboard.png)

*Figure 1. Research dashboard with the agent conversation on the left, a sequence alignment in the centre, and project files and research activities on the right.*

### Projects and research records

Each project brings together data, scripts, analytical outputs, and sessions. Worktrees separate alternative analyses into independent checkouts; sessions in the same worktree use a common working directory.

Sessions preserve messages and tool calls, subagent records retain delegated activities and results, and remote Compute Jobs are stored at the project level. The agent can also maintain a `PROJECT.md` brief with research objectives, progress, findings, and open questions to support continuity across sessions.

### Structure and sequence analysis

The integrated Mol* structure viewer supports natural-language selection, highlighting, and focusing. For example, ask the agent to show residues within 4 Å of a ligand or analyse non-covalent interactions involving a selected region.

![Natural-language requests and the MolQL structure analysis workflow](./images/figure-molql.png)

*Figure 2. MolQL interaction workflow: the agent translates natural-language requests into selection expressions for structure visualisation and geometric measurements.*

You can also select residues or atoms directly in the 3D view, insert their references into the conversation, and request distance, angle, or dihedral measurements. Results appear in both the conversation and the structure view.

![Selecting residues in the structure viewer and measuring their distance](./images/fig-molql.png)

*Figure 3. Interactive distance measurement: residues selected in the structure viewer are referenced in a request, with the result shown in both the conversation and the 3D view.*

The multiple-sequence-alignment viewer supports formats including Clustal, Stockholm, FASTA, and A3M. It displays conservation and gap patterns and lets you reference sequence positions in the conversation for analysis alongside structural evidence. These statistics describe sequence variation in the alignment and do not directly predict mutation tolerance.

### Skills and MCP

Skills provide reusable procedural guidance for tasks such as input preparation, tool use, and result checking. Global Skills can be shared across projects, while project Skills retain conventions for a particular investigation.

![Retrieving the SMILES representation of UDP-glucose with a PubChem search Skill](./images/fig-skill.png)

*Figure 4. Skill example: the agent follows PubChem search guidance to retrieve the SMILES representation of UDP-glucose and save the results.*

MCP connects external tools and data services, such as literature search, database queries, and prediction services. Available capabilities depend on the configured servers. Both Skills and MCP can be managed through the workbench settings.

![Retrieving glycosyltransferase literature through an MCP service](./images/fig-mcp.png)

*Figure 5. MCP example: the agent calls a literature search service to retrieve publications related to glycosyltransferases.*

### Remote computation

Generative Protein System connects to Slurm clusters and remote Linux hosts. The agent can submit scripts or commands, inspect execution status and logs, request cancellation, and transfer input and output files as needed. Scientific software must be prepared on the remote system.

Each submission creates a persistent Compute Job record containing the submitted computation, remote identifier, and execution state. Researchers can inspect jobs in the workbench after the initiating session has ended.

![Remote Boltz structure prediction with job records, logs, and results](./images/fig2d.png)

*Figure 6. Remote computation example: a Boltz structure prediction with its Compute Job record, execution logs, and retrieved output files.*

## License

Generative Protein System is licensed under the [Apache License 2.0](./LICENSE). Third-party dependencies retain their respective licenses.
