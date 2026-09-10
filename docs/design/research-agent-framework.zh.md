# 科研智能体框架 — 设计

> 本文是英文版 [`research-agent-framework.md`](./research-agent-framework.md) 的中文译文；
> 两者内容对应，若有分歧以英文版为准。代码与标识符保持英文。

状态：提案（rev 4）。读者：`packages/*`、`services/transport-service`、`apps/web`
的维护者。术语体系：`codebase-design`（模块 module / 接口 interface / 接缝 seam /
适配器 adapter / 深度 depth）。领域术语：`/CONTEXT.md`。

本文在既有 transport 接缝之上，设计 Science Studio 目前缺少的两项能力：

1. **部署模式** — 一套本地单用户安装（免登录，runtime 运行在用户自己的机器上），
   以及一套托管的多用户服务（每个用户一个 runtime，运行在服务器端的隔离沙盒中），
   二者共用**同一套前端、同一套线协议（wire protocol）**。
2. **工作区文件服务** — 浏览 session 的工作目录、用 `@` 把文件传给 agent，以及打开
   agent 返回的文件。

设计保持既有接缝（assistant-ui transport 协议、`RuntimeAdapter`、`Transcript`/
`RunFlow`、record 归属）的形式不变，只在其外围新增模块。

后台服务采用 **Fastify**。多用户能力是一个**不在开源仓库中的私有企业模块**；开源核心
保持为一个完整、且不受其影响的单用户产品（§9.2）。runtime 层刻意保持**多元**：
openclaw 与 dsh 是同一接缝下的两个适配器，而新增第三个不得触碰核心（§4.3）。

---

## 1. 驱动力

- **一套 UI、一套协议、多种后端。** `apps/web` 通过 `useTransport` 渲染
  assistant-ui 的 Thread；`POST /api/transport` 是「命令进、状态快照出」。
  前端与协议都不得感知部署模式、租户（tenancy）或沙盒。
- **模式是后端的组合问题。** 单用户与多用户的差异只在于*调用者是谁*，以及*他的
  runtime 和文件在哪里*。它绝不能以分支的形式泄漏到服务、适配器或 UI 中。
- **agent 本来就拥有文件系统。** 我们交付的每一种 runtime，agent 都带着一个工作
  目录和文件工具运行（`CONTEXT.md` 中的 `Workspace`/cwd）。所以交给 agent 的文件是
  一个**引用**，指向它本来就能打开的东西，而不是一次上传。
- **多租户是敌意边界。** openclaw `fleet` 明确警告：一个共享的 Gateway 不是多租户
  边界；每个信任边界各自拥有一个 **cell**。Science Studio 必须如实映射这条边界，
  而不是假装自己比它更强。
- **开源核心（open core）。** 开源仓库必须仍是完整的单用户产品。企业模块从外部接入
  开源核心声明的接缝；开源核心从不依赖它，它的缺席对单用户安装没有任何影响。

## 2. 不可更改的部分

| 既有接缝 | 为何保留 |
| --- | --- |
| assistant-ui transport 协议（`useAssistantTransportRuntime`） | UI 是无状态视图；`converter` 与 runtime 无关。 |
| `RuntimeAdapter`（`packages/transport/src/types.ts`） | 换 runtime 仍然是换适配器。 |
| `Transcript` + `RunFlow` 套件 | 适配器继续共享同一套 fold-and-fan-out，不重复实现。 |
| reconcile-first + 常驻 watch | 历史收敛语义，不动。 |
| record 归属（`docs/adr/0002`） | `Run`/`Artifact` 由 Science Studio 拥有，而非 runtime。 |
| assistant-transport 线协议（SSE 帧、`[DONE]`） | 迁移到 Fastify 是实现层变更，不是协议变更。 |

本设计**新增**接缝，不移动以上任何一条。

## 3. 已确认的决断

首轮评审后确认；这些决断驱动本文其余部分。

| 问题 | 决断 |
| --- | --- |
| openclaw gateway 文件 API | **没有。** 文件访问走宿主机侧、基于 cell 的 bind-mount；经 gateway 代理的 workspace 方案被否决，而非推迟（§13）。 |
| record 持久化 + 租户隔离 | **按租户的 Postgres schema。** |
| 托管模式登录 | **bearer token。** |
| 上传上限 / 存储配额 | **可配置。** 默认：上传 **100 MB**，配额 **2 GB**。 |
| 二进制文件预览 | **v1 不做** —— 文本内联渲染，其余一律仅下载。 |
| `@` 提及目录 | **保持为引用**（不展开）。 |
| 后台框架 | **Fastify。** |
| 开源核心边界 | **多用户是私有企业模块**；开源仓库保持单用户完整，且绝不受其缺席影响。 |
| Runtime 多元 | **不透明的 `RuntimeBinding` + 工厂注册表**；openclaw 与 dsh 是两个适配器，新增第三个不触碰任何核心包（§4.3–4.4）。 |

## 4. 新接缝

接缝引入前，服务把「一个进程 = 一个 runtime = 一个用户」硬编码了进去：
`resolveAdapter()` 永远返回 `adapters[0]`（`services/transport-service/src/index.ts`），
而适配器的 `init()` 从 `process.env` 绑定单个 gateway。这意味着无法按租户路由、也没有
身份的位置。修法是若干个小接口 —— 已在 Phase 0 落地
（实时状态见 [`implementation-plan.md`](./implementation-plan.md)）。

### 4.1 `Principal` — 身份是接缝，不是模式

```ts
// packages/transport/src/principal.ts  （新增）
export type Role = "researcher" | "manager";

export interface Principal {
  /** 稳定的用户 id；单用户模式下是常量。 */
  id: Id;
  /** 拥有该 principal 沙盒的信任边界。本地模式下等于 `id`。 */
  tenant: string;
  displayName: string;
  roles: readonly Role[];
  /** 为 true 表示该部署无需凭据即授予此身份。 */
  local: boolean;
}

/** resolver 可读取的最小请求信息 —— 使其与框架无关。 */
export interface RequestContext {
  headers: Readonly<Record<string, string | undefined>>;
  url: string;
}

export interface PrincipalResolver {
  /** 解析调用者；返回 null 表示拒绝（由 HTTP 层回 401）。 */
  resolve(req: RequestContext): Promise<Principal | null>;
}
```

一个接口，两个适配器：

- `LocalPrincipalResolver`（开源）— 返回常量
  `{ id: "local", tenant: "local", local: true, roles: ["researcher","manager"] }`。
  没有 cookie、没有 header、没有登录。**「单用户免登录」这条需求的全部实现就是
  这里。**
