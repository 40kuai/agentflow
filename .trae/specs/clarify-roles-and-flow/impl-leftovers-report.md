# 收尾报告：clarify-roles-and-flow 验收遗留项 + 端到端冒烟对齐

> 范围：规格 `clarify-roles-and-flow` 验收后遗留的 4 件事（AC5 断言、过期文案、`parallel_dev` 接线、冒烟对齐），
> 以及一次真实端到端冒烟。
> 分支：`main`（工作目录 `/Users/40kuai/Documents/多agent开发流程`）。
> 未新增依赖、未触碰全局环境、未改 `tests/fixtures/**`、未改 `config/workflows/simple_dev.yaml`、
> 未改 `src/kernel/**` / `src/runner/**` 的实现逻辑。

---

## 1. 修 `tests/website/website.test.ts` 的 AC5（角色数写死 3）

- **改动**：`tests/website/website.test.ts:441-454`（同一测试用例内）。
  - 原断言 `expect(registered).toEqual(['backend_dev','pm','qa_engineer'])`（写死「恰好 3 个角色」）→
    改为**不依赖数量**的包含式断言：串行基线 `simple_dev` 用到的 3 个角色（`pm` / `backend_dev` / `qa_engineer`）
    都必须在 `config/roles` 里注册（`expect(registered).toContain(id)`）。
  - 原 `for (const id of registered) expect(rolesText).toContain(id)`（遍历「全部已注册角色」去对官网文本）
    改为遍历同一份 **baseline 三元组**——否则新增的 3 个角色（`backend_dev_module_a/b`、`pm_planner`）
    在官网角色段落里本来就没有，会继续失败。
  - 用例标题由「Phase 1 已实现角色数（3）与 config/roles 实际注册一致…」改为「串行基线 simple_dev 用到的角色与 config/roles 实际注册一致…」。
  - **未改** AC2 / AC6，**未改**其它用例，**未改**官网（`src/website/`）任何内容。
- **为什么不是把 3 改成 6**：那只是把同一个「写死数量」的问题换个数字；下次再增删角色会再次变红。
- **验证**：`npx vitest run tests/website/website.test.ts` → 该用例 **通过**（AC5 由失败转为通过）。

## 2. 清理两处与实现矛盾的过期文案

### 2.1 仓库根 `README.md`（未跟踪）

- **性质判断**：**它是关于 AgentFlow 平台本身的说明文档**（标题「AgentFlow — 多 Agent 开发流程编排平台」，
  章节覆盖「现在能做什么 / 快速开始 / 配置 / 目录结构 / HTTP 接口 / 测试 / 安全须知 / 能力边界」，并含真实实测数据）。
  **不是**某次任务产出的与 AgentFlow 无关的目标仓库文件。故按指示**如实更新其过期表述**。
- **改动**（仅订正与当前实现矛盾的表述，未改结构、未新增章节）：
  - `README.md:48`：快速开始的示例 requirement 由 `scripts/hello.sh` 改为 `src/ 目录新增 hello.sh`
    （在 `owns` 强制后，原示例会让 `backend_dev` 越界）。
  - `README.md:58-62`：在「启动目录就是目标仓库」的告警块补一句：Task 7 起这类越界写会被内核**判为节点失败**，
    但隔离目标仓库仍是必须的。
  - `README.md:76-77`：实测计数 `单测 179 passed / 20 files` → `npx vitest run src` = **267 passed / 22 files**，
    并注明完整 `npx vitest run` 还会带上 `tests/website/`（官网任务，另有其自身既有失败）。
  - `README.md:90`：`AGENTFLOW_WORKSPACE_DIR` 说明「Phase 2 的 worktree 落点」→「并行节点的 git worktree 落点」。
  - `README.md:94`：`AGENTFLOW_GLOBAL_CONCURRENCY` 由「⚠️ 当前无消费者」→「并行批次的并发上限（超限节点排队）；
    批次内 `owns` 重叠按 `AGENTFLOW_BATCH_CONFLICT_POLICY` 处理」。
  - `README.md:165-168`：安全须知第 2 条由「`owns` 不是安全边界 / 内核层没有变更路径核对 / 路径级强制属 Phase 2」
    →「`owns` 已做路径级强制（越界即 `artifact.invalidated` + 节点 `failed`），但它仍是内核侧闸门、不是文件系统级安全边界」。
  - `README.md:180-185`：能力边界表三行由 ❌/⚠️ → ✅：**并发调度**（已实现、`AGENTFLOW_GLOBAL_CONCURRENCY` 已被消费）、
    **工作区隔离**（已实现 worktree + 按 `owns` 确定性合并，`simple_dev` 仍全 `isolate:false`）、
    **`owns` 路径级强制**（已实现）；**多流程/多档 profile** 行订正为「已有 `simple_dev`/`parallel_dev` 两条工作流、6 个角色」；
    **评审角色 / G0–G3** 行订正为「工作包式扇出/汇合已由 `parallel_dev` 演示，PM 自动拆解质量未验证」。

