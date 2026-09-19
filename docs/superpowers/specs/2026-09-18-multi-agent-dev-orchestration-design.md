# AgentFlow — 多 Agent 开发流程编排平台 · 架构设计

- 状态：待评审
- 日期：2026-09-18
- 项目根目录：`/Users/40kuai/Documents/多agent开发流程`

---

## 1. 背景与问题定义

### 1.1 真实痛点

在多角色协作的开发流程中，角色之间**无法自动流转**，表现为：

1. **无唯一事实来源**——每个角色只知道自己手上的事，没人持有全局状态，判断"下一步该谁做"要靠人。
2. **无交接契约**——上游产出以自然语言散落，下游需要什么、产出什么格式全靠默契，导致反复返工。
3. **无终止条件**——一旦允许角色自由对话，容易陷入互相追问的死循环，且成本不可控。
4. **不可观测**——任务卡住时，无法回答"卡在谁身上、为什么卡、已消耗多少"。

### 1.2 根因判断

**把 agent 当"人"来协调**是根因。人类协作靠对话和默契，agent 协作必须靠**结构化契约 + 显式状态机 + 唯一状态真相**。

### 1.3 本设计的主张

> 角色之间**零自由对话**。信息只通过三个明确定义的通道流转，其中只有一个决定流程走向。

---

## 2. 目标与非目标

### 2.1 目标

1. 一个需求输入后，多个角色能**自动流转**完成"立项 → 需求 → 设计 → 编码 → 测试 → 评审 → 集成 → 发布 → 验收"全流程。
2. 支持**尽可能并行**：并行度由工作包拆解自然决定，而非调度器硬凑。
3. 提供**实时观测页面**：看到任务进度、流转路径、当前谁在干活、成本消耗。
4. 在**关键节点提供人工卡点**（G3），高风险动作必须真人批准。
5. 全流程**可回溯、可重放**：任何状态都能回答"为什么走到这一步"。

### 2.2 非目标（本期明确不做）

| 非目标 | 理由 |
| --- | --- |
| 分布式多机调度 | 单机事件库 + 本地 worktree 已满足需求，分布式是过早优化 |
| 自研 LLM 工具调用循环 | 复用 `claude` / `codex` CLI，不重写 agent runtime |
| 通用工作流引擎（任意 DAG 脚本） | 转移条件用**受限表达式**，不做图灵完备脚本，避免复杂度失控 |
| 图形化流程编辑器 | 流程定义用 YAML，页面只做**观测**，不做编辑 |
| Speculative Execution（多方案并行择优） | 成本翻倍，收益不确定，列为远期可选项 |
| 多人协同 / 账号体系 | 单用户本地平台，无鉴权需求（仅绑定 127.0.0.1） |

---

## 3. 三条决定性设计原则

这三条贯穿全文，是后续所有设计取舍的判据。

### 原则一：唯一状态真相在内核，不在 agent

所有状态变更都是**追加事件**（append-only event）。任务的"当前状态"是事件重放的**投影**，不是某个 agent 的记忆。
→ 带来可回溯、可重放、可精确复现"为什么走到这一步"。

### 原则二：角色间零自由对话，只交换结构化产物

每个角色声明 `inputs: Artifact[]` 和 `outputs: Artifact[]`。产物落库后由状态机判定下一跳。
→ 责任链清晰，不靠 agent 自觉；成本可控；不会陷入互相追问的死循环。

**唯一的例外是"受限问答"（见 8.3）**：单轮、只读工具、token 上限极小，且回答必须以 Artifact 形式落库。
它是被内核严格约束的一次性查询，不是自由对话，因此不违反本原则。

### 原则三：大内容不进 prompt，只进引用

Artifact 的 `summary`（≤500 token）进下游 prompt，正文只以 `refs` 引用，需要细节时 agent 自己去工作区读。
→ 解决上下文爆炸与信息丢失。这是多 agent 协作里最容易踩的坑。

---

## 4. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  观测前端 (React + Vite)                                       │
│  任务总览 │ DAG泳道图 │ 实时日志 │ 人工卡点队列 │ 组织视图 │ 成本面板 │
└──────────────────────┬───────────────────────────────────────┘
                       │ WebSocket（只读推送）+ HTTP（审批动作）
┌──────────────────────┴───────────────────────────────────────┐
│  编排内核 Orchestrator Kernel                                  │
│  ┌────────────┬─────────────┬──────────────┬───────────────┐  │
│  │ 状态机      │ 调度器       │ 决策器        │ 上下文装配器    │  │
│  │ StateMachine│ Scheduler  │ Decider      │ Assembler     │  │
│  ├────────────┼─────────────┼──────────────┼───────────────┤  │
│  │ 事件存储     │ 投影器       │ 卡点闸门      │ 工作区管理器    │  │
│  │ EventStore │ Projector   │ GateKeeper   │ WorkspaceMgr  │  │
│  └────────────┴─────────────┴──────────────┴───────────────┘  │
└───────┬──────────────────────────────────┬───────────────────┘
        │ append-only                      │ spawn / cancel
┌───────┴──────────┐          ┌────────────┴───────────────────┐
│ SQLite           │          │ Runner Pool                     │
│  events (真源)    │          │  claude-code adapter            │
│  projections     │          │  codex adapter                  │
│  logs/ (引用)     │          │  git worktree 池                │
└──────────────────┘          └────────────────────────────────┘
```

**分层职责**：

| 层 | 职责 | 关键约束 |
| --- | --- | --- |
| 观测前端 | 只读展示 + G3 审批动作 | 不做业务决策，不含流程逻辑 |
| 编排内核 | 状态推进、调度、决策、装配 prompt、管卡点 | 唯一状态真相持有者 |
| Runner Pool | 把角色翻译成 CLI 调用，采集产出 | 引擎无关的归一化事件流 |
| 存储 | 事件真源 + 投影 + 日志文件 | 事件只追加，不修改 |

---

## 5. 领域模型

### 5.1 核心实体

```
Task（一次需求 = 一个 Task）
 ├─ WorkPackage ×N（可并行的工作包）
 │   └─ NodeRun ×N（一次角色执行实例）
 │       └─ Artifact ×N（产出的结构化产物）
 ├─ Event ×N（append-only 状态变更）
 ├─ Gate ×N（审批卡点）
 └─ Workspace ×N（git worktree）