- `BearerPrincipalResolver`（企业，外部）— 校验 bearer token，把其 claims 映射为带
  真实 `tenant` 的 principal。登录在 web 应用处终结并由其取得 token；服务只负责校验。

有了它之后，调用者一次调用即可回答：*这是谁*、*属于哪个 tenant*。再无其他。

### 4.2 `Environment` — 一个 principal 的 session 能得到什么

这是核心的深模块。它是唯一回答「*这次请求使用哪个 runtime 绑定、哪个文件根*」的
地方。

```ts
// packages/transport/src/environment.ts  （新增）
export interface Environment {
  readonly adapter: RuntimeAdapter;
  readonly workspace: Workspace;
  /** 适配器为请求的 threadId 解析出的规范 session key。 */
  readonly sessionKey: string;
}

export interface EnvironmentProvider {
  /**
   * 获取或惰性构建某个 principal 的 session 所需的环境。`threadId` 是客户端的
   * 原始声明（mount probe 为 null）；provider 会用选中适配器的
   * `resolveSessionKey` 映射它。
   */
  acquire(principal: Principal, threadId: string | null): Promise<Environment>;
  /** 拆除（登出、删除租户、部署关停）。 */
  dispose(principal: Principal): Promise<void>;
}
```

这两个方法背后是：tenant→沙盒查找、sandbox 供给、经由 runtime 工厂（§4.3）构造
适配器、按 principal 的连接缓存与空闲回收、按租户隔离的 record store
接线，以及 workspace 根目录解析。调用方 —— 也就是各个 HTTP 路由 handler —— 完全看
不到这些。

`CachingEnvironmentProvider`（开源，通用）提供生命周期；具体的 sandbox provider 由
注入决定。适配器：

| 适配器 | 模式 | 仓库 | 背后是什么 |
| --- | --- | --- | --- |
| `LocalEnvironmentProvider` | 单用户 / 示例 | 开源 | 由 `process.env` 构建的一个适配器；一个 workspace 根 |
| `FleetEnvironmentProvider` | 托管，openclaw | **私有** | 每个 tenant cell 一个 `OpenClawRuntimeAdapter`，带缓存 |
| `DshEnvironmentProvider` | 托管/本地，dsh | 开源 provider，私有接线 | 每个 principal 一个 harness 子进程，cwd = 他的 workspace |

**已否决的替代方案：** 让 `RuntimeAdapter` 感知租户（把 `Principal` 传进
`init`/`run`）。那会把 provisioning、连接池和身份塞进每一个适配器，与「按适配器
的代码只做 event→delta 映射」相矛盾。组合适配器，不要拓宽它们。

### 4.3 `RuntimeFactory` — runtime 如何接入

上面的接缝与 runtime 无关，但仍有两处是 gateway 形状的：服务自己构造适配器（因此它
必须知道 `{url, token}`），以及 `transport-service` 静态 import 了两个 runtime 包。两者
都由一个注册表取代。

```ts
// packages/transport/src/runtime.ts  （新增）
export interface RuntimeBinding {
  readonly runtime: string;                              // "openclaw" | "dsh" | …
  /** 连接材料。其形状对该 runtime 的适配器而言是私有的。 */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface RuntimeCapabilities {
  commandCatalog: boolean;
  remoteSettleWatch: boolean;
  tokenStreaming: boolean;
  approvals: boolean;
  hostedSandbox: boolean;
  perSessionCwd: boolean;
}

export interface RuntimeFactory {
  readonly runtime: string;
  readonly capabilities: RuntimeCapabilities;
  /** 为该 binding 构造（但不 `init()`）一个适配器。同步。 */
  create(binding: RuntimeBinding): RuntimeAdapter;
}

/** runtime 包向组合根发布的唯一导出。 */
export interface RuntimePlugin {
  readonly runtime: string;
  readonly factory: RuntimeFactory;
  /** 从部署环境切片构建该 runtime 的单用户 binding。 */
  localBinding(env: Readonly<Record<string, string | undefined>>): RuntimeBinding;
}
```

- 每个 runtime 包拥有自己的工厂与 binding 类型（`transport-openclaw` →
  `GatewayBinding { url, token }`；`transport-dsh` → `DshBinding { home, profile,
  workspace, apiKeyRef }`）。共享接缝永远不出现 `url`、`token` 或任何启动面。
- 服务从配置注册工厂，而非静态 import —— 与企业模块（§9.2）同一条加载规则。选择
  runtime 变成一个显式维度，而不再是 `adapters[0]`（§15.7）。
- `init()` 去掉 `gateway`：适配器收到的 `RuntimeInitOptions` 携带不透明的 `binding` 与
  workspace（§7）。这关闭了被文档记录在案的 dsh 后门 —— 进程型 runtime 之所以要从
  `config` 里读 `DSH_*`，正是因为接缝假设了 url/token 形态。
- **删除测试：** 新增第三个 runtime = 新增一个包 + 注册一个工厂，无需改动 `transport`、
  `transport-service`、`workspace` 或 `apps/web`。由 CI 门禁强制（§9.2）。

### 4.4 `RuntimeCapabilities` — 消费方可以假设什么

各 runtime 存在消费方必须分支的差异，而这些差异此前隐含在可选方法或硬编码的文字里。
把它们声明出来。

```ts
export interface RuntimeCapabilities {
  commandCatalog: boolean;      // listCommands()
  remoteSettleWatch: boolean;   // subscribe()
  tokenStreaming: boolean;      // openclaw 为 true；dsh 是 step 粒度
  approvals: boolean;           // openclaw 为 true；dsh 为 false
  hostedSandbox: boolean;       // 能否在服务端供给
  perSessionCwd: boolean;       // dsh 为 true；openclaw 为 false（§14.3）
}
```

- 服务端分支继续使用适配器的可选方法（`listCommands?`、`subscribe?`）—— 该机制保留。
  `capabilities()` 用于消费方**必须提前知道**的特质：服务（是否暴露 `/approve`？是否
  供给托管沙盒？）、UI（对一个 step 粒度的 runtime，是否渲染 token 流式光标？）、以及
  workspace 策略（per-session cwd）。
- `RuntimeAdapter.approve` 改为**可选**（`approve?`），而不是要求每个不支持审批的
  runtime 写空实现；`capabilities.approvals === (typeof adapter.approve === "function")`。
- 保持集合精简。只有当一个字段能让消费方避免硬编码 runtime 名称时，它才配留在其中。

## 5. Workspace — 一个安全的文件模块

