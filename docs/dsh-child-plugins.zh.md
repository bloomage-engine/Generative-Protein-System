# transport-dsh 子插件（per-launch profile patch）

dsh adapter 驱动的是一台**第三方 harness**：`@deepseek-ai/dsh-sdk-client` 把
`dsh --profile sdk` spawn 成子进程，走 stdio JSON-RPC，版本精确 pin 死
（docs/adr/0004）。这条 wire 没有命令面、没有取消、没有 token 级流式，二进制也
改不了。所以 Generative Protein System 需要加给 agent 的一切——项目脚手架、定时任务、
HPC、工作树、命令桥——都走本文的机制：**adapter init 时给每个插件写一个小
YAML 补丁，以 `--patch` 交给子进程，让 harness 自己的 cordis 插件装载器把插件
模块拉进它的进程。**

## 1. 注入原理

一个 cordis 插件就是形状固定的普通 JS 模块：

```ts
export const name = "gps-cron";                  // 插件 id
export const inject = ["commands", "tools", "systemPrompt"]; // 要注入的宿主服务
export function apply(ctx: CronHost, config) { ... }         // child boot 时被调用
```

harness 按 `inject` 列表从自己的服务容器解析依赖，再带着补丁里的 `config`
节点调 `apply`。补丁由 adapter 侧生成：`bridge.ts` 就是工厂
（`writeBridgePatch`/`writeProjectPatch`/`writeCronPatch`/`writeSubagentPatch`/
`writeHpcPatch`/`writeWorktreePatch`），产出统一形状：

```yaml
- insert:
    - id: gps-cron
      name: "file:///abs/path/to/dist/cron-plugin.js"
      config: {"project": {"id": …}, "root": "/abs/project/root"}
```

刻意的工程细节：

- **零 YAML 依赖**：补丁是手拼字符串，每个值都过 `JSON.stringify`（JSON 字符串
  /对象都是合法 YAML），嵌套 config 不需要序列化器。
- **不依赖 profile 目录解析**：插件 `name` 写成 `file:` URL（`dsh-app-boot`
  文档支持的形态），指向 adapter 自己 `dist/` 的兄弟文件
  （`new URL("./cron-plugin.js", import.meta.url)`）。插件随
  `@gps/transport-dsh` 一起发布，用户什么都不用装。
- **文件名唯一**（`cron-<8hex>.cordis.patch.yml`），两个 adapter / 两个
  Project 共用 `bridgeDir` 也不会互相覆盖。
- **补丁里的 config 就是父子两侧的全部契约**：Project 身份、工作区 root、
  socket 路径、服务 URL。config 里没有 `project` 的插件第一行就 INERT——同一
  个插件文件被挂进 `project-default` 冷启动时什么都不做。

## 2. 启动时序（`adapter.ts` → `initialize()`）

一个 `(Project, Worktree)` 一个 adapter、一个 child（docs/adr/0008）。init 先
从 Workspace seam 推导 agent cwd（`toAgentPath("")`，即 Files 面板列的同一个
目录），然后逐个 best-effort 写补丁；每次写入失败只是一行 stderr 警告，child
只是少那一个面：

| # | 插件（注入动词） | 挂载条件 | 给 child 带来什么 |
| --- | --- | --- | --- |
| 1 | `bridge-plugin.ts` | 无条件 | UNIX socket 命令桥 + 冷会话命令拦截（§4） |
| 2 | `subagent-plugin.ts` | 无条件 | 一段 systemPrompt：要求主 agent 逐条汇报被委派子代理的结果（docs/adr/0018） |
| 3 | `project-plugin.ts` | 真实 Project | 科研目录布局 + `PROJECT.md` Brief、`project_update`/`project_log`、`/project`（docs/adr/0012；见 docs/project-plugin.md） |
| 4 | `cron-plugin.ts` | 真实 Project | `schedule_*` 工具、`/cron`、prompt 段——root 钉在 MAIN（docs/adr/0017；见 docs/cron-scheduled-runs.md） |
| 5 | `hpc-plugin.ts` | 真实 Project | 五个 `hpc_*` 工具，纯 fetch（docs/adr/0024） |
| 6 | `worktree-plugin.ts` | 真实 Project | `worktree_*` 工具、`/worktree`，纯 fetch（docs/adr/0025） |

收集好的补丁路径集交给 `createClient({ patches })`，SDK 把每一条作为
`--patch <abs path>` 传给子进程（`resolveDshLaunch`）。

## 3. 统一纪律（每个插件都守）

下面每条规则都对应一个真实故障模式：