```

### 5.2 数据表定义

**tasks**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| task_id | TEXT PK | |
| title | TEXT | |
| requirement_raw | TEXT | 用户原始输入 |
| repo_path | TEXT | 目标仓库绝对路径 |
| base_branch | TEXT | 基线分支 |
| profile | TEXT | `full` / `lean` / `solo` |
| status | TEXT | `active` / `paused` / `completed` / `failed` / `cancelled` |
| budget_cap_usd | REAL | 全局预算上限 |
| budget_used_usd | REAL | 已消耗（由事件累加） |
| created_at / updated_at | INTEGER | epoch ms |

**work_packages**（并行度的来源）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| wp_id | TEXT PK | |
| task_id | TEXT FK | |
| name | TEXT | |
| owns | JSON | **拥有的文件路径 glob**，占位冲突检测依据 |
| reads | JSON | 只读依赖路径 |
| depends_on | JSON | 依赖的其他 wp_id |
| interface_contract | JSON | 对外接口契约（冻结后不可变） |
| serialization_key | TEXT NULL | 非空时，同 key 的 wp 强制串行 |
| status | TEXT | `declared` / `blocked` / `running` / `merged` / `conflicted` |
| branch / worktree_path | TEXT | |

**node_runs**（一次角色执行实例）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| run_id | TEXT PK | |
| task_id / wp_id | TEXT FK | |
| node_id | TEXT | 流程图中节点 id |
| role_id | TEXT | 角色模板 id |
| engine | TEXT | `claude-code` / `codex` |
| model | TEXT | |
| session_id | TEXT NULL | CLI 会话 id，用于 resume |
| attempt | INTEGER | 第几次尝试（幂等依据） |
| status | TEXT | `queued` / `running` / `waiting_gate` / `succeeded` / `failed` / `cancelled` |
| pid | INTEGER NULL | |
| exit_code | INTEGER NULL | |
| tokens_in / tokens_out | INTEGER | |
| cost_usd | REAL | |
| log_ref | TEXT | 原始日志文件路径（**日志不入事件库**） |
| started_at / ended_at | INTEGER | |

**artifacts**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| artifact_id | TEXT PK | |
| task_id / run_id | TEXT FK | |
| type | TEXT | 见 5.3 |
| status | TEXT | `ok` / `needs_changes` / `blocked` |
| schema_version | INTEGER | |
| payload | JSON | 按 type 有各自 JSON Schema |
| refs | JSON | `[{kind: file\|commit\|artifact, uri}]` |
| summary | TEXT | ≤500 token，**唯一进下游 prompt 的部分** |
| created_at | INTEGER | |

**events**（唯一状态真相，只追加）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| seq | INTEGER PK AUTOINCREMENT | 全局单调序号 |
| event_id | TEXT UNIQUE | |
| task_id | TEXT | |
| type | TEXT | 见 6.1 |
| payload | JSON | |
| actor | TEXT | `kernel` / `role:<id>` / `human` |
| created_at | INTEGER | |

**gates**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| gate_id | TEXT PK | |
| task_id / node_id | TEXT | |
| level | TEXT | `G1` / `G2` / `G3` |
| required_approvers | JSON | 角色 id 列表（G3 为 `["human"]`） |
| decisions | JSON | `[{approver, decision, rationale, at}]` |
| policy | TEXT | `all` / `quorum` / `any` |
| status | TEXT | `open` / `approved` / `rejected` / `expired` |

**leases**（进程存活守卫）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| run_id | TEXT PK | |
| pid | INTEGER | |
| heartbeat_at | INTEGER | |
| ttl_ms | INTEGER | 超时判定失败 |

**投影表**：`task_state`（当前活跃节点、进度百分比）、`node_state`（每节点最新状态）。投影表**可从 events 完整重建**，随时可丢弃。

### 5.3 Artifact 类型与 payload 契约

| type | 产出者 | payload 关键字段 | status 语义 |
| --- | --- | --- | --- |
| `requirement` | PM | `problem, goals[], non_goals[], acceptance_criteria[], constraints[]` | ok / blocked（需求本身有歧义需澄清） |
| `work_package_plan` | PM | `packages[{id,name,owns[],reads[],depends_on[],interface_contract,acceptance_refs[]}]` | ok |
| `design` | 架构师 | `wp_id, approach, files_touched[], interfaces[], risks[], decisions[]` | ok / needs_changes |
| `code_diff` | 开发 | `wp_id, branch, commits[], files_changed, insertions, deletions, self_test_result` | ok / blocked |
| `test_report` | 测试 | `wp_id, suites[], passed, failed, failures[{test,reason}], coverage` | ok / needs_changes（有失败用例） |
| `review` | 评审员 | `target_run_id, dimension, verdict, issues[{severity,file,line,message,suggestion}]` | ok（通过）/ needs_changes |
| `clarification` | 任意 | `question, context_refs[], answer, answered_by` | ok |
| `conflict_report` | Integrator | `wp_ids[], files[], resolution, unresolved[]` | ok / blocked |
| `gate_decision` | 任意审批者 | `gate_id, decision, rationale` | — |
| `summary` | 任意 | `key_points[]` | 用于上下文压缩 |

**所有 payload 用 zod 定义，并可导出 JSON Schema**——这份 schema 直接作为 `claude --json-schema` 的参数，把产物格式**下沉到 CLI 层强制**，而不是"求 agent 按格式输出"。

---

## 6. 事件与投影

### 6.1 事件类型清单

```
task.created / task.profile_changed / task.cancelled / task.completed / task.failed
wp.declared / wp.started / wp.merged / wp.blocked
node.queued / node.started / node.succeeded / node.failed / node.cancelled
node.retry_scheduled / node.escalated / node.usage_recorded
artifact.created / artifact.invalidated
gate.opened / gate.decision_recorded / gate.closed
transfer.decided            # 携带 reason + decided_by: rule|llm|human
clarification.requested / clarification.answered
workspace.allocated / workspace.released / workspace.conflict_detected
budget.consumed / budget.exceeded
lease.acquired / lease.heartbeat / lease.expired
```

### 6.2 两条重要约束

**① 原始日志不进事件库。**
CLI 的 stdout 流式输出可能达到 MB 级。做法：原始输出写到 `logs/runs/<run_id>.jsonl`，事件库只记 `log_ref` 引用 + 从流中抽取的结构化 `node.usage_recorded`。
→ 事件库保持小而快，前端要日志时按需读文件流。

**② `transfer.decided` 必须记录理由和决策来源。**
每条转移都写明 `reason` 和 `decided_by`（规则 / LLM / 人工）。这是"可回答为什么走到这一步"的落点，也是调试的核心凭据。

---

## 7. 角色体系

### 7.1 核心机制：角色模板 + 实例池

**"多个开发"不是预定义 `dev_1..dev_5`，而是一个角色模板按工作包数量动态 spawn 并发实例。**
`backend_dev` 是模板，3 个工作包 → 3 个并发实例。并发度由工作包数量自然决定，无需手工维护个体。

### 7.2 角色定义（声明式，非代码）

```yaml
# config/roles/backend_dev.yaml
id: backend_dev
display_name: 后端开发
layer: engineering
engine: claude-code
model: sonnet
system_prompt_ref: prompts/backend_dev.md
inputs:  [design, work_package_plan]
outputs: [code_diff]
scope:
  owns:  ["src/server/**"]      # 设计意图：不许改 owns 之外的路径（Phase 1 未实现强制，见下方注）
  reads: ["docs/**", "src/shared/**"]