`Workspace` 是任何组件读取某个 session 文件的唯一途径。它是深的：少量方法背后藏着
路径包含（containment）、symlink 策略、大小上限，以及 browser 路径 ↔ agent 路径的
映射。

```ts
// packages/transport/src/workspace.ts  （接缝类型；实现位于 @science-studio/workspace）
export interface Entry {
  /** 工作区相对路径，POSIX 风格（绝不为绝对路径、绝不含 `..`）。 */
  path: string;
  name: string;
  kind: "file" | "dir";
  size?: number;
  mime?: string;
}

export interface DirListing {
  path: string;
  entries: Entry[];
}

export interface FileStat extends Entry {
  modifiedAt?: string;
}

export interface FileContent {
  /** 流式返回；调用方绝不把整个大文件留在内存里。 */
  body: ReadableStream<Uint8Array>;
  size: number;
  mime: string;
}

export interface Workspace {
  list(relPath: string, opts?: { depth?: number }): Promise<DirListing>;
  stat(relPath: string): Promise<FileStat>;
  open(relPath: string, opts?: { maxBytes?: number }): Promise<FileContent>;

  /** browser/工作区路径 → AGENT 看到的路径（根由适配器决定）。 */
  toAgentPath(relPath: string): string;
  /** agent 产出的路径 → 工作区相对路径；若在根之外则返回 null。 */
  toWorkspacePath(agentPath: string): string | null;
}
```

### 接口不变量（属于接口的一部分，而非实现细节）

- `relPath` 永远是工作区相对、POSIX 风格。绝对路径、`..` 段、NUL 字节和平台分隔符
  在触碰文件系统之前就被拒绝。
- 解析时对**根目录和目标**都做 `realpath`；目标必须留在根目录之下。逃逸根目录的
  symlink 被拒绝（v1 直接拒绝所有 symlink —— 更容易推理，后续再有意重新审视）。
- `open` 强制字节上限；更大的文件走流式下载，而不是内联读取。
- v1 是**只读**的。上传/写入是后续的方法（`write`），与上传路径（§8）及下面的可配置
  限制一并加入。

### 限制（可配置）

```ts
export interface WorkspaceLimits {
  /** 单次上传的最大字节数。默认 100 * 1024 * 1024（100 MB）。 */
  maxUploadBytes?: number;
  /** 一个 principal/租户可存储的总字节数。默认 2 * 1024**3（2 GB）。 */
  quotaBytes?: number;
}
```

`maxUploadBytes` 在开源的上传路径中强制。`quotaBytes` 需要按租户计量，因此通过一个
可选接缝强制，由企业模块提供实现：

```ts
export interface QuotaPolicy {
  /** 当 `additionalBytes` 会超出该 principal 的配额时抛出异常。 */
  check(principal: Principal, additionalBytes: number): Promise<void>;
}
```

开源默认：本地为空操作，或对 `quotaBytes` 做一次简单的用量扫描。
强制方式分两层 —— 一层是宿主文件系统的 project quota（硬），一层是这套软账本
（soft）—— 见 §14.2。

### 路径映射这一对方法，正是本模块为何「深」

browser 看到的是 `analysis/plots/volcano.png`；openclaw cell 中 agent 看到的是
`/home/node/.openclaw/workspace/analysis/plots/volcano.png`。与其让每个调用方都携带
这层差异，不如由 `toAgentPath`/`toWorkspacePath` 拥有它。session 的分区方式
（共享 workspace 还是 `sessions/<key>/` 子目录）同样是 provider 的策略，在接缝之上
不可见。

### 实现

- `FsWorkspace(root, { agentRoot })`（开源）— 本地文件系统。用于单用户模式、示例，
  以及 fleet cell 的宿主 bind-mount。
- `GatewayWorkspace` — 对 openclaw 不可用（其 gateway 不暴露文件 API，§3），所以 cell
  的文件从宿主 bind-mount 读取。接口仍然为它留门：未来某个*确实*暴露文件 API 的
  runtime 可以自行实现 `Workspace`，而无需触碰任何调用方 —— 这正是接缝的回报（§13）。

## 6. Sandbox — tenant → runtime

`EnvironmentProvider` 之上还需要一样东西：*给定一个 tenant，他的 runtime 和文件在
哪里？* 接口与 runtime 无关；连接材料不在接口上。

```ts
// 接缝类型在 @science-studio/transport；Local/Dsh providers 在 @science-studio/sandbox
export interface Sandbox {
  tenant: string;
  /** 该 sandbox 运行哪个 runtime 产品 —— 即 runtime 工厂 id（§4.3）。 */
  runtime: string;
  state: "ready" | "provisioning" | "stopped" | "error";
  /** 宿主侧根。与 runtime 无关：fleet bind-mount、dsh cwd、本地目录皆可。 */
  workspaceRoot: string;
  /** 以 RUNTIME 的 agent 视角看到的 workspace 根路径。 */
  agentRoot: string;
}

export interface SandboxProvider {
  ensure(tenant: string): Promise<Sandbox>;
  status(tenant: string): Promise<Sandbox | null>;
  remove(tenant: string): Promise<void>;
  /**
   * 为该 sandbox 产出的、交给 runtime 工厂的不透明连接材料。其形状对
   * provider 与其适配器而言是私有的 —— `endpoint`、`tokenRef`、子进程句柄或
   * API key 引用都不进入共享类型。
   */
  binding(sandbox: Sandbox, env: NodeJS.ProcessEnv): Promise<RuntimeBinding>;
}
```

**是隔离原语，而不是「fleet 模型」。** 托管沙盒可以是：容器化的 gateway（fleet、裸
Docker、k8s pod）、受限子进程（dsh 配独立 uid 或 nsjail）、或最弱的 —— 共享进程 +
命名空间目录。`SandboxProvider` 能表达这三种；fleet 只是其中一种实现。信任差异要如实
陈述（§10）。

- `LocalSandboxProvider`（开源）— 由环境变量合成一个 sandbox；不做供给。
- `FleetSandboxProvider`（**私有**）— 每租户一个 cell。
  - `ensure` 在首次使用时执行 `openclaw fleet create <tenant> --json`，把**只打印一次
    的 Gateway token** 捕获进 secret store；后续调用读注册表。`binding` 返回
    `{ runtime: "openclaw", config: { url, tokenRef } }`。
  - `remove` 在完成 Science Studio 侧的级联删除后执行
    `openclaw fleet rm <tenant> --purge-data --force`。
  - `status` 把 `fleet status` 映射到 `Sandbox["state"]`。
  - 用 digest 固定镜像（`--image …@sha256:…`），并依赖 fleet 带健康门禁的
    create/upgrade 与自动回滚。
