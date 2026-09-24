# 按 Project 的定时运行（cron）

Cron 让一个 Project 能按计划重复执行一次 agent turn（"每天早上总结新结果"）。
它服从 docs/adr/0017 的一条总纲：**任务就是一个工作区文件，时钟归服务，agent
只有写作面。** 四层各自实现这条分工，且每一层对下层只读。

```
作者（dsh 子插件）──写入──▶  .science-studio/cron/<id>.md  ◀──读取──  调度器（服务）
                     共享同一 codec（packages/cron）              UI（轮询 /api/cron*）
```

## 1. codec 层 —— `packages/cron`（纯、零依赖）

三方共同 import，是文件格式的唯一权威。

- `task-doc.ts` —— 任务是 `.science-studio/cron/` 下的 `<id>.md`：简单
  `key: value` frontmatter（值一律 JSON 引号包裹：`name`、`schedule`、
  `enabled`、可选 `sessionId`/`createdAt`/`updatedAt`）+ 正文即 prompt。
  **id 就是文件名**（`^[a-z0-9][a-z0-9-]{0,63}$`），没有任何 record 行。
- `schedule.ts` —— 受限 5 字段语法（分 时 日 月 周；支持 `*`、区间、列表、
  步长；无名字、无 `@` 宏、无秒），提供 `parseSchedule` / `isValidSchedule` /
  `matchesSchedule`，外加 UI 用的 hourly/daily/weekly 预设。两个对 POSIX cron
  的刻意偏离：**所有字段都是 AND**（POSIX 对被限定的 dom 和 dow 取 OR，所以
  同时限定"几号"和"星期几"会比 POSIX 用户预期触发得更少），以及匹配用**服务器
  本地时间**（`Date` getter）。
- `log.ts` —— 兄弟文件 `<id>.log.md`：每次触发追加一个 `## <at> · <status>`
  块，status ∈ `success | skipped-busy | error`，可带 `session:`/`run:` 行与
  消息正文。解析容错（畸形块直接忽略）。

## 2. 服务侧 —— `services/transport-service/src/cron/`

- `store.ts` —— `CronStore`：list/read/write/remove + `appendLog`，完全架在
  **Workspace seam**（`list`/`open`/`write`/`delete`）之上，因此每个路径自动
  继承 FsWorkspace 的 containment/symlink/大小防线。畸形任务文档进 `invalid`
  列表，不致命。
- `routes.ts` —— `/api/cron*`（列表、单任务读/建/改/删、`POST /task/run`）。
  每条路由经 `ProjectScopes` 解析作用域，和产品其余部分一样落在
  `(projectId, main worktree)` 这个 Environment 上。创建时把 name slugify 成
  id，重复时加 `-2`、`-3`… 后缀。
- `scheduler.ts` —— `CronScheduler`，调度权威：
  - **每 30 秒一个 tick** 扫描所有 Project，acquire 其 `main` Environment，
    并**每次重新读取任务文件**——没有缓存，手工编辑下一 tick 即生效，重启即
    恢复、零 recovery 步骤。
  - `firedMinutes` Map 保证每个计划分钟至多尝试一次（30s tick 对分钟粒度会
    撞上两次）。
  - 一次触发抢的是与 transport 路由**同一个 `activeRuns` 单飞锁**（key 为
    `tenant:sessionId`），所以调度 run 和用户 run 永远不会在同一 Session 上
    交错；目标忙时记 `skipped-busy` 并丢弃。
  - 触发动作本身是一次**普通的 `adapter.run()`**，命令就一条 `add-message`
    （id 为 `cron-<at>-<taskId>`）：Run 被记录、这一轮进入 Session
    transcript、watcher 能收到——对 runtime 而言它和用户 turn 毫无区别。最终
    assistant 文本（截 4 000 字符）镜像进任务日志。
  - 目标解析：显式 `sessionId` 必须属于触发它的 Project 且位于 **main
    工作树**（docs/adr/0025）；指向 linked worktree 的目标被拒绝并把原因写进
    日志；省略时取该 Project main 工作树里最近活跃的 Session；无目标记
    `error`。
  - 生命周期：装饰为 `app.cronScheduler`，但**只有 `index.ts` 的 `isMain` 调
    `start()`**；测试和嵌入方直接调 `tick()`/`fire()`。hosted 模式解析不到
    服务 principal，调度器整体 no-op（路由仍应答；run-now 返回 `error`）。
  - 容错分层（单任务、单 Project、整 tick 三层）：任何一个 workspace 不可读
    都不会饿死其余任务。
  - **错过的 fire 不补**——服务宕掉的分钟永不追赶，两次 fire 也永不合并。