tools: [read, edit, write, bash]
budget: { max_tokens: 200000, max_wall_time_ms: 1800000, max_retries: 2 }
triggers:
  - on: wp.declared
    when: "wp.layer == 'backend'"
```

> **Phase 1 实现修正（2026-09-19 终审同步，绑定权威）**：`owns` 在 Phase 1 **零强制**，上一行注释里的「不许改」名不副实。
> 实况：`owns` 只作为 prompt 里的一句话出现（`src/kernel/context-assembler.ts` 的硬约束段落）；CLI 层**全量放行**
> （`--allowed-tools` 不含任何按路径的约束，见 §11.3），内核层**无变更路径核对**，`artifact.invalidated` 事件**全仓无生产者**。
> 端到端已实测越界：`config/roles/backend_dev.yaml` 的 `owns` 是 `["src/**"]`，而 agent 真实写了 `README.md` 与 `scripts/hello.sh`，
> 任务仍正常 `completed`。**路径级强制（调度前占用检查 + 越界写记 `artifact.invalidated`）属 Phase 2**；
> 在此之前 `owns` 只是提示词层面的建议，**不得当作安全边界**。

### 7.3 默认组织架构（完整公司）

| 层级 | 角色 id | 职责 | 激活触发器 | 默认引擎 |
| --- | --- | --- | --- | --- |
| 决策 | `ceo` | 立项裁定、范围变更、预算超限、最终验收 | **仅 4 处 G3** | 强模型 + 只读 |
| 决策 | `cto` | 架构裁决、技术选型、跨包冲突仲裁 | 架构冻结 / 冲突 / 技术验收 | 强模型 + 只读 |
| 产品 | `pm` | 需求分析、**工作包拆解**、验收标准 | 需求阶段 + 工作包验收 | 强模型 + 只读 |
| 产品 | `ux_designer` | 交互与视觉规范 | 含 UI 的工作包 | 强模型 + 只读 |
| 技术 | `architect` | 系统设计、**接口契约冻结**、模块划分 | 设计阶段 + 契约变更 | claude-code |
| 开发 | `backend_dev` | 后端实现 + 自测 | 后端工作包 | claude-code / codex |
| 开发 | `frontend_dev` | 前端实现 + 自测 | 前端工作包 | claude-code / codex |
| 质量 | `qa_engineer` | 单测 / 集成 / E2E、缺陷报告 | 编码完成 + 集成阶段 | claude-code |
| 质量 | `reviewer_tech` | 技术维度评审 | 工作包提交后 | 调度时动态（与产出方引擎不同，见 11.4） |
| 质量 | `reviewer_cross` | 跨职能视角评审 | 工作包提交后 | 调度时动态（与产出方及另一评审均不同） |
| 交付 | `integrator` | 并行分支合并与冲突解决 | 每个 join 点 | claude-code |
| 交付 | `devops` | CI、构建、部署 | 合并后 + 发布 | bash 类工具 |
| 平台 | `orchestrator` | 编排内核（非人，以节点形式出现在图里） | 持续 | 规则引擎 + LLM 兜底 |

### 7.4 关键设计：激活触发器防止成本爆炸

**CEO 全程只出现在 4 个 G3 节点，不参与任何中间环节。** 否则一个需求会烧掉几十倍 token，且流程被拖成串行。

### 7.5 卡点级别

| 级别 | 含义 | 阻塞性 | 默认用于 |
| --- | --- | --- | --- |
| `G0` | 规则自动通过，无角色介入 | 不阻塞 | 单测通过即下一跳 |
| `G1` | 单角色审批，输出 ok / needs_changes | 不阻塞（agent 自动决策） | 代码评审 |
| `G2` | 多角色会签，策略 `all` / `quorum(n)` | 不阻塞（agent 自动决策） | 架构冻结、分支合并、验收 |
| `G3` | **真人审批，流程挂起等待** | 阻塞 | CEO 立项、预算超限、上线发布、最终验收 |

### 7.6 三档 profile

| profile | 角色集 | 适用 |
| --- | --- | --- |
| `full` | 全部 12 角色（含 `ux_designer`），评审 2 人（强制交叉引擎），CEO 全部 4 个 G3 | 正式项目 |
| `lean` | 去掉 `ux_designer`，`ceo` 降为 G0 自动，评审 1 人，G3 仅保留"上线发布" | 日常开发 |
| `solo` | 仅 `backend_dev` + `qa_engineer` + 1 评审，无 G3 | 快速实验 / 小改动 |

profile 是**角色集的过滤视图 + gate 级别覆写**，不改流程拓扑。

---

## 8. 信息流转协议（三条通道）

### 8.1 通道一（权威）：Artifact 事件总线

角色不互发消息，各自产出 Artifact 落库 → 产生事件 → 状态机判定下一跳。**这是唯一决定流程走向的通道。**

### 8.2 通道二：git 工作区

代码不通过 prompt 传递，通过 worktree / branch 传递。agent 直接用 CLI 文件工具读写工作区，内核只记录 commit 引用。

### 8.3 通道三（例外）：受限问答

下游确实需要上游澄清时，**不允许自由对话**，而是发出 `clarification.requested` 事件，内核把上游 agent 以**单轮、只读工具、token 上限极小**的模式拉起应答，回答作为新 Artifact 追加。

约束：
- 单轮，无追问链
- 只读工具（`--tools "Read,Grep,Glob"`）
- 单次上限（默认 20k token）
- 同一 run 最多触发 2 次澄清，超出则升级 G3

### 8.4 Prompt 装配规则（上下文装配器）

```
prompt = 角色 system_prompt（职责 / 边界 / 产出要求）
       + Task 概要（title + 原始需求摘要）
       + 输入 Artifact 的 summary + refs（不内联正文）
       + 工作区路径 + 接口契约（冻结版本）
       + 产出要求（目标 artifact type + 其 JSON Schema）
       + 硬约束：不许修改 owns 之外的路径