- `DshSandboxProvider`（开源）— 每个 principal 一个 harness 子进程，拥有自己的 home
  和 cwd（create-only 的 session 约束见 `docs/adr/0004`）；`binding` 返回
  `{ runtime: "dsh", config: { home, profile, apiKeyRef } }`。

**token 问题真实存在，必须被设计，不能含糊带过。** Fleet 的注册表刻意*不*存 token，
所以 Science Studio 需要自己的 `SandboxRegistry`（tenant → port、`tokenRef`、
workspaceRoot、state，**私有**）。要么自己生成 token 并传 `--gateway-token`，要么把
create 输出捕获一次。无论哪种：**token 只写入一次，之后绝不从 fleet 的输出中回读**，
且它始终留在 provider 的注册表内。

## 7. 附件 — 是引用，不是拷贝

用 `@` 提及一个文件，必须能到达 agent。因为 agent 的 cwd *就是* workspace，所以这是
一个路径引用；没有任何字节被搬运。目录提及同理：它是一个引用（`@analysis/`），永不
展开（§3）。

扩展线协议（增量式，现有客户端/适配器继续可用）：

```ts
// packages/transport/src/types.ts
export interface AttachmentRef {
  kind: "workspace" | "upload";
  /** `kind: "workspace"` 时的工作区相对路径。 */
  path?: string;
  name: string;
  mime?: string;
  size?: number;
  /** `kind: "upload"` 的 base64 负载（阶段 2）。 */
  data?: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: Id; name: string; args: string; result?: string; isError?: boolean }
  | { type: "artifact"; artifactId: Id; name: string; kind: string }
  // 新增：
  | { type: "file"; path: string; name: string; mime?: string; size?: number; source: "workspace" | "upload" };

export type TransportCommand =
  | {
      type: "add-message";
      message: { id: Id; role: "user" | "assistant"; content: string; attachments?: AttachmentRef[] };
    }
  | { type: "add-tool-result"; toolCallId: Id; result: string };
```

今天的 `normalizeCommands()` 从 `message.content ?? msg.parts` 里取出文本，并静默丢弃
其余一切。它必须改为把非文本 part 提升为 `attachments`。

**引用在哪里变成 runtime 消息。** 由适配器拥有，因为只有适配器知道它那个 runtime 的
语法。runtime 工厂（§4.3）在构造时把 binding 与 workspace 交给适配器：

```ts
export interface RuntimeInitOptions {
  recordStore: RecordStoreLike;
  /** 不透明、由 provider 提供的连接材料（§4.3、§6）。 */
  binding: RuntimeBinding;
  /** session 的 workspace，用于附件引用与 file part 的映射。 */
  workspace?: Workspace;
  /** 部署环境切片 —— 通用；绝不是某个 runtime 的启动面。 */
  env?: Record<string, string | undefined>;
}
```

适配器用自身类型（`GatewayBinding`、`DshBinding`）校验 `binding.config`；不匹配是 init
错误，而不是共享类型要关心的事。旧的 `RuntimeConfig`/`{ url, token }` 形状彻底从接缝
中消失。

这样 `run()` 无需改动签名：适配器通过 `workspace.toAgentPath()` 解析每个
`AttachmentRef.path`，并把它渲染进 runtime 的消息（openclaw：在发送的文本中标注 /
附一个路径块；dsh：写进 prompt）。**一次 `upload` 先由文件服务写入 workspace，随后
就变成普通的 `workspace` 引用** —— 两条路合成一条代码路径，这正是该接缝买到的深度。

composer 里的 `@` 选择器复用*已被验证*的 slash menu 机制
（`ComposerPrimitive.Unstable_TriggerPopover` + 一个构建 adapter 的 hook；见
`useRuntimeSlashMenu`）。新的 `useWorkspaceMentions()` 为 `@` 提供同样的形状：从
workspace API 拉取条目，返回的 items 其 `execute` 会物化一次提及（给用户看的文本
token + 给线协议用的 `AttachmentRef`）。应用只负责给 popover 换皮。

## 8. 回复中的文件引用

agent 会以两种形态返回文件路径：文本中的 markdown 链接，以及结构化的 tool/event
负载。两者都经过**同一套语法**解析。

```ts
// packages/transport-client/src/file-reference.ts （新增）
export interface FileRef {
  workspacePath: string;
  name: string;
}

/** 识别 agent 输出中的工作区文件引用；否则返回 null。 */
export function resolveFileReference(
  href: string,
  ctx: { toWorkspacePath: (agentPath: string) => string | null },
): FileRef | null;
```

可识别：工作区相对路径、位于 agent 根之下的 `file://` URI，以及适配器可以注入的
`science://workspace/<path>` 自定义 scheme。拒绝：`http(s)`、`data:`、`mailto:`、
仅 fragment。解析**在服务端也会做一次**，然后适配器才会产出一个结构化的 `file`
part，因此伪造的路径永远无法指向另一个 tenant 的文件。

前端接线：

- markdown 组件映射（`MarkdownComponents`，被 `transport-client/src/markdown.tsx`
  使用）覆盖 `a`：命中的引用渲染为站内文件 chip，点击打开查看器；其余保持普通外链，
  带 `rel="noopener noreferrer"`。
- `partToContent()`（`transport-client/src/converter.ts`）目前把 `artifact` 渲染成
  字面字符串 `[artifact: name]`；它必须把 `artifact` 和新增的 `file` part 映射为
  assistant-ui 的 `file` part，这样现有的 `File` 组件
  （`apps/web/.../elements/file.tsx`）就能免费渲染名称/图标/大小，并提供下载/打开
  操作。

**v1 的预览范围。** 二进制预览不在范围内（§3）：查看器对文本内联渲染，其余一律提供
下载。图片/PDF/notebook/表格预览是后续有意加入的能力。

## 9. 后端接口面、Fastify 与鉴权

每一条路由（transport、watch、commands、**workspace**）都执行同一段前置逻辑：

```
RequestContext → PrincipalResolver.resolve → (401 | Principal)
             → EnvironmentProvider.acquire(principal, sessionKey)
```

runtime 适配器按 **principal 缓存**（一个 gateway/harness 连接服务该 principal 的
所有 session）；workspace 则根据解析出的 `sessionKey` 按 **session 派生**。自身不携带
session 的路由（`GET /commands` 目录）传入适配器的默认 session key，正如今天的 mount
probe 所做的那样。

新增的 workspace 路由（JSON / 流式字节），由与 transport **同一个服务**提供：