## 3. Agent 侧 —— `packages/transport-dsh/src/cron-plugin.ts`

第三个 per-launch 子插件（docs/adr/0011 的 patch 机制，见
docs/dsh-child-plugins.md）。它注册 `schedule_create` / `schedule_list` /
`schedule_delete` / `schedule_set_enabled`、一个 `/cron` 命令和一段
systemPrompt，教模型 5 字段语法、main-only 规则，以及"只在用户明确要求时才建
任务"。

与 HPC/worktree 插件不同，它**不**调服务：直接用共享 codec 读写任务文件——
因为**文件即真相**，agent 写的就是调度器读的，不需要 IPC。两条门控：只为真实
Project 挂载；`root` 被钉在 **main** 工作区（不是 active worktree 的 cwd），
因为服务永远只读 `<project root>/.science-studio/cron/`。

## 4. UI 侧

- `apps/web/app/api/cron/[[...path]]` 经统一代理策略转发 `/api/cron*`
  （docs/adr/0021）。
- `@science-studio/transport-client` 的 `useCronTasks` 在面板打开期间每 2s
  轮询 `GET /api/cron?projectId`（失败保留上次数组）。
- `components/studio/cron-view.tsx`（右栏分区）、
  `renderers/CronTaskRenderer.tsx`（以 tab 打开的任务文件 + 运行日志）、
  `cron-new-task-dialog.tsx`（用 codec 把 preset 生成表达式）。
- `.science-studio/cron/` 下的文件在文件树里和普通路径一样被列出。

## 端到端时序

```
用户: "每天早上九点总结实验"
  agent → schedule_create（子插件）
  → 写 <root>/.science-studio/cron/morning-summary.md        ← agent 的份到此为止
服务 CronScheduler（30s tick，全程无 agent 进程参与）:
  → 重读文件 → matchesSchedule("0 9 * * *", now)
  → 抢 activeRuns[tenant:sessionId] → adapter.run(add-message prompt)
  → Run 落 record · 进入 Session transcript · 经 SSE 推给打开的 UI
  → 追加 "## <at> · success" 到 <id>.log.md
UI: useCronTasks 看到 lastRun 更新
```

## 被明说的取舍（源自 docs/adr/0017）

- 时钟在服务而不在子进程：child 是 per-Project、惰性启动、重启即死，而任务
  必须能在"该项目自启动以来没人 prompt 过"时照样触发。
- 不做成 record 实体：v1 record 保持 Project/Session/Run（docs/adr/0007），
  且文件形态让任务对 agent 自己的 cwd 始终可见。
- `skipped-busy` 的 fire 只留下一行日志，所以比 Session 实际 run 节奏更密的
  调度会**静默丢 fire**。
- `.science-studio/` 自此是每个 Project 工作区里的产品自有命名空间（与
  Project Scaffold 共享，docs/adr/0012）；删除 Project 时整个工作区进回收站
  （docs/adr/0014），cron 文件随它去。

## 验证

`packages/cron/test/`（codec、语法、日志）、
`services/transport-service/test/cron-{store,routes,scheduler}.test.ts`、
`packages/transport-dsh/test/cron-{plugin,launch,main-root}.test.ts`。