### 2.2 `web/` 内两处过期文案（仅改字符串，未动逻辑/结构/样式）

- `web/src/App.tsx:433-436`：`Phase 1 串行执行…（env.globalConcurrency 无消费者）…并发调度属 Phase 2`
  → `simple_dev 为串行基线…内核已消费 env.globalConcurrency，并行批次超上限即排队。本页面暂不展示并行度指标。`
- `web/src/components/NodeCostView.tsx:93-95`：`Phase 1 串行执行，env.globalConcurrency 暂无消费者…并发调度属 Phase 2`
  → `内核已消费 env.globalConcurrency（并发调度已实现，超上限节点排队），本页面暂不展示并行度指标。`
- 改前先读当前内容，改后复核落盘；**只替换这两处文字**，未回退/覆盖 `web/` 的任何其它内容。

## 3. 让 `parallel_dev` 可被选用（最小接线）

- `src/config/env.ts:9-13`：`AppEnv` 新增 `workflowId: string`（含用途注释：对应 `config/workflows/<id>.yaml`，默认 `simple_dev`）。
- `src/config/env.ts:32`：`DEFAULTS.workflowId = 'simple_dev'`。
- `src/config/env.ts:98`：`loadEnv` 读取 `AGENTFLOW_WORKFLOW`（缺省回落到 `simple_dev`）。
- `src/main.ts:12`：`loadWorkflow(env.configDir, 'simple_dev')` → `loadWorkflow(env.configDir, env.workflowId)`。
  **默认行为不变**（不设该变量时仍是 `simple_dev`，与既有串行基线逐字一致）。
- **补测试**：
  - `src/config/env.test.ts:48-55`：默认值为 `simple_dev`；设为 `parallel_dev` 时取到 `parallel_dev`。
  - `src/config/real-config.test.ts:37-45`：用 `loadEnv` 选出的 id **真实加载工作流**（默认 → `simple_dev`，
    设 `AGENTFLOW_WORKFLOW=parallel_dev` → `parallel_dev`），证明「设了变量就能加载对应工作流」。
- **`.env.example` 检查结论**：**未把 `AGENTFLOW_WORKFLOW` 加入 `.env.example`**。
  原因：`tests/website/website.test.ts:391-415` 的 AC5 断言「官网环境变量表与 `.env.example` **键名与默认值完全一致**」，
  往 `.env.example` 加任何新键都会立刻打破该断言（官网 HTML 归用户、本任务不得触碰）。
  这与本项目既有做法一致（`AGENTFLOW_GLOBAL_CONCURRENCY` / `AGENTFLOW_BATCH_CONFLICT_POLICY` 当年同样刻意未入 `.env.example`）：
  变量仍可经 `.env` / 进程环境变量生效，默认行为不变。**官网任务落地后建议补回。**

## 4. 把端到端冒烟对齐到 `owns` 之内（实际改了两处）

### 4.1 requirement 落在 `owns` 内（本任务预期的那一处）

- `tests/e2e/smoke.sh:46-53`：requirement 由「新增 `scripts/hello.sh`（`backend_dev.owns=["src/**"]` 之外）
  + 追加说明到 `README.md`（越界）」改为
  「在 `src/` 目录新增 `hello.sh`（dev 写，落在 `owns=["src/**"]`）+ 在 `tests/` 目录新增测试脚本（qa 写，落在 `owns=["tests/**"]`），
  改动仅限 `src/` 与 `tests/`」。并加注释说明理由。
- **未削弱安全闸**：没有放宽 `owns` 强制、没有扩大 `backend_dev.owns`、没有改 `simple_dev.yaml`。

### 4.2 平台运行时产物移出目标仓库（冒烟实测暴露出的真正拦路石，见第 5 节）

- `tests/e2e/smoke.sh:16-20`：新增 `RUNTIME_DIR="$(mktemp -d /tmp/agentflow-e2e-runtime-XXXXXX)"` 并注释说明。
- `tests/e2e/smoke.sh:27-32`：`AGENTFLOW_DB_PATH` / `AGENTFLOW_LOG_DIR` / `AGENTFLOW_WORKSPACE_DIR`
  由「落在 `$TARGET_REPO/` 内」改为「落在 `$RUNTIME_DIR/`（目标仓库之外）」。