| 路由 | 返回 |
| --- | --- |
| `GET /api/workspace/entries?path=&session=` | `DirListing` |
| `GET /api/workspace/stat?path=&session=` | `FileStat` |
| `GET /api/workspace/file?path=&session=&download=1` | 字节流 + `Content-Type`、`Content-Disposition` |
| `POST /api/workspace/upload`（阶段 2） | `AttachmentRef` |

把文件服务放在 transport 服务里、而不是一个独立进程，是有意为之：文件服务需要与
transport *完全相同*的 principal 与沙盒解析。独立进程会迫使注册表出现第二份拷贝，
并多出一跳服务间信任。模块是独立的（`@science-studio/workspace`）；部署仍是同一个
进程。

### 9.1 Fastify

服务从手写的 `node:http` handler 迁移到 **Fastify**。这是实现层变更；
assistant-transport 线协议不受影响。

```ts
// services/transport-service/src/server.ts  （新增）
export async function createServer(backend: Backend) {
  const app = Fastify({ logger: true });
  await app.register(cors, backend.cors);
  app.decorateRequest("principal", null);
  app.addHook("preHandler", principalHook(backend.principal)); // 为 null 时回 401
  await app.register(transportRoutes, { environments: backend.environments });
  await app.register(workspaceRoutes, { environments: backend.environments });
  return app;
}
```

- **SSE。** transport 路由接管 Node 响应（`reply.hijack()` + `reply.raw.writeHead` /
  `write` / `end`），使帧的流转与今天完全一致，且仍以 `data: [DONE]` 终止。
  Fastify 的缓冲绝不能出现在这条路径上。
- **鉴权。** 一个 `preHandler` hook 解析 `Principal` 并装饰请求；resolver 由注入决定，
  因此开源注册本地那个，企业模块注册 bearer 那个。同一个 hook 保护 workspace 路由。
- **CORS。** `@fastify/cors` 配注入的配置：单用户模式对 loopback 宽松，托管模式锁定到
  web 应用的 origin 并允许凭据（接缝前的 `access-control-allow-origin: *` 绝不能带到
  托管模式）。
- **可测试性。** `app.inject()` 能在进程内驱动每一条路由而无需绑定端口 —— 现有的服务
  测试只会更简单，不会更难。

web 应用的 Next route handler（`apps/web/app/api/transport/route.ts`）仍然透传到服务
（绝不要用 `next.config` 的 rewrite —— 它会缓冲），并新增一个兄弟
`app/api/workspace/[...path]/route.ts`，在托管部署中转发 `Authorization` 头。

### 9.2 开源核心分层：开源核心 + 私有企业模块

需求（§1）：多用户是一个位于**独立私有仓库**的企业功能，且它的缺席不得影响单用户。
接缝优先的设计让这一点变成字面事实 —— 企业模块是一组*树外适配器*，实现开源核心声明
的接口。

| 开源（公开仓库） | 私有（企业仓库） |
| --- | --- |
| `packages/transport` — `Principal`/`PrincipalResolver`、`Environment`/`EnvironmentProvider`、`RuntimeAdapter`、`RuntimeFactory`/`RuntimeBinding`/`RuntimeCapabilities` | `BearerPrincipalResolver` |
| `packages/workspace` — `Workspace`、`FsWorkspace`、限制、`QuotaPolicy` | 配额计量实现 |
| `packages/sandbox` — `Sandbox`、`SandboxProvider`、`LocalSandboxProvider`、`DshSandboxProvider` | `FleetSandboxProvider` + `SandboxRegistry` + `openclaw fleet` 客户端 |
| `packages/record` — 领域类型 + `RecordStore` | `SchemaRecordStore`（按租户 Postgres schema）+ 迁移 |
| `services/transport-service` — Fastify 插件、`CachingEnvironmentProvider`、本地组合 | 企业 Fastify 插件，接线 bearer + fleet + schema store |
| `apps/web` — Thread、workspace 浏览器/查看器、`@` 选择器 | 登录门 + 配额计量，通过可选 UI 插槽挂载 |

**加载规则。** 开源核心绝不静态导入企业代码。组合根从环境变量解析一个可选的模块
specifier 并动态导入：

```ts
// services/transport-service/src/composition.ts  （新增）
export interface Backend {
  principal: PrincipalResolver;
  environments: EnvironmentProvider;
  cors: CorsConfig;
  quota?: QuotaPolicy;
}

/** 树外企业模块所实现的契约。 */
export interface EnterpriseModule {
  createBackend(env: NodeJS.ProcessEnv): Promise<Backend>;
}

/** 单用户：完整产品，零企业代码被加载。 */
function localBackend(env: NodeJS.ProcessEnv): Backend { /* Local* + FsWorkspace */ }

export async function createBackend(env = process.env): Promise<Backend> {
  const specifier = env.SS_ENTERPRISE_MODULE;
  if (!specifier) return localBackend(env);
  const mod = (await import(specifier)) as EnterpriseModule;
  return mod.createBackend(env);
}
```

同样的模式再往上一层：开源 web 应用解析一个可选的 `NEXT_PUBLIC_ENTERPRISE_UI` 模块
用于登录门与配额计量；缺席时 `apps/web` 的渲染与今天完全一致。

**保证单用户不受影响的几条不变量**（值得加一道 CI 门禁）：

1. 任何开源包都不依赖企业产物。
2. 在 `SS_ENTERPRISE_MODULE` 未设置时，开源测试套件通过。
3. 每个企业实现都满足开源声明的接口，因此核心在没有它的情况下可编译、可运行。
4. 已发布的公开接缝类型被当作公共契约 —— 有意保持精简并版本化，因为私有仓库要对它
   编译。
5. 新增一个 runtime 包只注册一个工厂，不触碰任何核心包（§4.3）。同一条门禁覆盖它。

这正是接缝纪律的回报：私有模块只是新增一个 `PrincipalResolver`、一个
`SandboxProvider`、一个 `RecordStore`、一个 `QuotaPolicy`，至多再加一个
`RuntimeFactory` —— 它从不修改核心。

| | 本地（单用户，开源） | 托管（多用户，私有模块） |
| --- | --- | --- |
| 登录 | 无（`LocalPrincipalResolver`） | bearer token（`BearerPrincipalResolver`） |
| Runtime | 用户自己的机器（`process.env`） | 服务器，按 tenant 的 sandbox（cell / 子进程） |
| 沙盒 | `LocalSandboxProvider` | `FleetSandboxProvider` |
| 文件 | 用户本地目录 | cell 的宿主 bind-mount |
| Record | 一个内存/本地 store | 按租户的 Postgres schema |
| 配额 | 仅本地限制 | 按租户计量 |

