# AgentFlow

**多 Agent 开发流程编排平台** —— 把「需求 → 实现 → 验证」的软件流程交给一组**角色 Agent**（PM / 开发 / 测试）自动流转。

一个带 **append-only 事件存储**的编排内核持有唯一状态真相，Claude Code CLI 作为可插拔执行引擎，Web 管理台实时观测进度、产物与成本。

![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)
![tests](https://img.shields.io/badge/src%20suite-294%20passed-brightgreen)
![phase](https://img.shields.io/badge/phase-2%20进行中-orange)

---

## 设计原则：为什么不是「让 Agent 自由对话」

多 Agent 系统最常见的失败模式，是让几个模型在群里互相喊话——上下文爆炸、责任不清、失败后无从复盘。
AgentFlow 的做法相反：**角色之间零自由对话**，只通过三条通道传递信息。

| 通道 | 作用 | 是否权威 |
| --- | --- | --- |
| **结构化产物（Artifact）事件总线** | 上游把结论写成带 JSON Schema 的产物，下游只拿到**摘要** | ✅ 唯一权威 |
| **git 工作区** | 真实代码改动；并行节点各跑独立 worktree，按 `owns` 归属合并 | 事实 |
| **受限问答** | 白名单式的澄清请求，不是自由聊天 | 辅助 |

谁该在什么时候接手，由**边条件**（`when` 表达式）决定，而不是靠模型互相喊话。

---

## 核心特性

- **产物即契约** —— 每个节点必须产出结构化 Artifact（`requirement` / `code_diff` / `test_report` / `work_package_plan` …），
  经 JSON Schema 校验通过才落库；下游只拿摘要，**payload 正文永不进 prompt**（控制上下文膨胀）。
- **流转可解释** —— 每次跳转都落一条 `transfer.decided` 事件，记录「从哪到哪 + 命中哪条边条件 + 判定依据」。
- **事件溯源** —— 所有状态变化都是 append-only 事件；`TaskState` 由 `project()` 投影得出，服务重启不丢状态，可完整复盘。
- **并发 + 隔离 + 确定性合并** —— 就绪节点按批次并发（受 `AGENTFLOW_GLOBAL_CONCURRENCY` 约束）；
  并发批次内自动为每个节点开独立 git worktree，批次结束后按 `owns` 归属**确定性合并**回主工作区。
- **`owns` 路径闸门** —— 节点结束后内核核对工作区**实际变更路径**，越界即落 `artifact.invalidated` 并把节点判为 `failed`，不静默继续；
  同批次启动前还会做 `owns` 占用检查（重叠时按策略退化为串行或拒绝）。
- **失败即熔断** —— CLI 非零退出 / 无结构化产出 / 载荷不合规 / 超过 wall-clock / 同节点反复进入，都会 `node.failed` + `task.failed`，不留半成品状态。
- **停滞自动停止** —— 子进程连续 N 毫秒**没有任何输出**即判定卡死，SIGKILL 并按失败处理。
  计的是「距最后一次输出」而非「总耗时」，**持续输出的长任务不会被误杀**。
- **任务级取消** —— `POST /api/tasks/:id/cancel` 幂等；SIGTERM → 3s → SIGKILL（按进程组），终态任务零写入返回。
- **角色可编辑** —— 角色定义（`owns` / `reads` / `model` / `max_wall_time_ms`）在配置里，管理台可直接查看与编辑（校验失败 422 且不落盘）。

---

## 架构

```
POST /api/tasks
      │
      ▼
┌──────────────────────────────────────────────────────────────────┐
│  编排内核  src/kernel/                                            │
│                                                                  │
│   调度器       就绪节点批次 ──► 并发上限 / owns 占用检查            │
│      │                                                           │
│      ├─► 上下文装配   产物摘要 → prompt（超限整体丢弃最早的摘要）    │
│      ├─► Runner       claude-code CLI（spawn，detached 进程组）    │
│      ├─► 路径闸门     核对实际变更是否越出 owns                    │
│      ├─► 合并器       并行批次各 worktree 改动确定性合并回主工作区   │
│      └─► 状态机       成功 / 失败熔断 / 取消 / 停滞自动终止         │
│                                                                  │
│   一切状态变化 → append-only 事件存储（SQLite）                    │
│                        │                                         │
│                        └─► project() 投影 ──► TaskState           │
└──────────────────────────────────────────────────────────────────┘
      │
      ▼
Web 管理台：任务列表 / 状态条 / 流程 DAG / 节点 · 角色 · 日志 · 产物 · 事件
```

**分层**：

| 层 | 目录 | 职责 |
| --- | --- | --- |
| 编排内核 | `src/kernel/` | 事件存储、投影、状态机、调度、受限表达式、事实构建、上下文装配、路径闸门、合并 |
| 执行引擎 | `src/runner/` | Runner 适配器：`claude-code`（真实）/ `fake`（测试替身）/ 归一化事件契约 |
| 接入层 | `src/server/` | Fastify HTTP + WebSocket |
| 配置 | `src/config/` | `.env` 与角色 / 工作流加载（含 zod schema 校验） |
| 领域模型 | `src/shared/` | 领域类型、Artifact schema、事件类型 |
| 管理台 | `web/` | React 18 + Vite（独立 `package.json`，**零额外运行时依赖**） |

---

## 快速开始

**前置**：Node ≥ 22、`claude` CLI 已安装并登录（`claude --version` 能正常输出）。

> ⚠️ 真实调用会产生**真实费用**。

```bash
npm install
cp .env.example .env
npm start                 # 后端，默认 http://127.0.0.1:8787
```

管理台（另开一个终端）：

```bash
npm --prefix web install
npm --prefix web run dev  # http://127.0.0.1:5173（/api、/ws 自动代理到 8787）
```

创建任务：

```bash
curl -X POST http://127.0.0.1:8787/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"演示","requirementRaw":"在目标仓库新增 scripts/hello.sh，输出 hello agentflow"}'
```

### ⚠️ 启动目录就是「目标仓库」（必读）

内核的 `repoPath` 取**当前工作目录**（`src/main.ts` 的 `process.cwd()`）。
而开发节点（如 `dev_implement`）**拥有真实写权限**，所以：

> **不要把平台指向本仓库自己的源码树。** 某次真实运行就是这么做的，结果 agent 改写了平台自身
> （在仓库根留下 `README.md` / `scripts/hello.sh` / `tests/hello-script.test.ts`），且任务仍然正常 `completed`。
> 要跑真实任务，请**在一个独立的临时仓库目录里启动**，用 `AGENTFLOW_CONFIG_DIR` 指回本仓库的 `config/`。

端到端冒烟脚本已经按这个模式实现，可直接参考或直接使用它。

---

## 管理台

三层信息架构，每一层回答一个明确的问题：

| 位置 | 回答的问题 |
| --- | --- |
| **左 · 任务列表** | 有哪些任务、各自到哪一步了 |
| **中上 · 状态条** | 当前阶段 / 活跃节点 / 已花 / 耗时 / 流程健康 / 失败原因分类 / 停滞处置 |
| **中中 · 流程 DAG** | 走到哪了、谁在跑、在等谁、**当前在做什么操作、已运行多久** |
| **下 · 二级 tab** | 节点明细 · 角色与花费 · 日志 · 产物 · 事件 |

流程 DAG 是**零依赖自研布局**（最长路径分层 + 松弛收敛），SVG 画边 + HTML 绝对定位画节点，支持并发高亮、join 等待提示、失败原因直显。

**停滞处置前置**：节点长时间无输出时，DAG 节点与状态条会同时显示「已 X 无输出」、
「连续多久无输出会被自动终止」的**如实说明**（后端未声明该能力时会明确说"需手动停止"，绝不谎报），
并提供「立即停止任务」入口——不需要你去翻日志找线索。

---

## 配置

所有配置走 `.env`（模板见 [.env.example](.env.example)），**不硬编码路径与凭据**。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENTFLOW_DB_PATH` | `./data/agentflow.sqlite` | 事件库（SQLite，append-only） |
| `AGENTFLOW_LOG_DIR` | `./logs` | 运行日志根目录（`logs/runs/<runId>.jsonl`） |
| `AGENTFLOW_WORKSPACE_DIR` | `./workspaces` | 工作区根目录（并行节点的 git worktree 落点） |
| `AGENTFLOW_CONFIG_DIR` | `./config` | 角色 / 提示词 / 工作流定义 |
| `AGENTFLOW_WORKFLOW` | `simple_dev` | 启动时加载的工作流 id（对应 `config/workflows/<id>.yaml`） |
| `AGENTFLOW_HOST` / `AGENTFLOW_PORT` | `127.0.0.1` / `8787` | 服务监听地址 |
| `AGENTFLOW_MAX_PROMPT_TOKENS` | `30000` | prompt 装配上限，超限时**整体丢弃**最早产出的产物摘要（不做截断） |
| `AGENTFLOW_GLOBAL_CONCURRENCY` | `4` | 全局并发上限；`1` = 串行（默认行为不变） |
| `AGENTFLOW_BATCH_CONFLICT_POLICY` | `serialize` | 并行批次内 `owns` 重叠时：`serialize` 改为串行 / `reject` 拒绝该批次 |
| `AGENTFLOW_NODE_STALL_TIMEOUT_MS` | `600000` | 节点连续无输出即自动终止（`0` = 关闭该保护） |
| `AGENTFLOW_CLAUDE_BIN` / `AGENTFLOW_CODEX_BIN` | `claude` / `codex` | CLI 路径 |

**角色与流程都在配置里，不在代码里**：

- **角色** `config/roles/*.yaml` —— `owns`（写边界）/ `reads`（读范围）/ `model` / `max_wall_time_ms`，配套提示词 `config/prompts/*.md`。
  内置 6 个角色：`pm`、`pm_planner`、`backend_dev`、`backend_dev_module_a`、`backend_dev_module_b`、`qa_engineer`。
- **工作流** `config/workflows/*.yaml` —— 节点 `consumes` / `produces` / `isolate`，边 `when` 条件表达式 + `on_missing` 失败语义。
  - `simple_dev`：串行基线，`pm_analyze → dev_implement → qa_verify`
  - `parallel_dev`：PM 拆解工作包 → **扇出两个开发节点并行** → join 到测试节点

> 节点的 `consumes` / `produces` 是**派生**字段，权威来源是角色 yaml 的 `inputs` / `outputs`；二者不一致时**加载期报错**。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（含 `features` 能力声明与 `claudeProcesses`） |
| POST | `/api/tasks` | 创建任务并异步推进（立即返回 `taskId`） |
| GET | `/api/tasks` | 任务列表（**从事件库聚合**，服务重启不丢） |
| GET | `/api/tasks/:taskId` | 任务状态（投影结果） |
| GET | `/api/tasks/:taskId/events` | 完整事件流 |
| GET | `/api/tasks/:taskId/flow` | 流程视图：节点状态 / 依赖 / 耗时 / 花费 / 当前动作 |
| GET | `/api/tasks/:taskId/roles` | 本任务各角色的使用情况与花费 |
| POST | `/api/tasks/:taskId/cancel` | 取消任务（幂等） |
| GET | `/api/roles` · `/api/roles/:roleId` | 角色清单 / 单个角色定义 |
| PUT | `/api/roles/:roleId` | 编辑角色定义（校验失败 422，不落盘） |
| GET | `/api/tasks/:taskId/nodes/:nodeId/log?tail=N` | 节点日志尾部（`tail` 钳制在 1–2000） |
| GET | `/api/tasks/:taskId/runs/:runId/log?tail=N` | 按 runId 取日志（运行中节点的回退入口） |
| WS | `/ws` | 目前仅在任务结束 / 出错时推送最终状态，**不是逐事件流** |

`/api/health` 的 `features` 用于**前后端能力协商**：管理台据此判断后端是否落后于前端，并对缺失能力给出明确提示，
而不是静默降级或误报。

日志端点对数据驱动的路径做了**目录穿越防护**（解析后必须落在日志根目录内，越界返回 400 且不读文件）。

---

## 目录结构

```
src/
├── kernel/     编排内核：事件存储 / 重放投影 / 状态机 / 受限表达式 / 事实构建 / 上下文装配 / 调度 / 路径闸门 / 合并
├── runner/     Runner 适配器：claude-code（真实）/ fake（测试替身）/ 归一化事件契约
├── server/     Fastify HTTP + WebSocket
├── config/     .env 与角色/工作流加载（含 schema 校验）
├── shared/     领域类型、Artifact schema、事件类型
├── website/    纯静态落地页（零依赖、零构建，见其 README）
└── main.ts     进程入口与装配
web/            管理台（React + Vite，独立 package.json）
config/         角色 / 提示词 / 工作流定义
tests/          单测 fixture 与 tests/e2e 冒烟脚本
spikes/         Phase 0 CLI 行为探针与实测结论
docs/           架构设计 spec 与分阶段实现计划
记录.md          工作日志（已完成 / 下一步 / 未完成 / 阻塞）
```

---

## 测试

```bash
npx vitest run src    # 平台自身套件：294 passed / 22 files
npm test              # 全量（额外包含 tests/website/ 落地页套件）
npm run typecheck     # tsc --noEmit
bash tests/e2e/smoke.sh   # 端到端：真实调用 claude、真实费用
```

单元测试全部用 **Fake Runner 打桩，零真实 CLI 调用、零费用**。

> `tests/website/` 是一个**独立的纯静态落地页交付物**，其套件要求站点位于仓库根的 `website/` 目录，
> 而当前实际落在 `src/` 下，因此有 3 条既有失败（AC2 / AC6）。**与本平台实现无关**，尚未处理。

冒烟脚本的设计要点（细节见 [tests/e2e/README.md](tests/e2e/README.md)）：

- 自己在 `/tmp` 下建**临时 git 仓库**并把它设为目标仓库，跑完打印「目标仓库被改了哪些文件」与「本仓库是否干净」
- 通过标准：3 个 `node.succeeded`、最终 `completed`、3 个 Artifact、`log_ref` 指向的文件真实存在
- **会产生真实费用**，所以没有纳入 `npm test`

---

## ⚠️ 安全须知

1. **有写权限的角色是真能写文件的**（headless 下用预授权工具白名单，没有人工审批环节）。
   而且要清楚该白名单的**实际授权面比看起来宽**：shell 前缀白名单等价于「可执行任意命令」，
   且六类前缀之外的命令会被反复拒绝、白白烧钱。
   **跑真实任务务必隔离目标仓库。**
2. **`owns` 路径闸门是内核侧闸门，不是文件系统级安全边界**。它在节点结束后核对工作区实际变更路径，越界即判 `failed`，
   但 CLI 层的 `--allowed-tools` 本身无路径约束、授权面很宽（见第 1 条）。
   所以真正把「agent 只能改目标仓库」这件事兜住的，仍然是**在独立临时仓库里跑**。
3. **单节点没有预算上限**：`RunRequest.budgetCapUsd` 已支持映射到 `--max-budget-usd`，但目前无人赋值。
   真实案例：带权限缺陷的那一轮，被拒命令被反复重试，单节点烧掉 **$2.20**、两次失败共 **$3.40**。跑之前请自己看好成本。
4. **`--json-schema` 在请求持续失败时会让 CLI 空转不退出**，因此 runner 始终带 wall-clock 超时 + 停滞检测 + 按进程组 kill。
   **这两层保护不要删。**

---

## 能力边界（诚实清单）

| 项 | 现状 |
| --- | --- |
| **并发调度** | ✅ 已实现。就绪节点按批次并发，受 `AGENTFLOW_GLOBAL_CONCURRENCY` 约束；`1` = 串行 |
| **工作区隔离与合并** | ✅ 已实现。并发批次自动开 git worktree，批次结束后按 `owns` 归属确定性合并回主工作区 |
| **`owns` 路径级强制** | ✅ 已实现。越界落 `artifact.invalidated` + 节点 `failed`；同批次启动前做占用检查 |
| **任务级取消** | ✅ 已实现。幂等，SIGTERM → 3s → SIGKILL（按进程组）；**不回收已花费用、不撤销已写改动** |
| **停滞自动停止** | ✅ 已实现。按「距最后一次输出」计时，可经环境变量关闭 |
| **Codex Runner** | ❌ 未实现。Codex CLI 探针未跑通（请求不返回），其输出流结构仍未验证 |
| **单节点预算上限** | ❌ 未接线。`budgetCapUsd` 无赋值方，`--max-budget-usd` 不会传给 CLI |
| **`on_missing` 边语义** | ⚠️ 仅声明式。schema 已强制校验取值（`fail` / `wait`），但内核尚未消费该字段 |
| **WS 实时性** | ⚠️ 仅任务结束时推最终状态，不推逐事件增量（管理台用轮询补足） |
| **评审角色 / G0–G3 卡点** | ❌ 规划中 |

---

## 路线图

- **Phase 1** ✅ 串行三节点流水线跑通、事件溯源内核、产物契约、管理台
- **Phase 2** 🚧 并发调度与 worktree 隔离合并、`owns` 路径闸门、任务取消、停滞自动停止、角色可编辑、流程 DAG
- **Phase 3** 📋 评审角色与卡点（G0–G3）、单节点预算上限、Codex Runner、多档 profile

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [记录.md](记录.md) | 工作日志：已完成 / 下一步 / 未完成 / 阻塞、每次实测数据与踩坑 |
| [架构设计 spec](docs/superpowers/specs/2026-09-18-multi-agent-dev-orchestration-design.md) | 设计决策、原则、分层、路线图 |
| [Phase 0/1 实现计划](docs/superpowers/plans/2026-09-18-agentflow-phase0-phase1.md) | 逐任务实现步骤与验收标准 |
| [Phase 2 需求](docs/superpowers/specs/2026-09-19-agentflow-phase2-requirements.md) | 并发、隔离、闸门等第二阶段需求 |
| [CLI 探针实测结论](spikes/cli-probe/README.md) | Claude/Codex CLI 的真实行为、参数取舍与陷阱 |
| [端到端冒烟说明](tests/e2e/README.md) | 前置条件、通过标准、安全前提 |

---

## License

[MIT](LICENSE) © 2026 40kuai