```

**硬性规则：装配后 prompt 有 token 上限（默认 30k）。超限时按 refs 引用降级，绝不做截断**——截断是信息丢失的头号来源。

### 8.5 Shared Context Bundle（并行一致性保障）

并行分支需要同一份事实。内容：接口契约、编码规范、项目结构、术语表。

- 路径：`data/context/<task_id>/bundle-v<N>/`
- **版本化**：契约变更 → 新版本；已在跑的并行分支**不自动升级**
- join 时由 `integrator` 检查版本漂移，漂移则生成 `conflict_report`

---

## 9. 工作流状态机与流转决策

### 9.1 节点类型

| 类型 | 语义 |
| --- | --- |
| `task` | 单角色执行一个 NodeRun |
| `parallel` | Fan-out：按工作包 spawn N 个子节点 |
| `join` | Fan-in：策略 `all` / `any` / `quorum(n)` / `first_success` |
| `gate` | 审批节点（G0–G3） |
| `decision` | LLM 兜底决策节点 |
| `end` | 终止 |

### 9.2 转移条件：受限表达式（刻意不做图灵完备）

**可用事实（facts）**：

```
artifacts.<type>.status          # ok | needs_changes | blocked
artifacts.<type>.count
reviews.verdicts[]               # approve | reject
reviews.issue_count.severity     # critical | major | minor
tests.failed / tests.passed
run.attempt / node.visit_count
gate.<gate_id>.status
wp.conflicted / wp.status
deps(wp).status                  # 该工作包的上游依赖状态
```

**运算符**：`all()` / `any()` / `count()` / `deps()` / `==` / `!=` / `>` / `<` / `and` / `or` / `not`

**示例**：

```yaml
- from: wp_dev_done
  to:   wp_review
  when: "all(artifacts.code_diff.status == 'ok')"

- from: wp_review
  to:   wp_merge
  when: "all(reviews.verdicts == 'approve') and reviews.issue_count.critical == 0"

- from: wp_review
  to:   wp_dev_fix
  when: "any(reviews.verdicts == 'reject') and run.attempt < 3"

- from: wp_review
  to:   gate_escalate          # 超重试预算 → 升级人工
  when: "run.attempt >= 3 or reviews.issue_count.critical > 5"
```

**刻意不做通用脚本**：转移条件是一个受限求值器，不是可执行代码。这排除了"流程逻辑本身变成 bug 来源"这一整类问题。

### 9.3 三层决策

```
① 规则求值（覆盖约 90%）
   命中 → 直接转移，decided_by = 'rule'
   ↓ 未命中
② LLM 决策器（受限枚举）
   输入：受限事实快照（不是全量上下文）
   输出：{ choice, rationale, target_role? }
   choice ∈ { continue, retry, escalate, abort, parallel_split }
   通过 --json-schema 强制输出结构
   decided_by = 'llm'
   ↓ choice == escalate 或 高风险
③ 人工卡点 G3
   挂起，等待页面审批，decided_by = 'human'
```

**LLM 决策器只能在受限枚举里选**，不能自由发明下一步。这保证了"灵活"与"可预测"的平衡。

### 9.4 防死锁机制

| 机制 | 默认值 | 行为 |
| --- | --- | --- |
| `node.max_retries` | 2 | 超出 → `node.escalated` |
| `task.loop_budget` | 单节点 10 次转移 | 超出 → 升级 G3 |
| `node.visit_count` | 检测同状态反复进入 | 反复进入 → 升级 G3 |
| 单节点 wall-clock 超时 | 30 min | 判定 failed，回收 worktree |
| 全局预算 | `task.budget_cap_usd` | 超出 → `budget.exceeded` → G3 |

**核心原则：宁可升级到人工，也不无限重试烧钱。**

---

## 10. 并行机制

### 10.1 并行度的来源：工作包拆解

**并行不是调度层硬凑的，是需求阶段就切出来的。**

`pm` 角色的产出 `work_package_plan` 必须包含每个工作包的：
- `interface_contract` —— 对外接口契约，冻结后不许改
- `owns` —— 拥有的文件路径（并行安全的基础）
- `depends_on` —— 依赖的其他工作包

→ 所以整个架构里**最关键的一个角色动作是 PM 的工作包拆解质量**。拆得差，并行度就低。

### 10.2 Fan-out / Fan-in 一等原语

状态机原生支持：

```yaml
- id: wp_fanout
  type: parallel
  over: work_packages          # 按工作包扇出
  filter: "wp.status != 'blocked' and all(deps(wp).status == 'merged')"
  body: [wp_design, wp_dev, wp_test, wp_review]
  join:
    strategy: all              # all | any | quorum(n) | first_success
    node: wp_join
```

### 10.3 冲突控制

1. **调度前占用检查**：`wp.owns` 路径重叠 → 自动加 `serialization_key` 强制串行，不为并行而并行。
2. **worktree 隔离**：每个工作包独立 worktree + 独立 branch `agentflow/<task_id>/<wp_id>`。
3. **合并冲突**：git 冲突 → 生成 `conflict_report` → 路由给 `integrator` 角色，**不让两个 agent 互相打架**。
4. **Integrator 解决不了** → `escalate` → G3。

### 10.4 Worktree 池

- 路径：`workspaces/<task_id>/<wp_id>`
- 预创建 warm worktree，任务结束回收
- 每个工作包独占一个，禁止两个实例共享同一 worktree

### 10.5 并行可视化

DAG 用**横向泳道**展示并行分支，一眼看到"此刻 N 个 agent 在同时干活"，以及卡在哪个 join 上。

---

## 11. 执行层（Runner）

### 11.1 引擎无关的归一化接口

这是执行层最重要的抽象：**内核不认识 CLI，只认识归一化事件流。**

```ts
interface AgentRunner {
  readonly id: 'claude-code' | 'codex';
  readonly capabilities: {
    structuredOutput: boolean;   // 能否强制 JSON Schema 输出
    budgetCap: boolean;          // 能否在 CLI 层限制单次花费
    sessionResume: boolean;
    builtinReview: boolean;
  };
  run(req: RunRequest): AsyncIterable<RunnerEvent>;
  cancel(runId: string): Promise<void>;
}