- **理由**：内核 `repoPath = process.cwd()` = 目标仓库；Task 7 的 `owns` 路径级强制用 `git status` 采集
  **目标仓库的实际变更路径**。原脚本把事件库 / 运行日志 / worktree 根都放在目标仓库里，
  于是**平台自己写的运行时文件**（尤其是 runner 写出的 `logs/runs/<runId>.jsonl`）会被当成「节点越界写入」——
  对 `owns=[]` 的只读角色 `pm` 而言必死。这不是 agent 越界，而是**采集口径把平台自身产物算进去了**。
- ⚠️ **该 4.2 改动未经真实复跑验证**（见第 5 节的「最多跑一次」约束）。

---

## 5. 端到端冒烟实测结果（**FAIL**，只跑一次，未重跑）

命令：`AGENTFLOW_PORT=8790 bash tests/e2e/smoke.sh`
（端口换 8790 的原因：默认 8787 已被一个**先前就在跑的 AgentFlow 服务**占用——`PID 11741`，`src/main.ts`，19:15 启动；
按「不干扰环境」原则未 kill 它，改用脚本本就支持的 `AGENTFLOW_PORT` 环境变量避开冲突。）

- **判定**：**FAIL**（`smoke.sh` 末尾输出 `FAIL：任务未完成`；第 6 轮轮询（30s）即读到 `failed`）
- **三节点状态**：
  - `pm_analyze` → **failed**
  - `dev_implement` → **未启动**（`node.queued/started` 均无）
  - `qa_verify` → **未启动**
- **失败根因（事件库原始证据实读）**：
  ```
  artifact.invalidated  node_id=pm_analyze
    reason="节点写入超出 owns 允许范围（允许写入：（空，只读角色））"
    out_of_bounds_paths=["logs/runs/run_96013711eb7449199819.jsonl"]
    changed_paths=["logs/runs/run_96013711eb7449199819.jsonl"]
  node.failed  error="越界写入 1 个路径：logs/runs/run_96013711eb7449199819.jsonl"
               reason_category=permission_denied
  task.failed  reason="节点 pm_analyze 越界写入（超出 owns 允许范围）"
  ```
  即：**被判定越界的那个路径正是 runner 自己写的运行日志文件**（位于目标仓库内）。`pm` 是只读角色（`owns: []`），
  任何变更都算越界，于是第一个节点就被安全闸「正确地、但错误地」拦下了。
- **实测总花费**：**$0.0539928**（`budgetUsedUsd` 与 runner 日志中 `total_cost_usd` 实读一致，仅 `pm_analyze` 一次调用）
- **`requires approval` 次数**：**0**（`permission_denials: []`；pm 为只读角色，未触发 Bash 授权问题）
- **Artifact 数**：事件流里有 **1 条 `artifact.created`（requirement）**，但因节点随即被判失败，
  最终投影 `artifacts: []`（0 个可用产物）
- **`log_ref` 是否存在**：**存在**（`OK /tmp/agentflow-e2e-target-r8Ekh7/logs/runs/run_96013711eb7449199819.jsonl`）
- **目标仓库被 agent 改动**：`?? README.md`（脚本预置）、`?? data/`、`?? logs/`（平台的运行时产物，非 agent 越界）
- **本项目工作区是否干净**：**是**。`git status --short` 只有本次任务的改动与既有未跟踪项
  （`tests/website/`、`src/website/`、`README.md`、`.trae/specs/...` 等），**没有任何冒烟 agent 触碰本项目的痕迹**。
- 冒烟后无残留进程（无 `tsx`/`claude` 残留），8790 端口已释放。
- 原始产物留档（未入库）：完整 stdout `/tmp/agentflow-e2e-smoke-leftovers.txt`；
  目标仓库 `/tmp/agentflow-e2e-target-r8Ekh7`（含事件库 `data/e2e.sqlite` 与 `logs/runs/run_96013711eb7449199819.jsonl`）。

### 5.1 关键发现：平台运行时目录落在 `repoPath` 内会触发 `owns` 越界（真实缺陷）

这是本次冒烟**最有价值的发现**，且**不只是冒烟脚本的问题**：

- 平台默认 `AGENTFLOW_LOG_DIR=./logs`、`AGENTFLOW_DB_PATH=./data`，都是**相对 `process.cwd()`**，
  而 `cwd` 就是「目标仓库」（`src/main.ts` 的 `repoPath = process.cwd()`）。