示例应用（`examples/transport-*-example`）永远是单用户；它们保持现有的开发接线。

## 10. 信任模型与安全不变量

- **租户边界 = 隔离原语，且要如实陈述。** fleet 后端的边界是一个 cell：它把租户与
  *彼此*隔开，但不隔开它们与 fleet operator、容器运行时管理员或被攻破的宿主机。每用户
  一个子进程（dsh）比每用户一个容器更弱。两者都不得被宣称得比实际更强。
- **cell 状态备份和 token 都是凭据。** Fleet 备份包含 OAuth 材料；token 只打印一次。
  二者都存入 secret store，权限 `0600` 或更严，绝不进仓库或日志。
- **Workspace 包含**（§5 的不变量）是文件服务的安全核心：无绝对路径、无 `..`、
  realpath 限定在根下、限制大小。
- **附件在服务端校验**，且在到达适配器之前，针对调用者自己的 workspace 校验；客户端
  无法指名另一个 session 的文件。
- **agent 产出的链接是不可信输入。** 只有解析到 workspace 的引用才在站内打开；查看器
  通过已鉴权的 API 拉取文件，因此伪造路径会因包含检查失败，而不是泄漏文件。
- **bearer token 在服务端校验**；开源核心从不接触凭据，本地 resolver 也从不签发
  凭据。
- 本地模式下绑定 **loopback**；托管模式下锁定 origin 的 CORS + 凭据。

## 11. 模块地图

```
开源（公开）
packages/transport                    + principal.ts, environment.ts, runtime.ts（仅接缝）
                                      + RuntimeBinding, RuntimeFactory, RuntimeCapabilities
                                      + AttachmentRef, file part, RuntimeInitOptions.{binding,workspace}
packages/transport-openclaw           runtime 自有：GatewayBinding + 工厂
packages/transport-dsh                runtime 自有：DshBinding + 工厂
packages/workspace            （新增）  FsWorkspace + 限制强制（接缝类型在 transport）
packages/contract-tests       （新增）  共享的接缝一致性套件，所有实现都运行
packages/sandbox              （新增）  Local + Dsh providers（接缝类型在 transport）
packages/transport-client             + useWorkspaceMentions, workspace 客户端, 文件引用 resolver,
                                        useWorkspace（拉取条目）, file part 转换
services/transport-service            + Fastify server + 插件, composition.ts, workspace 路由, principal hook,
                                        runtime 工厂注册表（配置驱动，无静态 runtime import）
apps/web                              + workspace 浏览器/查看器, @-mention popover 换皮, 文件链接组件
                                        + 可选的企业 UI 插槽（默认缺席）

私有（企业仓库）
@acme/ss-enterprise                     BearerPrincipalResolver, FleetSandboxProvider + SandboxRegistry,
                                        SchemaRecordStore（+ 迁移）, QuotaPolicy, 企业 Fastify 插件,
                                        登录门 + 配额计量
```

依赖方向：`transport-service` → {`transport`, `workspace`, `sandbox`}。
**所有接缝*接口*都住在 `transport`；实现包依赖它，而非反向**（无环）。runtime **不是**
核心依赖：每个 runtime 导出一个 `runtimePlugins` 数组并由配置加载，因此
`transport-service` 不携带任何 runtime 包的静态 import。`transport-client` 仍只拥有
React 边界，且与 runtime 无关。开源中没有任何东西指向企业模块。

## 12. 分阶段迁移

Phase 0 已**落地**；实时状态与清单见 [`implementation-plan.md`](./implementation-plan.md)。
下面的阶段仍是参考形态。

**阶段 0 — Fastify + 接缝，行为不变。**
1. 把 `transport-service` 移植到 Fastify，保持线协议与测试不变（用
   `app.inject()`），本地组合是唯一的 `Backend`。
2. 在 `transport` 中新增 `principal.ts` / `environment.ts` / `runtime.ts`；实现
   `LocalPrincipalResolver`，以及一个包装接缝前单适配器 + `NullWorkspace` 的
   `LocalEnvironmentProvider`；让所有 handler 都走前置逻辑。
3. 引入 `RuntimeBinding`/`RuntimeFactory`/`RuntimeCapabilities`；把每个 runtime 的启动面
   移入各自的包（`GatewayBinding`、`DshBinding`），并从配置注册工厂 —— 删除
   `RuntimeInitOptions.gateway` 与静态 runtime import（§4.3–4.4）。
4. 发布 `@science-studio/contract-tests` 的骨架，覆盖 `PrincipalResolver`、`Workspace`、
   `SandboxProvider` 与 runtime 工厂（§15.1）。

**阶段 1 — workspace（单用户）。**
5. 创建 `@science-studio/workspace`，含 `FsWorkspace`、`WorkspaceLimits` 及针对
   包含/symlink/大小不变量的测试。
6. 新增 `/api/workspace/*` 与对应 Next 路由；强制 `maxUploadBytes`；构建浏览器面板
   与查看器（文本内联，其余一律下载）。
7. 把 `resolveFileReference` 接入 markdown 映射和 converter。

**阶段 2 — 附件与运行控制。**
8. 扩展 `TransportCommand`/`MessagePart`；修正 `normalizeCommands`。
9. 把 `binding`/`workspace` 交给适配器；教会每个适配器渲染引用。
10. 构建 `@` 选择器（文件与目录都作为引用）。
11. 新增按 session 的运行锁，以及 `abort`/`approve` 路由（§15.3–15.4），并用
    `capabilities.approvals` 门控 `approve`。

**阶段 3 — 企业模块（私有仓库）。**
12. 创建 `@acme/ss-enterprise`：`BearerPrincipalResolver`（OIDC/JWKS）+
    `PrincipalDirectory`、`SecretStore`、`SandboxRegistry` + `FleetSandboxProvider`、
    `SchemaRecordStore`、企业 Fastify 插件；通过 `SS_ENTERPRISE_MODULE` 接线。
13. control schema + 迁移 runner（§14.5）；两层配额强制（§14.2）。
14. 锁定 origin 的 CORS、web 应用企业 UI 插槽（§14.4）中的登录门 + 配额计量。
15. 为 §9.2 的开源不变量加 CI 门禁（无企业依赖、新增 runtime 不改核心、模块未设置时
    套件全绿），并在私有仓库中运行开源的一致性测试套件。

## 13. 考虑过的替代方案

- **独立的 `file-service` 进程。** 否决：会重复 principal + 沙盒解析，并增加一跳信任。
  保留为一个包，进程内部署。