type RunRequest = {
  runId: string;
  prompt: string;
  systemPrompt: string;
  worktreePath: string;
  model: string;
  outputSchema?: object;         // Artifact 的 JSON Schema
  tools: string[];               // 角色允许的工具
  readOnly: boolean;
  budgetCapUsd?: number;
  wallTimeMs: number;
  sessionId?: string;            // 用于 resume
  resume?: boolean;
};

type RunnerEvent =
  | { kind: 'started';  pid: number; sessionId?: string }
  | { kind: 'log';      chunk: string }
  | { kind: 'usage';    tokensIn: number; tokensOut: number; costUsd: number }
  | { kind: 'artifact'; raw: unknown }       // 结构化产出
  | { kind: 'exited';   code: number | null };
```

→ 内核只消费 `RunnerEvent`。换引擎、CLI 升级、加第三个引擎，都不影响编排逻辑。

### 11.2 已核实的 CLI 参数映射

**claude-code adapter**（已用 `claude --help` 核实）：

| RunRequest 字段 | claude 参数 |
| --- | --- |
| headless | `-p` |
| 流式输出 | `--output-format stream-json --include-partial-messages` |
| outputSchema | `--json-schema <schema>` |
| systemPrompt | `--system-prompt <prompt>` |
| worktreePath | `--add-dir <worktree>`（cwd 设为 worktree） |
| model | `--model <model>` / `--fallback-model` |
| tools | `--tools "Read,Edit,Write,Bash"` 或 `--allowed-tools` / `--disallowed-tools` |
| readOnly | `--permission-mode default` + `--tools "Read,Grep,Glob"` |
| 编码写权限 | `--permission-mode acceptEdits` |
| budgetCapUsd | `--max-budget-usd <amount>` |
| sessionId / resume | `--session-id <uuid>` / `--resume` / `--fork-session` |

**codex adapter**（已用 `codex exec --help`、`codex review --help` 核实）：

| RunRequest 字段 | codex 参数 |
| --- | --- |
| headless | `codex exec`（prompt 走参数或 stdin） |
| worktreePath | `-C/--cd <worktree>` |
| model | `-m/--model` |
| readOnly | `-s read-only` |
| 编码写权限 | `-s workspace-write` |
| 配置档 | `-p/--profile <name>`、`-c key=value` |
| sessionResume | `codex exec resume` |
| 内置评审 | `codex review --base <branch>` / `--uncommitted` |
| outputSchema | **不支持** → 靠 prompt 约束 + 解析容错 |
| budgetCapUsd | **不支持** → 由内核记账层兜底 |

**能力不对称是真问题**：claude 有 `--json-schema` 和 `--max-budget-usd`，codex 都没有。
→ 所以 `capabilities` 是接口的一等成员，内核按能力降级：
- 无 `structuredOutput` → 用 prompt 强约束 + JSON 提取容错 + zod 校验失败即重试一次
- 无 `budgetCap` → 由内核的 `budget` 模块记账，超限时主动 `cancel`

> **实测修正（2026-09-18，两轮实测，结论已反转一次，以本条为准）**
>
> 第一轮探针（**凭据耗尽期，所有请求 403**）观测到：`--json-schema` 会让 claude CLI **永不退出**（空转 13 分钟、
> 16,403 次 `You MUST call the StructuredOutput tool` 重试、CPU 45%~50%）。当时据此裁定「Phase 1 默认不传」。
>
> 第二轮补跑（**凭据恢复后，请求正常**）推翻了该裁定：
> - **不传** `--json-schema`：rc=0，但模型把 JSON 包进 ```` ```json ```` 代码块 → `JSON.parse` 失败 → **零 artifact**（实测 29.3s / $0.1159）
> - **传** `--json-schema`：rc=0、正常退出（实测 7.0s / 15.9s），`result.structured_output` 是 **CLI 校验过的对象**（$0.0507）
> - 即「永不退出」**不是该参数本身的 bug**，而是**请求持续失败**时 stop hook 反复注入重试导致的空转。凭据正常时不复现
>
> **因此 Phase 1 的最终行为是：默认传 `--json-schema`**，且解析层**两条通道都读、`structured_output` 优先、`result` 内的 JSON 字符串兜底**
> （只读 `structured_output` 会让未开启该参数的调用静默不产出；只读 `result` 会让开启后的调用静默不产出）。
>
> **超时必须保留**：「永不退出」那条路径依然真实存在，只是触发条件从「参数」变为「请求持续失败」。
> 且必须**按进程组 kill** —— 只杀直接子进程会留下继承 stdout 管道写端的孙进程，导致 `close` 永不触发、保护自身挂死。
>
> 连带结论（两轮均成立）：
> 1. **失败判定必须用 `is_error`，不能用 `subtype`** —— 认证失败时 `subtype` 仍为 `"success"`；
> 2. **解析层不得做字段白名单** —— 真实事件字段远多于文档样本；
> 3. **`wallTimeMs` 必须被强制实施（超时即 kill 进程组）**；
> 4. `-p` 搭配 `--output-format stream-json` 必须同时给 `--verbose`，否则无输出。
>
> 证据、可复现命令与两轮对照实测表见 `spikes/cli-probe/README.md`；真实成功样本已归档为 `tests/fixtures/claude-stream-structured-sample.jsonl`。
>
> **这条反转留一个方法论教训**：第一轮的观测环境是「所有请求都失败」，因此**无法区分**「参数本身有问题」与「参数与失败的请求路径交互不良」。
> 单环境实测不足以支撑「禁用某能力」这类结论。

> **另一条实测局限**：`--tools` / `--allowed-tools` **不约束 MCP 工具**，因此 11.3「角色权限即沙箱参数」的保证弱于本文档原意；
> 另本机 claude 走第三方代理且所有模型映射为同一模型，11.4 的「交叉引擎评审」在本机可能退化为同模型互评。

### 11.3 角色权限即沙箱参数

**安全由 CLI 强制，不靠提示词自觉。**

