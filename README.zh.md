# Science Studio

> English: [README.md](./README.md)

面向计算生命科学研发的研究型智能体平台。研究人员与管理者运行、观察由智能体
驱动的工作，并保留完整的可追溯性：智能体的每一次动作都落为一条可复现、可归因
的研究记录。

Science Studio 拥有**研究记录** —— v1 为 `Project` → `Session` → `Run`：一个 Project
拥有一个共享工作区与任意多个 Session，每个研究回合是一条 `Run`
（`Study`/`Task`/`Artifact`/`Evidence`/`Conclusion` 为 deferred，见 CONTEXT.md）。
智能体运行时是可替换的适配器，统一挂在同一个 transport seam 之后。前端只使用
assistant-ui 的 assistant-transport 协议，因此替换运行时永远不需要改动 UI。

## 现状

仍处于早期框架阶段，但核心对话链路已经端到端可用：

- **实时 assistant-ui Thread**（`apps/web`，:3000）↔ **transport-service**
  （:3001）↔ 某个运行时（**openclaw** 网关或本地 **dsh** harness）。采用 SSE
  流式传输，状态操作只使用客户端安全的 `set` / `append-text`。Thread 即来自
  assistant-ui registry 的组件（Tailwind v4 + shadcn/ui）。
- **打开页面即加载历史** —— 前端在挂载时发起一次探测请求，服务端会把每个客户端
  与其权威转写对齐（reconcile），因此首次打开与刷新后都能渲染出历史消息。
- **常驻监听（standing watch）** —— 远程回合（例如来自 openclaw UI 的消息）与
  运行时原生命令回复（`/status`）会写入转写并无需刷新即可渲染；它是一条长连接
  的 watch 通道，与挂载探测共享同一把「受保护的导入」互锁。
- **两个运行时、同一道 seam**（`transport-openclaw`、`transport-dsh`），由服务的
  组合根**动态加载**：默认模块清单是服务 `package.json` 里的数据，
  `SS_RUNTIME_MODULES` 可整体覆盖，因此新增运行时无需改动任何核心代码。私有
  企业模块（`SS_ENTERPRISE_MODULE`）可换成多用户后端。
- **运行时斜杠命令** —— 输入框的「/」菜单由适配器的命令目录构建
  （`GET /api/transport/commands`）；执行命令只是追加一条普通用户消息，绝不会
  被记录为一次 `Run`。
- **按 Project 的工作区文件面板** —— 浏览 / 预览 / 下载以及原始上传，并带有目录
  逃逸、符号链接与大小等约束；一个 Project 一个工作区，由其所有 Session 共享。
  可选开启：未配置 `PROJECT_ROOT` 的部署会禁用该入口，而不是打开一个只显示 503
  的面板。
- **Project → Session → Run 记录** —— Project 拥有其 Session 并共享它们产出的
  东西；每个研究回合持久化为一条 `Run`（默认写入零依赖的 JSONL 存储），并在
  Project 层面汇总。

各实现包与两个示例都有测试套件（`npm test`）；web 应用另有一个浏览器回归测试，
守住「运行时组件不得重渲染」这一不变量（`npm run test:e2e -w @science-studio/web`）。

## 仓库结构

```
science-studio/
├── apps/
│   └── web/                          Next.js 15 前端（assistant-ui Thread + Files 面板，:3000）
├── packages/
│   ├── record/                       记录 seam：Project/Session/Run + RecordStore（内存 & JSONL）
│   ├── transport/                    SEAM 包，两个入口：./seams（契约）+ .（套件 + 单用户默认实现）
│   ├── workspace/                    Workspace 实现（FsWorkspace 及其约束）
│   ├── contract-tests/               所有实现共享的 seam 一致性测试套件
│   ├── transport-client/             assistant-ui 客户端边界（useTransport、工作区、命令目录）
│   ├── transport-openclaw/           openclaw 运行时适配器（自带启动面）
│   └── transport-dsh/                dsh 运行时适配器（本地 harness 子进程）
├── services/
│   └── transport-service/            后端 assistant-transport 服务（Fastify，:3001）
├── examples/                         各适配器的最小示例应用（Vite，仅开发用）
├── scripts/                          开发用冒烟工具
├── docs/                             架构 + ADR + 设计文档（中英）
├── CONTEXT.md                        领域术语表（权威词表）
└── AGENTS.md                         仓库与传输协议的运维说明
```

## 命令

```bash
npm install            # 安装所有 workspace
npm run build          # 构建 record → transport → workspace → contract-tests → transport-client
                       #   → transport-openclaw → transport-dsh → transport-service（真正的类型门禁）
npm run dev            # 同时启动 transport-service（:3001）与 web（:3000）
npm run dev:dsh        # 同上，但强制服务跑在 dsh 运行时
npm run dev:service    # 仅启动 transport-service
npm run dev:web        # 仅启动 web
npm test               # 运行每个 workspace 的测试
npm run test:e2e -w @science-studio/web   # 浏览器回归（自动探测 Chromium；找不到则跳过）
npm run smoke:adapter  # 对真实 openclaw 网关驱动一次 chat.send（需先 build 且有 .env）
npm run smoke:dsh      # 驱动 dsh harness（需先 build，且 examples/transport-dsh-example/.env
                       #   中有该路由的凭据；换路由时导出 DSH_PROVIDER/DSH_MODEL）
npm run smoke:replay -- <frames-file>     # 用客户端解码器折叠录制的 SSE 帧
npm run dev:desktop                        # Electron 连接已运行的 dev 服务
npm run pack -w @science-studio/desktop    # dmg / AppImage+deb / 每用户 x64 NSIS（在目标系统上构建）
```