- Task 7 的 `collectChangedPaths`（`git status --porcelain --untracked-files=all`）在 `repoPath` 里采集，
  会把**平台自己写的** `logs/runs/*.jsonl`、`data/*.sqlite*` 也算作「本次节点的改动」。
- 后果：**任何真实运行**里，第一个节点（多为只读的 `pm`，`owns: []`）都会因平台自身日志被判**越界失败**。
  换言之，Task 7 落地后，**用默认目录直接从目标仓库启动平台已跑不通**，除非把 `AGENTFLOW_LOG_DIR`/`DB_PATH`
  指到目标仓库之外（或内核显式排除自身运行时目录）。
- 本任务被约束为**不得改 `src/kernel/**` 逻辑**，故采用冒烟侧最小方案（4.2：运行时目录移出目标仓库）。
  **建议后续单开任务**：内核在越界判定中排除平台自身的运行时目录（`logDir`/`dbPath`/`workspaceRoot`），
  或强制它们不得位于 `repoPath` 内（配置校验期报错）。**本轮未做该产品级修复。**

### 5.2 已知设计局限（如实记录）：`owns`/`reads` 按 AgentFlow 自身布局写死

- 现网角色的 `owns`/`reads` 是按 **AgentFlow 自己的仓库布局**声明的（`src/**`、`tests/**`、`docs/**`）。
- 因此把平台指向**任意其它布局**的目标仓库时，角色 `owns` 必然与实际需要写的路径不匹配 →
  安全闸会把正常产出判为越界。这是**真实的设计局限**，不是配置疏漏。
- 本轮**未**尝试设计通用的路径方案（不做仓布局探测/自动映射）——那应是一个独立任务。
  已知规避方式：让目标仓库沿用 `src/**`、`tests/**`、`docs/**` 布局（冒烟就是这样对齐的）。

---

## 6. 验证汇总

| 项 | 结果 |
| --- | --- |
| 本项目自身套件 `npx vitest run src` | **267 passed / 22 files**（全绿） |
| `npx tsc --noEmit` | **exit 0** |
| 完整 `npx vitest run` | 301 passed / **3 failed**（全部在 `tests/website/website.test.ts`，见下） |
| 网站套件 AC5 | **由失败转为通过**（本次修复的那条用例已绿） |
| 网站套件 AC2 | **仍失败 1 条**（站点落在 `src/website/` 而非仓库根 `website/`）——既有失败，与本任务无关 |
| 网站套件 AC6 | **仍失败 2 条**：① `docs/superpowers/specs/2026-09-19-agentflow-phase2-requirements.md` 含 `src/website/**`；② 已跟踪文件 `.trae/specs/clarify-roles-and-flow/tasks.md` 的未提交 diff 含 `website` 字样（该文件在本任务开始前就已是 `M`，非本次改动）——均为既有失败，与本任务无关 |
| 端到端冒烟 | **FAIL**（1 次，实测总花费 $0.0539928，根因见 5.1） |

## 7. 不同意见 / 需请示

1. **「最多跑一次」与「让冒烟跑通」存在张力**：本次一次运行恰好暴露了 4.2 的根因（平台自身日志被判越界）。
   4.2 的修复**未经真实复跑验证**——若允许再跑一次（约 $0.6），可确认冒烟转 PASS；本轮严格遵守「不重跑」。
2. **item 2 的 README 处置**：该文件未跟踪、内容确为平台说明，已按指示更新。
   但它是**未跟踪**文件，本次**未纳入提交**（不在我新增/修改的交付集合里；若需入库请明确指示）。
3. **AC6 的第 2 条失败**源自 `.trae/specs/.../tasks.md` 的未提交改动（内容含 `website` 字样）。
   我未提交也未回退该文件（非我所做）。若希望 AC6 第 2 条转绿，需要提交该文件或调整其措辞——均不在本任务范围。
4. **本次提交只包含已跟踪文件的改动**（`src/config/env.ts`、`src/config/env.test.ts`、`src/config/real-config.test.ts`、
   `src/main.ts`、`tests/e2e/smoke.sh`、`web/src/App.tsx`、`web/src/components/NodeCostView.tsx`、`记录.md`）。
   以下改动**存在于工作区但未纳入提交**（均为未跟踪文件，避免与用户/官网任务的入库计划相撞）：
   AC5 修复所在的 `tests/website/website.test.ts`、订正后的根 `README.md`、本报告文件。
   若需要它们入库，请明确指示。