| 角色类别 | claude | codex |
| --- | --- | --- |
| 只读决策/评审（ceo, cto, pm, ux, reviewer） | `--tools "Read,Grep,Glob"` | `-s read-only` |
| 编码（dev, architect） | `--permission-mode acceptEdits --allowed-tools "Read,Edit,Write,Grep,Glob,Bash(npm:*)"` | `-s workspace-write` |
| 测试（qa_engineer） | `--allowed-tools "Read,Grep,Glob,Bash"` | `-s workspace-write` |
| 评审（codex 内置） | — | `codex review --base agentflow/<task>/<wp>` |
| 发布（devops） | 高风险动作**必须 G3 批准后**才执行 | `danger-full-access` 仅限人工批准后 |

> **Phase 1 实现修正（2026-09-19 终审同步，绑定权威）**：上表是设计意图，**Phase 1 的实际实现已偏离**。
> 实况如下（代码见 `src/runner/claude-code-runner.ts` 的 `buildArgs`，其注释、计划文档 Task 10 段均已如实标注，
> 本节此前是唯一未同步的一处）：
>
> 1. **可写角色的实际参数** = `--permission-mode acceptEdits`
>    + `--tools=Read,Edit,Write,Grep,Glob,Bash`
>    + `--allowed-tools 'Bash(sh:*),Bash(bash:*),Bash(chmod:*),Bash(git:*),Bash(node:*),Bash(npm:*)'`（**六前缀**）。
>    qa_engineer **未单独收窄**，与 dev 用同一组参数；上表给 dev 的 `Bash(npm:*)` 窄授权、给 qa 的 `Read,Grep,Glob,Bash` 均**未落地**。
> 2. **`Bash(sh:*)` / `Bash(bash:*)` 等价于任意命令执行**：`bash -c "<任意命令>"` 完全落在前缀内，
>    故 `git push --force` / `rm -rf` / `curl … | sh` 都能绕过前缀限制 —— 前缀白名单实际只约束**不包 shell 的调用**（agent 直接写
>    `npm test` 会被约束，写成 `bash -c 'npm test'` 就不会）。即「精准预授权」在能力层面**已退化为「全量放行」**，
>    这是满足 dev/qa prompt「真实运行 .sh 脚本」的必要代价，收窄属 Phase 2 决策。
> 3. **`Bash(git:*)` / `Bash(npm:*)` 的授权面同样过宽**：含 `push --force` / `reset --hard` / `publish` 等破坏性操作。
>    Phase 1 的目标仓库是临时目录尚可控，**真实项目使用前必须收窄**（如 `Bash(npm test:*)` / `Bash(npm run:*)`）。
> 4. **只读角色未被放宽**（仍 `default` + `Read,Grep,Glob`，无任何 Bash 预授权；也未使用用户已否决的
>    `--dangerously-skip-permissions`，有测试断言把守），但 `--tools` **不约束 MCP 工具**，故其「只读」在 CLI 层并非 airtight
>    （未加 `--strict-mcp-config` / `--disallowed-tools`）。
> 5. 因此本节标题的主张「**安全由 CLI 强制，不靠提示词自觉**」在 Phase 1 **只能算部分成立**：
>    文件编辑边界确由 CLI 强制，命令执行边界则已被前缀白名单实质放宽；完整落地需 Phase 2 收窄前缀或引入真正的沙箱。

### 11.4 交叉引擎评审（调度时动态选择）

**规则：评审员使用的引擎必须与产出该代码的实例所用引擎不同。** 由内核在调度评审节点时动态分配，而非在角色定义里写死。

```
产出方 engine = claude-code  →  reviewer_tech 分配到 codex，reviewer_cross 分配到 claude-code
产出方 engine = codex        →  reviewer_tech 分配到 claude-code，reviewer_cross 分配到 codex
```

理由：同一引擎自评有同源盲区（倾向认为自己的写法对）。这是"独立 QA"概念的真实价值。

**两个 reviewer 之间的引擎也必须不同**，否则等于同一个视角评两遍，浪费成本。

实现约束：因为 7.3 中 `backend_dev` / `frontend_dev` 允许 claude-code 与 codex 两种引擎，所以角色定义里的 `engine` 字段对评审角色而言是**默认值而非定值**，实际引擎在调度时由产出方引擎反推。若某引擎不可用（如 codex 未登录），降级为另一引擎并记 `transfer.decided` 说明降级理由。

### 11.5 进程生命周期

| 机制 | 说明 |
| --- | --- |
| Lease + Heartbeat | spawn 时登记 `leases`；runner 每 10s 心跳；超过 `ttl_ms` 未更新 → 判定 `lease.expired` → `node.failed` → 回收 worktree |
| 幂等 | 每次执行有独立 `run_id` + `attempt`；重跑不修改历史 Artifact，只追加新的 |
| 预算准入 | 调度前查 `budget_used < budget_cap`，不满足直接拒绝调度并 `budget.exceeded`，不跑到一半没钱 |
| 取消 | kernel 持 pid，`cancel()` 先 SIGTERM，3s 后 SIGKILL；清理 worktree 与 lease |
| 并发上限 | 全局并发 + 每引擎并发双上限（macOS 上大量并发进程有资源风险） |

---

## 12. 编排内核模块划分

| 模块 | 单一职责 | 输入 → 输出 |
| --- | --- | --- |
| `EventStore` | append-only 事件读写 | Event → void / Event[] |
| `Projector` | 事件重放 → 投影表 | Event[] → TaskState / NodeState |
| `StateMachine` | 求值转移条件，产出下一个动作 | facts + 流程定义 → Transfer\|Gate\|End |
| `Scheduler` | 并发控制、worktree 分配、预算准入 | Transfer → NodeRun[] |
| `Decider` | LLM 兜底决策（受限枚举） | 事实快照 → Decision |
| `GateKeeper` | 卡点开启/收敛/等待 | Gate 定义 → Gate 状态 |
| `ContextAssembler` | 装配 prompt（含 token 上限降级） | Artifacts + 角色 → prompt |
| `WorkspaceManager` | worktree 池、分支、冲突检测 | Task/WP → Workspace |
| `RunnerPool` | 适配器选择、进程管理、事件归一化 | RunRequest → RunnerEvent |
| `ArtifactStore` | 产物落库 + schema 校验 | raw → Artifact |

**边界规则**：模块间只通过**事件和明确的数据结构**通信，不互相调用内部方法。每个模块都能独立测试。

---

## 13. 观测前端

### 13.1 页面结构