> `npm run typecheck` 在 transport-service 中是**已知损坏**的（历史遗留的
> TS6310：composite refs + `--noEmit`）；其余 workspace 均可通过。服务请使用
> `npm run build` 作为门禁。

## 快速开始

```bash
npm install
npm run build
npm run dev
```

打开 http://localhost:3000。web 应用从 `/api/transport` 取流，该端点由一个
流式 Route Handler 提供（`app/api/transport/route.ts`），把 transport-service
的响应体原样透传，从而保持同源、并让 SSE 的 token 流不被缓冲。各运行时的准备：

- **openclaw**：需要一个可访问的网关，在 `services/transport-service/.env`
  中配置 `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN`（见其 `.env.example`），
  并确保 LLM provider 可用——否则运行会停在 `starting_model`。
- **dsh**：适配器自己 spawn 的本地 harness 子进程（`dsh --profile sdk`），在
  `services/transport-service/.env` 里用 `TRANSPORT_RUNTIME=dsh` 选中。它的
  **启动环境** —— `DSH_PROVIDER`/`DSH_MODEL`（harness 路由）、`DSH_WORKSPACE`
  （agent 的工作目录）、`DSH_HOME`、`DSH_PROFILE`、`DSH_DEFAULT_SESSION`、
  `DSH_TRANSCRIPT_DIR` —— **不能**写在该 `.env` 里：harness 子进程会把启动者
  cwd 下的 `.env` 当作自己的 project 层读取，而 dsh CLI 硬拒绝其中任何 `DSH_*`
  键。服务的 `dev` 脚本改为导出这些变量（默认：路由 `ollama-local`/
  `qwen3.8:latest`、工作目录 `$HOME/workspace/dsh-workspace`、会话
  `science-studio`；已导出的 `DSH_*` 优先），因此**任何 dev 启动**（包括根
  `npm run dev`）都落在预期配置上，而 `npm run dev:dsh` 只是额外强制运行时开关。
  不设置这些变量会退化为 `deepseek-official`/`deepseek-v4-flash`，且 agent 的
  cwd 变成启动者 cwd（即该包的源码目录）。路由本身（endpoint、模型、凭据名）
  由 harness 侧配置在 `~/.dsh/settings.yaml`，而该路由的 `apiKeyEnv` 名字必须
  在 `.env` 里取非空值（如 `OLLAMA_LOCAL_API_KEY`）——与 `DSH_*` 不同，凭据行
  写在该文件里是合法的，并会被子进程继承。完整环境面见
  `examples/transport-dsh-example`。

工作区文件访问是可选开启的：设置 `PROJECT_ROOT`（所有项目目录的宿主父目录；可再加
`PROJECT_AGENT_ROOT`、`WORKSPACE_MAX_INLINE_BYTES`、`WORKSPACE_MAX_UPLOAD_BYTES`、
`WORKSPACE_QUOTA_BYTES`）即可启用 Files 面板。每个 Project 的工作区是
`<PROJECT_ROOT>/<projectId>/`，由其所有 Session 共享。

记录层默认持久化：服务写入 `$XDG_DATA_HOME/science-studio/record.jsonl`（用
`RECORD_STORE_PATH` 覆盖；`RECORD_STORE=memory` 可关闭）。

不借助浏览器验证服务：

```bash
curl -sN -X POST http://localhost:3001/api/transport \
  -H 'content-type: application/json' \
  -d '{"commands":[],"state":{"status":"idle","messages":{}},"threadId":null}'
```

有历史的会话会流式返回完整状态快照（在 `messages` 上的一次 `set`），并且必须以
`data: [DONE]` 结束。

## 文档

- `CONTEXT.md` —— 权威的领域术语表。
- `AGENTS.md` —— 仓库结构、命令、传输线上契约与架构规则（本 README 的运维姊妹篇）。
- `docs/architecture.md` —— 系统架构。
- `docs/adr/` —— 难以回退的决策（0001 后端传输、0002 记录归属、0003 运行时命令、
  0004 dsh harness、0005 共享 SessionRuntime、0006 Project 是工作区与共享单元、
  0007 v1 记录层 = Project/Session/Run + 文件存储）。
- `docs/design/` —— 研究型智能体框架与实施计划（中英）。

## 领域术语

见 `CONTEXT.md`（`Project`、`Project Workspace`、`Session`、`Run`、`Runtime
Command`、`Command Catalog`、`Workflow`；`Study`/`Task`/`Artifact`/`Evidence`/
`Conclusion`/`AgentBlueprint` 在其中列为 deferred）。