- **`GatewayWorkspace`（经由 runtime 代理文件）。** **否决**：openclaw gateway 不暴露
  文件 API（§3），所以宿主 bind-mount 是唯一路径。对 fleet 布局的耦合仍被限制在私有
  的 `FleetSandboxProvider` 中。
- **感知租户的 `RuntimeAdapter`。** 已在 §4.2 否决。
- **企业代码进树，用 license flag 门控。** 否决：那会把企业代码放进开源仓库，并使
  开源发布与之耦合。树外模块让边界成为物理边界。
- **单个 cell 之下按 session 划分子目录。** 推迟的策略：一个 cell 只暴露一个
  `OPENCLAW_WORKSPACE_DIR`；session 是共享它还是各自获得 `sessions/<key>/` 子目录，
  是 `WorkspaceProvider` 的决策，在接缝之上不可见。v1 默认：每个 sandbox 共享一个根；
  待有真实用法后再重新审视。
- **把文件作为 message part 上传。** 作为主模型否决：它拷贝了 agent 本来就能打开的
  字节，且破坏了与 runtime 无关的消息形状。上传改为对 workspace 的写入，随后成为
  普通引用。
- **给 `Sandbox` 加 runtime 类型 / 给 `RuntimeInitOptions` 加 `gateway`。** 否决：封闭的
  `kind` 联合与 `{url, token}` 字段把某一种 runtime 的传输方式烙进共享接缝 —— dsh 之所
  以要从 `config` 里读 `DSH_*`，正是这个原因。不透明的 `RuntimeBinding` + 工厂让接缝保持
  runtime 中立（§4.3、§6）。

## 14. 未解决问题的方案

### 14.1 IdP 与 token 签名

**分析。** 托管企业客户期望 SSO；自建身份存储（口令、重置、MFA）是一块庞大且安全
攸关的表面，我们不应拥有。服务还必须在高负载下无状态校验，且不与 web 应用共享签名
密钥。

**决断。**

- 在 web 应用（Next BFF）侧走 **OIDC authorization-code + PKCE**。IdP 是唯一的签名方。
- 服务对 **bearer access token** 做无状态校验，依据 IdP 的 **JWKS**（固定 issuer +
  audience），按 `kid` 缓存公钥，并在遇到未知 `kid` 时刷新（rotation-safe）。服务端不
  存储任何东西；web 应用只在 httpOnly cookie 中保存 refresh token。
- claims 通过 control schema 中的 **`PrincipalDirectory`** 映射为 `Principal`
  （`sub` → tenant、roles、status），而不是信任 token 里的 tenant claim。这样让开户、
  租户迁移、离职回收都成为本地且可审计的操作，也兼容 claim 较少的 IdP。
- 没有 IdP 的部署使用企业模块内的**本地 ES256 签名器**，走同一条 resolver 路径。
  绝不用 HS256：签名方与校验方是不同进程，密钥必须能独立轮换。

**后果。** 无状态横向扩展，且可通过任意 OIDC broker 接入 SSO；企业库中多出一张很小的
`PrincipalDirectory`。短 access-token TTL（约 15 分钟）限制吊销延迟；硬吊销 = 在目录
中禁用 + 每次请求做一次带短缓存的目录校验。

### 14.2 配额计量

**分析。** 两个事实会击穿朴素的「只统计上传」模型：agent 会把文件直接写进 workspace
（没有拦截点），而 2 GB 必须是真实上限，而不是一个提示。

**决断 —— 分两层。**

- **硬层：宿主文件系统的 project quota**，作用于租户的 workspace 子树（XFS
  `pquota`）。Fleet 自己的指引说得很明确 —— 「当这些目录也需要硬限制时，使用宿主文件
  系统的 project quota」—— 而且它能连 agent 写入的字节一起封顶。触壁时，cell 内部的
  写入会以普通的磁盘已满错误失败。
  - Fleet 的 `--disk` 只限制容器可写层；state 挂载是宿主存储，所以 project quota 必须
    施加在那里。
  - state 目录还包含 SQLite 状态/凭据，所以在文件系统支持子目录 project 时把 project
    设在 workspace 子树上，否则预留余量。
- **软层：`QuotaPolicy` + 账本**（control schema 中的 `workspace_usage(tenant, bytes,
  accounted_at)`）。上传按已知增量入账，并在超限时提前以清晰的 4xx + UI 提示拒绝；一个
  **对账器（reconciler）** 扫描 workspace（分批、带 TTL、账本过期时按需触发）以吸收
  agent 写入造成的漂移与删除。检查读账本是 O(1)；扫描永不落在请求路径上。
- **本地模式**：只有软层，`quotaBytes` 默认同样的 2 GB 或不设置。

**后果。** 两次对账之间账本可能滞后于现实 —— 可接受，因为硬层才是真实上限。把用量
暴露给 UI 计量条。删除租户 = drop schema + 移除 project + 清理 state 目录。

### 14.3 Session → workspace 分区

**分析。** 一个 cell 只暴露一个 `OPENCLAW_WORKSPACE_DIR`，且 runtime 的 cwd 按 cell
固定，因此同一用户 cell 下的多个 session 无法从 openclaw 获得各自的 cwd。完全共享根
会让两个 study 在常见文件名上相撞，并让中间产物跨 session 泄漏。

**决断。**

- **以 Session 为分区单元。** 它的 workspace 是 `<sandboxRoot>/sessions/<sessionKey>/`，
  `toAgentPath` 把 browser 的 `a.csv` 映射为 agent 的
  `sessions/<sessionKey>/a.csv`。引用永远无歧义，文件浏览器以一个稳定的 session 目录
  为根。
- 分区键是**规范 `sessionKey`**（即 `resolveSessionKey` 的返回值），而不是浏览器的临时
  `__LOCALID_*`，这样刷新页面与常驻 watch 会收敛到同一个目录。
- **record 层拥有 Session 身份**，因此分区名与 `Session` 行共用一个 id，provenance 保持
  完整。
- agent *仍可能*写到子目录之外（它看到的是整个根），所以隔离是引用层面的约定，而非硬
  牢笼。**dsh 不同**：适配器自己 spawn 子进程并设置 cwd，因此能原生强制真正的按 session
  根（声明为 `capabilities.perSessionCwd`，§4.4）。该策略活在 provider 内，在接缝之上
  不可见。
- **否决：每个 session 一个 cell。** 供给成本与 fleet 变更频率都过高。

**后果。** 一个 cell 服务多个 session；浏览器展示 session 子树。迁移：根级文件先以
只读形式作为「sandbox home」暴露，直到被重新归位。