| 页面 | 内容 | 解决什么问题 |
| --- | --- | --- |
| **任务总览** | 任务卡片列表；按状态分组；进度条；已消耗成本 | "我有哪些任务在跑" |
| **任务详情（DAG 泳道图）** | React Flow 渲染流程图；节点实时高亮；边标注转移原因；横向泳道显示并行分支 | "现在谁在干活、流程走到哪" |
| **实时日志** | 订阅 run_id，流式展示 CLI 输出；可区分 stdout / 结构化事件 | "到底在干什么" |
| **人工卡点队列** | 只列 G3；附决策所需的产物摘要（需求/设计/diff/测试报告）；批准 / 打回 / 改范围 | "需要我做什么决定" |
| **组织视图** | 每个角色的忙碌/空闲/等待、当前任务、已烧 token、产出物数量 | "公司现在是什么状态" |
| **成本面板** | 按角色 / 工作包 / 引擎统计 token 与费用；ceo 与 cto 单独拆列 | "钱花在哪了" |
| **产物浏览器** | 各类型 Artifact 的渲染视图（含 code diff 高亮） | "产出了什么" |

### 13.2 实时通道

- **WebSocket** 推送三类消息：`event`（状态变更，驱动 DAG 刷新）、`log_chunk`（日志流）、`heartbeat`（连接保活）

  > **Phase 1 实现修正**：实际只实现两类 —— `task_state`（任务终态快照）与 `task_error`。
  > **`{ type: 'event' }` 在 Phase 1 无触发点**：内核的 `runTask` 没有事件订阅/回调接口，Server 层无法感知节点级事件，
  > 因此它当前是死代码。它保留在端点表里是为 Phase 2 预留（内核加订阅回调时启用）。
  > 同理 `log_chunk` 的流式推送也需等内核暴露日志订阅才可用。
  > **前端在 Phase 1 靠轮询 `GET /api/tasks/:id` 兜住实时性**（Task 14 即如此实现）。
- HTTP 端点只用于**动作**：G3 审批、暂停/恢复/取消任务
- **前端完全只读**（除审批动作外），不含任何流程逻辑

### 13.3 视觉重点

DAG 泳道图是核心。要看一眼就明白：
- 哪几条泳道在并行跑（横向展开的分支）
- 每个节点是运行中 / 已完成 / 失败 / 等待卡点
- 哪个 join 点在等谁
- 当前这个任务的并行度是多少

---

## 14. 技术栈与目录结构

### 14.1 技术栈

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 后端 | Node 22 + TypeScript | 要 spawn 子进程、流式采集，且与前端同栈 |
| HTTP | Fastify | 轻量、TS 友好、`@fastify/websocket` 原生支持 |
| 存储 | SQLite（`better-sqlite3`） | 单机零依赖零配置；事件表 + 投影表足够 |
| 校验 | zod（+ zod-to-json-schema） | Artifact schema 与配置校验；**同时导出 JSON Schema 喂给 `claude --json-schema`** |
| 前端 | React 18 + Vite + TypeScript | |
| 图渲染 | `@xyflow/react`（React Flow） | DAG + 泳道 |
| 前端状态 | Zustand | 轻量，配合 WS 推送 |
| 样式 | Tailwind CSS | |
| 日志 | pino | |
| 进程 | `node:child_process` spawn | 流式 stdout 采集 |

### 14.2 目录结构（按关注点归类，层级收敛）

```
多agent开发流程/
├── .gitignore
├── .env.example                  # 配置模板（不提交 .env）
├── package.json                  # 依赖锁定
├── tsconfig.json
├── 记录.md
├── docs/
│   └── superpowers/specs/        # 设计文档
├── spikes/                       # 一次性探针脚本（Phase 0 CLI 行为验证）
├── src/
│   ├── kernel/                   # 编排内核（第 12 节各模块）
│   ├── runner/                   # 执行层：claude-code / codex 适配器
│   ├── server/                   # HTTP + WebSocket API
│   ├── config/                   # 配置加载与 zod 校验
│   └── shared/                   # 共享类型、Artifact schema、事件定义
├── web/                          # 前端（独立 package.json）
│   └── src/
├── config/                       # 声明式配置（非代码）
│   ├── roles/                    # 角色定义 YAML
│   ├── profiles/                 # full / lean / solo
│   ├── workflows/                # 流程 DAG 定义
│   └── prompts/                  # 角色 system prompt
├── data/                         # 运行时数据（gitignore）
│   ├── agentflow.sqlite
│   └── context/                  # Shared Context Bundle
├── workspaces/                   # git worktree 池（gitignore）
└── logs/                         # 原始运行日志（gitignore）
```

---

## 15. 配置与安全

| 要求 | 落地方式 |
| --- | --- |
| 不硬编码路径/密钥 | 一律走 `.env`（`config/` 里只放非敏感流程定义）；提供 `.env.example` |
| 依赖锁定 | `package.json` 精确版本 + lockfile 提交 |
| 不改基础环境 | 不全局安装任何包；不安装 Python 依赖；只用项目内 `node_modules` |
| 网络暴露 | HTTP/WS **仅绑定 127.0.0.1**，无鉴权需求 |
| 能力边界 | 角色权限由 CLI 沙箱参数强制（见 11.3），不靠提示词 |
| 危险动作 | `danger-full-access` / 部署类操作必须经 G3 人工批准才执行 |
| 工作区安全 | 每个工作包独占 worktree；`owns` 之外的路径写入视为违规，记 `artifact.invalidated`。**Phase 1 实现修正（2026-09-19 终审）：未实现路径级强制** —— `owns` 仅作为 prompt 提示（CLI 层全量放行、内核层无变更路径核对、`artifact.invalidated` 无生产者），且 Phase 1 所有节点 `isolate: false`、worktree 隔离未启用；占用检查与越界记录属 Phase 2，详见 §7.2 的注 |

---

## 16. 分阶段实施

每个阶段都是**能跑起来的闭环**，不是半成品。

**范围说明**：整个平台体量较大，本文档是"整体架构一次性设计到位"。实现计划**先只覆盖 Phase 0 与 Phase 1**，后续阶段在各自开始前单独出计划——避免一次性计划过于臃肿而失真。

### Phase 0：CLI 行为探针（阻塞后续，必须最先做）

**为什么阻塞**：Runner 适配层的具体实现完全取决于 CLI 的真实输出行为，不能靠推测写。

验证项：
1. `claude -p --output-format stream-json` 的真实事件序列与字段结构
2. `claude --json-schema` 在**有工具调用**的场景下是否仍可靠返回结构化结果
3. `codex exec` 的输出可解析性；是否有可用的结构化输出途径
4. **多实例并发的安全性**：claude / codex 是否在本地会话目录（`~/.claude`、`~/.codex`）产生竞争
5. `--max-budget-usd` 的实际生效行为