| 规则 | 原因 |
| --- | --- |
| **不 import 任何 `@deepseek-ai/*` / cordis** | 子进程自己 pin 了这些包；import 会拉进第二份拷贝，或随 harness 升级直接崩。宿主能力全部声明为**本地结构化类型视图**（`CronHost`、`BridgeHost`…），接口漂移表现为注册失败（unavailable），而不是 child 起不来。 |
| **永不写 stdout** | child 的 stdout 就是 NDJSON-RPC wire。诊断一律 `process.stderr.write("[gps-…] …")`。 |
| **`apply` 永不抛（fail SOFT）** | 一个抛异常的 cordis 插件会**让整个 child boot 失败**——adapter 丢掉整个运行时。配置缺失即禁用；每条注册各自 try。 |
| **dispose 挂 `ctx.effect(disposer, label)`** | 生命周期顺序交给 cordis（socket 关闭、监听器摘除）。 |
| **可以 import 自家 workspace 包**（如 `@gps/cron`） | 从插件文件的物理位置（adapter dist）解析，永不碰 harness 的拷贝。 |

插件能向宿主注册三类面：`ctx.tools.register(...)`（模型可见工具，参数是
JSON Schema）、`ctx.commands.register(...)`（harness 斜杠命令）、
`ctx.systemPrompt.section(...)`（教模型何时/如何使用的说明书段）。

## 4. bridge 插件：一条反打的私有通道

`bridge-plugin.ts` 把机制用到最深处——它不只注册东西，还开了一条私有通道
（docs/adr/0010、0011、0022）。它的 launch config 带一个 socket 路径：每
adapter init 唯一（`<pid>-<8hex>.sock`，刻意取短——POSIX `sun_path` 只有
104–108 字节，macOS 长 tmpdir 下完整 UUID 会让 `listen()` 以 ENAMETOOLONG
失败，得到一个静默无桥的运行时）。先 `rmSync` 残留文件再 listen，`chmod 0600`。
adapter 侧的一半（`bridge.ts` 的 `createCommandBridge`）在同一 socket 上说
纯 HTTP，动词固定、超时各定：

| 动词 | 用途 | 预算 |
| --- | --- | --- |
| `GET /commands` | agent 作用域的命令注册表列表 | 10 s |
| `POST /execute {sessionId, line}` | 执行一条命令行（`/compact` 会真跑一轮模型） | 300 s |
| `POST /interrupt {sessionId}` | `agent.cancel({kind:"user"},{keepInbox:true})`——SDK wire 没有取消，这是**唯一**的中途停法 | 10 s |
| `GET /assistant-stream` | 长连接 NDJSON，转发进程内 `agent/assistant-stream` 帧（`start`/`chunk`/`end`）——token 级流式与流式工具调用全靠它（docs/adr/0022）；watch 存活期间每秒重连 | ∞ |

**冷会话手法。** 注册表是 **agent 作用域**的，而 wire 上唯一能创建 agent 的
动词是 prompt。所以当一个还没有 agent 的会话发出 `/plan` 时，adapter 把这行
字作为该会话的**第一条 PROMPT** 发进去；插件的 `agent/pre-step` 瀑布监听器
判定"本步的每条用户 prompt 都是命令行"，用 harness 自己的
`commands.execute` 把它们跑掉，然后返回 `{kind:"reject"}`——该 step 以
`blocked` 结束，**模型从头到尾没看见这行字**。这就是 plan mode / goal 能在
第一次模型请求之前生效的原因。读目录永不启动 child；用户下达的命令才会。

## 5. 同一个机制，两种权力姿态

在同一套 patch 机制内，插件们采取的权力姿态不同：

- **文件型**（`project`、`cron`）：插件直接读写 Project Workspace——共享的
  文件就是权威，不需要 IPC。
- **服务代理型**（`hpc`、`worktree`）：每个工具的 `execute` 只是
  `fetch` `/api/hpc/*` 或 `/api/worktrees*`——SSH 和 git 的权力全在服务侧，
  插件一点不碰，systemPrompt 也明令 agent 不得另想（worktree 插件不能移动
  agent 的 cwd）。
- **纯行为型**（`subagent`、`bridge` 的 prompt 半边）：没有工具，只有引导。

## 6. 别和它混淆

`packages/plugins/molql-tool-dsh` 也是 dsh 插件，但它是**agent-side
deployable**：独立构建、安装进 harness 自己的插件/skill 通道，不走 per-launch
patch。本文这六个插件随 `@gps/transport-dsh` 发布，用户零安装。

## 验证

`packages/transport-dsh/test/`：`{bridge,project,cron,hpc,worktree,subagent}-plugin.test.ts`
（各插件对脚本化 host）、`{cron,project,hpc,worktree}-launch.test.ts` 与
`launch-cwd.test.ts`（补丁文件与 root 钉死）、`cron-main-root.test.ts`，外加
`services/transport-service/test/injected-plugins.test.ts`。真实 child boot 由
`scripts/smoke-dsh-command-bridge.mjs` / `scripts/smoke-dsh.mjs` 验证。