### 14.4 企业 web UI：包，还是 fork

**分析。** fork `apps/web` 会把每一次开源 UI 变更都变成一次 merge —— 正是我们已否决的
「企业代码进树」的 UI 版本。而完全独立的企业应用又要求把 Thread/皮肤抽成一个可消费的
包，比当下所需更重。

**决断。** 企业 UI 以**私有 npm 包**发布，被开源声明的插槽消费，由
`NEXT_PUBLIC_ENTERPRISE_UI` 动态加载：

```ts
export interface EnterpriseUIExtension {
  /** 包裹整个应用：鉴权上下文 + 登录门；已认证时渲染 children。 */
  Shell?: ComponentType<{ children: ReactNode; api: string }>;
  /** Thread 头部 chrome（配额计量、租户切换）。 */
  ThreadHeaderExtras?: ComponentType;
  /** 额外的 composer 能力。 */
  ComposerExtras?: ComponentType;
}
```

插槽只允许**包裹或扩展**，绝不改变开源行为；缺席时，应用与单用户产品逐字节一致。以
merge 负担为由否决 fork。退路：若插槽增长到超出少量组件，就把开源外壳抽成
`@science-studio/web-app`，由企业应用组合它。

### 14.5 大规模下的 Postgres schema 迁移

**分析。** 按租户 schema 删除很干净（`DROP SCHEMA CASCADE`）且隔离良好，但迁移变成
对 N 个 schema 的扇出 —— 朴素做法又慢又重锁，且部分失败会留下版本漂移。

**决断。**

- 一个 **control schema**（`ss_control`）拥有 `tenants(id, schema_name,
  schema_version, status)`、`principal_directory` 与 `workspace_usage`。
- 一个**迁移 runner** 先把有序 SQL 应用到 control schema，再**分批**应用到租户 schema，
  并记录每个租户的 `schema_version`；幂等且可恢复，因此扇出中途崩溃是继续而非重来。
- 迁移必须是 **expand/contract** 式，并容忍 **≤1 个版本的漂移**，让迁移进行到一半的
  集群在发布期间仍可服务。
- 连接按事务绑定 schema（`SET LOCAL search_path`），对 pgBouncer 的事务级连接池安全；
  每 schema 的连接池缓存可避免重复下发。
- **规模上限**：catalog 体积与扇出耗时随租户数增长；盯住它们，超过某个书面记录的阈值
  后转向 **database-per-tenant**（同一个 `RecordStore` 接口）或带 RLS 的共享 schema。
  RLS 之所以只作为退路而非默认，仅因为我们选了 schema-per-tenant。

**后果。** 创建租户 = 在当前版本建 schema + 登记一行。删除 = `DROP SCHEMA CASCADE`
+ 移除 project + 清理 state。迁移是一个可恢复的运维任务，而不是应用启动步骤。

## 15. 进一步优化

1. **接缝的一致性测试套件**（`@science-studio/contract-tests`，开源）。开源核心边界
   的成色取决于私有模块是否符合契约。为 `PrincipalResolver`、`SandboxProvider`、
   `Workspace`、`QuotaPolicy`、`RuntimeFactory` 发布可复用的测试套件；企业仓库与
   第三方 runtime 仓库在 CI 中运行它们。这是对分层最有杠杆的单点补强。
2. **从 record 层构建真实的 `SessionState`。** *已解决（Phase 2.5）。* 服务通过
   `createSessionResolver`（`services/transport-service/src/sessions.ts`）解析出
   `Session` —— 其 id 就是规范的 runtime session key —— 并在首次使用时铸造它及其
   默认 Study，因此 `SessionState.studyId`/`agentId` 来自 record，且 `persistRun`
   能正确归属 `Run.sessionId`/`agentId`/`taskId`。
3. **按 session 的运行并发控制。** *已解决（Phase 2）。* 同一 session 的第二次并发
   运行以 **409** 拒绝，因此 `Transcript.attachFlow` 绝不会覆盖正在运行的 flow。
4. **运行控制接口面。** *已解决（Phase 2）。* `POST /api/transport/abort` 与
   `POST /api/transport/approve` 已存在，经同一个 environment 解析，并在
   `capabilities.approvals` 为假时让 `/approve` 返回 **501**（§4.4）。
5. **`SecretStore` 接口**（开源接口，实现树外）。provider 的 binding 携带的是
   `tokenRef` 而非 token；定义 `get(ref): Promise<string>`，让 provider 不必硬编码某种
   密钥格式。本地实现：`0600` 文件或 keychain。
6. **尊重运行中任务的回收。** `CachingEnvironmentProvider` 只能在没有任何 transcript
   `hasActiveFlow()` 时销毁 environment；否则一次空闲清扫会杀掉正在流式输出的回合。按
   TTL 回收，而不是按请求间隙。
7. **把 runtime 选择作为独立维度。** *已由 §4.3 解决*：runtime 产品由「注册/选中哪个
   `RuntimeFactory`」决定，与「获取哪个租户的 environment」相互独立 —— 不再隐式地由
   `adapters[0]` 决定。
8. **限流与按租户可观测性。** `@fastify/rate-limit` 按租户设键，并在每条日志中带上
   租户 id + 请求 id；一个吵闹的租户必须在对配额造成问题之前先可见、可约束。
9. **服务健康。** `GET /healthz`，外加一个由 `SandboxProvider.status` 支撑的按租户
   沙盒健康视图（fleet 后端用 `fleet doctor`），让 UI 能显示「你的沙盒挂了」而不是
   卡住一个线程。

## 16. 仍待解决的问题

- 各家 OIDC 的差异：claim 形状、多 IdP，以及目录同步。
- 宿主文件系统 project quota 的可用性（XFS/btrfs/zfs），以及不可用时的兜底策略。
- 脱离 schema-per-tenant 的租户数阈值（§14.5）。
- 企业 UI 是否应从插槽升级为抽出的外壳。
- 树外 runtime 包的分发与注册：与企业模块相同的 module-spec 机制，还是一个专用的
  runtime 注册表。

一旦被接受，拟提升为正式产物：关于 principal/environment 接缝的 ADR；关于开源核心
分层的 ADR（开源接缝契约 + 树外企业模块）；关于「每租户 fleet cell + workspace 文件
服务」的 ADR；关于「按 session 分区的 workspace + 两层配额」的 ADR；以及在
`CONTEXT.md` 中增补术语（`Principal`、`Tenant`、`Sandbox`、`Cell`、`Attachment`、
`FileReference`）。