产出：`spikes/cli-probe/` 下的最小脚本 + 结论写回 `记录.md`。**验证结论直接决定 11.2 的参数映射是否成立。**

### Phase 1：内核骨架（单引擎串行闭环）

- `EventStore` + `Projector` + `StateMachine`（规则求值）
- `RunnerPool` + claude-code adapter
- 三个角色：`pm` → `backend_dev` → `qa_engineer`
- 极简页面：任务列表 + 状态流转

**验收**：输入一个需求文本，三个角色自动串行流转完成，事件库能重放出完整过程。

### Phase 2：并行

- 工作包拆解（`work_package_plan`）+ `owns` 占用检查
- `parallel` / `join` 节点类型
- `WorkspaceManager` + worktree 池
- `integrator` 角色 + `conflict_report`

**验收**：一个需求拆出 3 个工作包，3 条泳道并行跑，自动合并。

### Phase 3：完整公司与卡点

- 全部 12 角色注册表 + 三档 profile
- G1 / G2 / G3 卡点 + `GateKeeper`
- codex adapter + 交叉引擎评审（`codex review --base`）
- 人工卡点队列页面

**验收**：`full` profile 跑通完整流程，CEO 只在 4 个 G3 出现。

### Phase 4：观测前端完整版

- DAG 泳道图 + 实时日志流 + 组织视图 + 成本面板 + 产物浏览器

**验收**：不读日志文件，仅从页面就能回答"现在谁在干什么、卡在哪、为什么、花了多少钱"。

### Phase 5：鲁棒性

- Lease/心跳、幂等重试、反死锁、预算准入、事件重放重建投影
- LLM 决策器（受限枚举）

**验收**：强杀进程后任务能被正确判定失败并重试；预算超限正确挂起。

---

## 17. 测试策略

| 层次 | 内容 | 关键点 |
| --- | --- | --- |
| 单元 | 转移条件求值器、Artifact schema、prompt 装配器（验证 token 上限降级）、事件投影 | 投影器要测"从事件重放得到的状态 == 实时状态" |
| **集成（核心）** | **Fake Runner + 录制回放** | 把真实 CLI 的流式输出存为 fixture，实现**不依赖真实 API 的确定性回归测试** |
| 契约 | 每个 adapter 对真实 CLI 的最小 smoke test | CLI 升级后第一时间发现参数漂移 |
| E2E | 真实跑一个极小需求（如"给空仓库加一个 hello CLI"） | 端到端验证，非每次提交都跑 |

**Fake Runner 是这套架构可测性的关键**：编排逻辑的正确性不依赖于 LLM 的随机性，因为 Runner 是接口。这意味着绝大部分编排逻辑可以用确定性测试覆盖。

---

## 18. 风险与开放问题

### 18.1 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **CLI 输出格式随版本变化** | 适配器解析失败 | 适配器层隔离 + 契约 smoke test + 录制回放回归 |
| **`--json-schema` 在有工具调用时不可靠** | 产物不合规 | Phase 0 探针先验证；不可靠则降级为 prompt 约束 + zod 校验 + 重试 |
| **多实例并发竞争本地会话目录** | 随机失败，难排查 | Phase 0 探针必须验证；必要时用 `--no-session-persistence` |
| **成本不可控** | full profile 单需求费用未知 | 预算准入 + 分级 gate + Phase 1 实测后回填 profile 默认值 |
| **codex 无结构化输出** | 评审结果解析失败 | prompt 强约束 + JSON 提取容错；必要时改用 claude 做评审 |
| **worktree 并发写同文件** | 冲突/覆盖 | `owns` 占用检查 + `serialization_key` 串行 |
| **PM 工作包拆解质量差** | 并行度低、契约频繁漂移 | 拆解产出用 JSON Schema 强约束（必须含 interface_contract）；质量差时 G2 会签拦截 |
| **LLM 决策器不确定性** | 流程走向不可预测 | 受限枚举 + 记录理由 + 事件可重放 |
| 大量并发子进程 | macOS 资源压力 | 全局 + 每引擎双并发上限 |

### 18.2 开放问题（需 Phase 0 探针回答）

1. `claude --json-schema` 在 agentic 多轮工具调用场景下，是否仍能稳定返回符合 schema 的最终结构？
2. claude / codex 多实例并发是否会互相干扰本地状态？
3. `codex exec` 是否能输出机器可解析的结构化结果？若不能，评审角色的错误处理策略如何定？
4. `--max-budget-usd` 超限时的行为是"优雅中止并返回部分结果"还是"直接报错退出"？决定预算模块的实现方式。
5. claude 的 `stream-json` 中 `usage` 信息的粒度与时机（是否边跑边给），决定成本面板能否做到实时。

---

## 附录 A：术语表

| 术语 | 含义 |
| --- | --- |
| Task | 一次完整需求，对应一张 DAG |
| Work Package（工作包） | 可独立并行的工作单元，并行度的来源 |
| NodeRun | 一次角色执行实例（一个角色 + 一个工作包 + 一次尝试） |
| Artifact | 结构化产物，角色间唯一的权威交接载体 |
| Gate | 审批卡点，G0（自动）/ G1（单角色）/ G2（多角色会签）/ G3（真人） |
| Join | 并行分支的汇合点 |
| Lease | 进程存活守卫，靠心跳维持 |
| Profile | 角色集与卡点级别的预置视图（full / lean / solo） |

## 附录 B：默认完整流转 DAG

```
[G3] CEO 立项确认（人工）
  └→ PM 需求分析 ─→ 产出：requirement + work_package_plan（N 个工作包 + 验收标准）
       └→ [G2] architect 接口契约冻结（与 CTO 会签）
            ├─[并行] WP1 后端 ─→ design → coding → 单测 → [G1] review×2 ─┐
            ├─[并行] WP2 前端 ─→ design → coding → 单测 → [G1] review×2 ─┤
            ├─[并行] WP3 后端 ─→ design → coding → 单测 → [G1] review×2 ─┤
            └─[并行] qa_engineer ─→ 集成测试用例设计 ──────────────────────┤
                                                                          ↓
                                                              integrator 合并 [G2] 会签
                                                                     └→ qa_engineer 集成/E2E
                                                                          └→ [G2] CTO 技术验收 + PM 产品验收
                                                                               └→ devops 发布
                                                                                    └→ [G3] CEO 最终验收（人工）
```