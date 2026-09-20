# Task 14 集成验证报告

- 日期：2026-09-19
- 规格：`.trae/specs/clarify-roles-and-flow/spec.md`；任务清单 `tasks.md`；核对清单 `checklist.md`
- 分支：`main`；本任务**未产生提交**（仅验证，未改任何受版本控制的文件）
- 证据基线：HEAD = `bb229c7`（docs: 同步角色/工作流/决策语义与并发隔离的实现现状）
- 约束遵守：未改 `web/`、`src/website/`、`tests/website/`、`tests/fixtures/`；未真实调用 claude；未新增依赖；未执行破坏性 git。

---

## 一、14.1 全量测试与类型检查（**本项目自身套件 vs website 套件分离**）

命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **退出码 0（通过）** |
| `npx vitest run`（全量，23 个文件） | `Test Files 1 failed \| 22 passed (23)`，`Tests 3 failed \| 299 passed (302)` |
| `npx vitest run src`（本项目自身套件，排除 `tests/website/`） | **`Test Files 22 passed (22)`，`Tests 265 passed (265)` 全绿** |

### ① 本项目自身套件结果：**全绿（265/265，22 文件）**

### ② `tests/website/` 结果（**归用户官网任务；本次验收明确排除，未修、未改**）

唯一失败文件为 `tests/website/website.test.ts`，逐条：

| 用例 | 失败内容 | 归因 |
| --- | --- | --- |
| **AC2** 站点位于仓库根独立目录 `website/` | `violations` 非空：`仓库根不存在 website/index.html`、`站点实际落进既有目录 src/（src/website）` | **既有失败**，与本 spec 无关（站点落在 `src/website/`） |
| **AC5** Phase 1 已实现角色数（3）与 `config/roles` 实际注册一致 | 期望 `['backend_dev','pm','qa_engineer']`，实得 6 个（多出 `backend_dev_module_a`、`backend_dev_module_b`、`pm_planner`） | **由本次 Task 12 新增 3 个角色直接触发**（`website.test.ts:447` 直接读 `config/roles` 实际文件数并写死 3） |
| **AC6** 对仓库其余内容零改动 | `docs/superpowers/specs/2026-09-19-agentflow-phase2-requirements.md` 命中（该文含 `website` 字样） | **既有失败**（该文档由本 spec 之外的过程新增） |

**因果关系明确**：AC5（角色数=3）的失败是**本 spec Task 12 新增角色导致的** —— 而 Task 12.2 明确要求「各并行开发节点的 `owns` 互不相交」，`owns` 只能来自角色定义，故**必须新增角色**，新增角色又必然使写死「只有 3 个角色」的 AC5 失败。这是两个并行任务的交界，需官网负责人把站点文案的角色数与 `config/roles` 对齐（当前 6 个）。

---

## 二、14.2 串行等价性（实际跑的断言）

用 **Fake Runner** 加载**真实** `config/workflows/simple_dev.yaml` 与 `config/roles/*.yaml` 跑通（未传 `globalConcurrency`，走缺省 1=串行），实得输出：

```
转移序列(decidedBy): →pm_analyze(rule), pm_analyze→dev_implement(rule), dev_implement→qa_verify(rule)
runner.requests 次数: 3 | 每个 run 的 artifactType: requirement,code_diff,test_report
PASS | 转移序列逐字不变 | ["→pm_analyze","pm_analyze→dev_implement","dev_implement→qa_verify"]
PASS | decidedBy 全为 rule | ["rule","rule","rule"]
PASS | runner.requests 次数为 3 | 3
PASS | 节点完成序列为直线 | ["pm_analyze","dev_implement","qa_verify"]
PASS | 无隔离（非并发单节点批次不隔离，workdir 恒为主工作区） | 3 个请求的 workdir 均等于 repoPath
```

另有仓库自带单测 `src/kernel/kernel.test.ts:580`「串行直线流程的转移序列与决策来源保持不变（串行等价性）」断言同一组值（转移序列 3 条、`decidedBy` 全 `rule`、`runner.requests` 长度 3），当前通过。

**结论：串行等价性成立。**

---

## 三、14.3 并行链路验证（**Fake Runner，真实 `config/workflows/parallel_dev.yaml`**）

加载真实 `parallel_dev.yaml`（5 节点 5 边，`nodes=pm_analyze,pm_plan,dev_module_a,dev_module_b,qa_verify`）在**临时 git 仓库**中全链路运行（`globalConcurrency=2`），实得：

```
PASS | 任务 completed | "completed"
PASS | 峰值并发达 2（真并发） | 2
PASS | 扇出：pm_plan→dev_module_a 与 pm_plan→dev_module_b 转移均记录
PASS | 节点全部完成 | ["pm_analyze","pm_plan","dev_module_a","dev_module_b","qa_verify"]
PASS | 各并行节点在独立 worktree 中运行（isolated=true 且路径非主工作区且两者互异）
        a=.../.agentflow-ws/task_xxx-dev_module_a-run_xxx
        b=.../.agentflow-ws/task_xxx-dev_module_b-run_xxx   (repo=.../task14-repo-xxx)
PASS | 主工作区包含 module_a 改动（src/module_a/index.ts 存在）
PASS | 主工作区包含 module_b 改动（src/module_b/index.ts 存在）
PASS | 落库 wp.merged（改动来自哪个节点） | ["dev_module_a","dev_module_b"]
PASS | node.succeeded 记录 changed_paths 与工作区标识 | {"changed":["src/module_a/index.ts"],"worktree_path":"...dev_module_a...","isolated":true}
PASS | join：qa_verify 在两个开发节点都结束之后才启动 | {"qaStart":8,"devEnds":[6,7]}
PASS | worktree 无残留（git worktree list 仅主工作区） | 1
```

对应关系（`tasks.md` 14.3 五项）：
- **扇出后多节点同时就绪**：转移记录含 `pm_plan→dev_module_a`、`pm_plan→dev_module_b`（同批次）；`selectedEdges[i]↔nodeIds[i]` 对齐。
- **并发执行且不超上限**：峰值并发 = 2（= 上限）。
- **独立 worktree + 合并回主工作区**：两个开发节点 `isolated=true` 且 worktree 路径互异；批次结束后主工作区确实含 `src/module_a/index.ts` 与 `src/module_b/index.ts`。
- **join 等待全部上游**：`qa_verify` 的启动时点在两个 dev 结束之后（timeline 索引 8 > {6,7}）。
- **可追溯**：`node.succeeded` 携带 `changed_paths` + `worktree_path` + `isolated`；批次合并结论以 `wp.merged` 落库（含 `node_id`）。
- **worktree 被回收**：运行后目标仓库 `git worktree list` 仅 1 行（主工作区）。

---

## 四、14.4 并发上限排队

基于真实 `parallel_dev.yaml` 追加第三个并行开发节点（`dev_module_c`，`owns=src/module_c/**`，与前两者不相交），使**就绪节点数 3 > 上限 2**，实得：

```
PASS | 任务 completed | "completed"
PASS | 峰值并发不超过上限 2 | 2
PASS | 第三个节点仍被执行（排队不丢弃）
PASS | 排队证据：dev_module_c 的启动晚于某个并行节点的结束 | {"cStart":7,"firstEnd":6}
PASS | worktree 无残留 | 1
timeline = [pm:start, pm:end, pm_planner:start, pm_planner:end,
            dev_module_a:start, dev_module_b:start,
            dev_module_a:end, dev_module_c:start,   ← 有空位才启动（排队）
            dev_module_b:end, dev_module_c:end, qa_engineer:start, qa_engineer:end]
```

仓库自带单测 `src/kernel/kernel.test.ts:971`「并发上限被遵守：3 个就绪节点在上限 2 下峰值并发为 2，超限节点排队等待」给出同向断言并通过。**结论：超限节点确实排队，不是一起跑。**

---

## 五、14.5 端到端冒烟 —— **本轮未执行（待用户确认）**

`tests/e2e/smoke.sh` **会真实调用 claude（约 $0.6/次）**，本轮按约束**未运行**。它验证的内容：

1. 在**独立临时 git 仓库**中起 `src/main.ts`（消费 `simple_dev`，`repoPath=临时仓库`，配置仍指向 AgentFlow 自身 `config`）；
2. `POST /api/tasks` 建任务（要求 agent 在目标仓库新增 `scripts/hello.sh` 并补 `README.md` 说明）→ 轮询任务顶层 `status` 直至 `completed`/`failed`（最长 40 分钟）；
3. 统计事件类型；校验每个 `log_ref` **确实指向存在的文件**（补单测未覆盖的一环）；
4. 打印目标仓库是否被 agent 改动、**AgentFlow 仓库是否保持干净**；
5. 最终判定 `status == completed` 为 PASS。

**执行前提（用户确认）**：确认消耗该额度；且确认 AgentFlow 仓库工作区干净（本次验证期间我未改任何受版本控制文件，`git status` 仅剩既有未跟踪文件）。

---

## 六、checklist A–F 逐条核对（结论 + 证据）

> 判定口径：只有给出 file:line / 命令输出 / 测试名的才判「满足」。

### 全局不变量

| # | 条目 | 结论 | 证据 |
| --- | --- | --- | --- |
| G1 | `tests/fixtures/` 下 4 个样本逐字未变 | **满足** | `git hash-object tests/fixtures/*.jsonl` 与 `git ls-tree HEAD tests/fixtures/` 四个 blob 哈希逐一相等（`eeda02b2…` / `0240eff6…` / `62a63582…` / `cbacbc9a…`）；`git status --porcelain -- tests/fixtures/` 为空；`git log -- tests/fixtures/` 最后一次改动为 `3354017`（本 spec 之前） |
| G2 | 未修改 `web/` 下任何文件 | **满足（限本 spec 的 Task 1–13 提交）／见说明** | 本 spec 的 9 个任务提交（`eb87f2a` `49f5dc9` `d1afcc2` `2e64c8f` `71537ee` `dde65f7` `1d6e93e` `47f5aa0` `bb229c7`）**均未触及 `web/`**（`git log --name-only -- web/` 未含它们）。**但须说明**：同一时间窗口内有一个**非本 spec 任务**的提交 `eeb5729`（2026-09-19 19:14「流程可见性与活性诊断」，`tasks.md` 中无对应任务）改了 `web/` 8 个文件。若按「窗口内全部提交」的严格口径，则窗口内含 `web/` 改动。 |
| G3 | 全量 `npx vitest run` 通过、`tsc --noEmit` 退出码 0 | **部分满足** | `tsc --noEmit` **exit 0**。全量 vitest **不通过**：3 failed，**全部在 `tests/website/`**（归用户，已排除）。本项目自身套件 `vitest run src` = **265/265 通过** |
| G4 | 未新增生产依赖 | **满足** | `package.json` 最后一次改动为 `1ea5f60`（本 spec 之前），本 spec 期间 `git log -- package.json` 无新提交；无新增 dependency |
| G5 | 相对导入均带 `.js` 后缀 | **满足** | 全 `src/**` 相对导入均带 `.js`（Grep 反例 `from '\.[^']*[^s]'` 仅命中 `web/src/*`（前端 bundler 解析，不属本项目 ESM 约束）） |
| G6 | 全程未真实调用 claude | **满足** | 内核/服务/投影测试用 `FakeRunner`（`src/runner/fake-runner.ts`）；runner 测试注入**假 binPath**（`/nonexistent/claude` 或生成的 node stub，见 `claude-code-runner.retry.test.ts:88`、`timeout.test.ts:49`、`spawn-error.test.ts:35`）；fixture 测试仅**解析归档文件**；`smoke.sh` 本轮未执行 |

### A. 配置层自解释

| # | 条目 | 结论 | 证据 |
| --- | --- | --- | --- |
| A1 | 角色声明职责/禁止/完成判据，加载后 API 可读 | **满足** | 6 个 `config/roles/*.yaml` 均含 `responsibilities`/`prohibitions`/`done_criteria`（如 `backend_dev.yaml:15-25`）；schema 必填（`schema.ts`）；`real-config.test.ts:43`「每个角色都声明了职责边界、禁止事项、完成判据，且加载后可读」；`server.test.ts:686`「GET /api/roles 返回全部角色的职责/禁止事项/完成判据/可写路径/可读路径/模型/预算」 |
| A2 | `inputs`/`outputs` 与 `consumes`/`produces` 唯一权威来源已确定并在文档写明 | **满足** | 代码：`loader.ts:107-112`、`:135-152`（以角色 inputs/outputs 回填派生字段）；文档：`design.md:318-320`「契约唯一来源：角色的 `inputs`/`outputs` 是**权威**声明；工作流节点的 `consumes`/`produces` 由它们**派生**…冲突即报错」；`spec.md:21` |
| A3 | 冲突时加载期报错，指明角色 id、节点 id、冲突字段 | **满足** | `loader.ts:91-104`（错误串含 `节点 ${node.id}`、`角色 ${role.id}`、`字段 consumes/inputs`）；`loader.test.ts:238`（consumes/inputs）、`:254`（produces/outputs）断言错误文案 |
| A4 | 一致性校验有变异验证（去掉校验后测试变红） | **满足** | 本轮实测：把 `loader.ts:140` 的 `assertNodeContractMatchesRole(...)` 注释掉 → `vitest run src/config/loader.test.ts -t '契约唯一来源'` = **2 failed \| 2 passed**（两条契约冲突用例变红）；还原后 `git diff` 为空、无 MUTATION 残留、套件复绿 |
| A5 | 边含人类可读说明与失败语义且加载后可读 | **满足** | `simple_dev.yaml:41-52` / `parallel_dev.yaml:73-102` 每条边均有 `description` + `on_missing`；`loader.test.ts:420`「边声明的 description 与 on_missing 在加载后可读」；`real-config.test.ts:52` |
| A6 | 节点含进入条件与人类可读说明 | **满足** | `simple_dev.yaml:11-39` / `parallel_dev.yaml:22-71` 每节点均有 `description` + `entry_condition`；`loader.test.ts:302`；`real-config.test.ts:52` |

### B. 引擎层可解释

| # | 条目 | 结论 | 证据 |
| --- | --- | --- | --- |
| B1 | 转移记录含：所用边、条件原文、人类可读说明、判定依据 | **满足** | `kernel.ts:365-379` 写 `edge`/`when`/`edge_description`/`artifact_statuses`；`kernel.test.ts:547` 断言这四项（`edge={from,to}`、`when=all(...)`、`edge_description='需求已澄清'`、`artifact_statuses=[{requirement,ok}]`） |
| B2 | 无法流转时原因**同时**含未满足条件、产物实际状态、分类化原因 | **满足** | `state-machine.ts:210-225`（`unmetConditions`+`artifactStatuses`+`category: condition_unmet`）；`kernel.ts:231-236` 落库；`kernel.test.ts:599` 断言三项并存 |
| B3 | 稳定原因分类枚举 + 原始 CLI 文本作为附加信息保留 | **满足** | `events.ts:60-80`（`FAILURE_REASONS` 六值 + `FAILURE_REASON_LABELS` 中文）；`kernel.test.ts:448` 断言 `reason_category`/`reason_label` 且 `error` 仍含 `error_max_structured_output_retries` |
| B4 | 分类写入有变异验证（写死/写错后测试变红） | **满足** | 本轮实测：`kernel.ts:584` `failNode(failureReason ?? 'other', …)` 改为写死 `'other'` → `vitest run src/kernel/kernel.test.ts -t '失败原因分类化'` = **2 failed \| 2 passed**（structured_output / timeout 两条变红，`Expected "timeout" Received "other"`）；还原后复绿 |
| B5 | `decideNext` 返回结构化结果（激活节点集合/选中边/未选中边及原因/失败与等待区分），断言覆盖各分支 | **满足** | `state-machine.ts:46-64`（`Decision` 三态 + `selectedEdges`/`skippedEdges`/`failure`）；`state-machine.test.ts`（多出边同时激活、join 未满足→wait、join 满足→start、目标去重）；`kernel.test.ts:900`（多节点批次） |

### C. 后端 API

| # | 条目 | 结论 | 证据 |
| --- | --- | --- | --- |
| C1 | 角色列表与详情返回职责/禁止/完成判据/可写路径/可读路径/模型/预算 | **满足** | `server.ts:910`（列表）、`:924`（详情）、`roleView:133-163`；`server.test.ts:686` / `:719` |
| C2 | 「某任务的角色使用情况」返回 角色↔节点↔状态↔产出类型↔耗时↔花费 | **满足** | `server.ts:947` + `buildRoleUsage:416-478`；`server.test.ts:748` |
| C3 | 「某任务的流转视图」返回拓扑 + 每节点进入理由、状态、阻塞原因 | **满足** | `server.ts:957` + `buildFlowView:532-674`；`server.test.ts:808` / `:845`（阻塞原因） |
| C4 | 三类 API 的空/边界情形有断言 | **满足** | `server.test.ts:792`（无节点任务→roles 空数组）、`:875`（未跑过任务→not_started/无转移）、`:739`/`:800`/`:891`（503/404） |
| C5 | 角色编辑 API：合法编辑写回后重载一致 | **满足** | `server.ts:972`（PUT）；`server.test.ts:909` |
| C6 | 非法编辑返回明确校验错误，配置文件逐字不变 | **满足** | `server.test.ts:939`（预算为负→400）、`:955`（responsibilities 空→400）、`:970`（改 outputs 破坏契约→422），三条均断言配置文件内容不变 |
| C7 | 编辑校验有变异验证 | **满足** | 本轮实测：把 `server.ts:1019` 的 `validateRoleCandidate(...)` 注释掉 → `vitest run src/server/server.test.ts -t '角色编辑 API'` = **1 failed \| 4 passed**（「破坏契约一致性的编辑（改 outputs）」期望 422 实得 200 → 非法编辑将被落盘）；还原后复绿 |

### D. 路径安全闸

| # | 条目 | 结论 | 证据 |
| --- | --- | --- | --- |
| D1 | 节点结束后采集其工作区实际变更路径 | **满足** | `path-guard.ts:111` `collectChangedPaths`（`git status --porcelain --untracked-files=all`，覆盖未跟踪新文件）；`kernel.ts:509` |
| D2 | 越界→违规事件+越界清单，任务不静默继续 | **满足** | `kernel.ts:635-655`：写 `artifact.invalidated`（含 `out_of_bounds_paths`/`changed_paths`）→ 节点判 `failed`（`permission_denied`）→ 任务 `failed`；`kernel.test.ts:661` |
| D3 | 未越界不产生违规记录（反向断言） | **满足** | `kernel.test.ts:700`「未越界时不误报：变更全在 owns 内，正常完成且无违规记录」；`path-guard.test.ts:32` |
| D4 | `owns` 重叠检测覆盖通配前缀重叠 | **满足** | `path-guard.ts:182-206`（段级 DP）；`path-guard.test.ts:98`（`src/**`∩`src/foo/**`）、`:115`、`:120` |
| D5 | 重叠检测在批次启动之前执行，给出两节点与重叠路径段 | **满足** | `kernel.ts:246-268`（在启动 `queue`/`launch` 之前调用 `checkBatchOwns`）；`path-guard.ts:281-297`（`reason` 写明两节点+两模式+公共前缀）；`kernel.test.ts:1027`（reject 时两个 dev 一个都没启动，仅 `pm_analyze` 跑过） |
| D6 | 重叠被挡 / 不相交被允许：两方向都有断言 | **满足** | `kernel.test.ts:1005`（重叠→峰值 1，串行）、`:1027`（reject 启动前拒绝）；`path-guard.test.ts:137`（挡）、`:165`（不相交允许） |

### E. 并行协作

| # | 条目 | 结论 | 证据 |
| --- | --- | --- | --- |
| E1 | 决策支持多出边同时激活，有断言 | **满足** | `state-machine.ts:161-208`；`state-machine.test.ts`（多出边）；`kernel.test.ts:900`（dev_a/dev_b 同批次） |
| E2 | join 未全部终态不启动；全部终态后启动（两方向） | **满足** | `kernel.test.ts:931`（方向一 `currentNodeIds=['dev_b']` 且 `qa_verify` 无 `node.started`；方向二放行后启动完成）；本轮 14.3 `qaStart=8 > devEnds=[6,7]` |
| E3 | 主循环可同时推进多个就绪节点 | **满足** | `kernel.ts:196-207`（队列 + 在途集合 + `Promise.race`） |
| E4 | `AGENTFLOW_GLOBAL_CONCURRENCY` **被真正消费** | **满足** | 全生产链路：`env.ts:96` `globalConcurrency: readInt(merged,'AGENTFLOW_GLOBAL_CONCURRENCY',…)` → `main.ts:30` `globalConcurrency: env.globalConcurrency` → `kernel.ts:41`(deps 字段) / `kernel.ts:103` `Math.max(1, deps.globalConcurrency ?? 1)`。Grep 确认生产代码读取该值（不再是「有配置无消费者」） |
| E5 | 实际并发不超上限，超限排队；有断言 | **满足** | `kernel.test.ts:971`（3 节点上限 2→峰值 2、`dev_c` 启动晚于某 dev 结束）；本轮 14.4 复现（`cStart=7 > firstEnd=6`，峰值 2） |
| E6 | 并行节点各在独立 worktree 中运行，结束后回收 | **满足** | `scheduler.ts:69-120`（worktree 创建）+`:126-158`（回收）；`kernel.test.ts:1173`（`git worktree list` 长度 1）；本轮 14.3（两 worktree 路径互异、非主工作区；`git worktree list`=1） |
| E7 | 批次结束后改动合并回主工作区（断言主工作区含各节点改动） | **满足** | `merge.ts:42-108`；`kernel.test.ts:1173`；本轮 14.3（主工作区含 `src/module_a/index.ts` 与 `src/module_b/index.ts`） |
| E8 | 每节点事件记录改动路径与工作区标识，有断言 | **满足** | `kernel.ts:523-528`（`changed_paths`/`worktree_path`/`isolated`/`worktree_created`）写入 `node.succeeded`/`node.failed`；`kernel.ts:157-170` 写 `wp.merged`；本轮 14.3 断言 `node.succeeded.changed_paths` 与 `worktree_path` |
| E9 | **串行等价性**：不产生多就绪节点时行为等价，既有单测保持通过 | **满足** | 见 §二：真实 `simple_dev` 实跑断言（转移序列/decidedBy/requests）；`kernel.test.ts:580`；本项目自身 265/265 全绿 |
| E10 | `simple_dev.yaml` 作为串行基线行为未变 | **满足** | 同上；`real-config.test.ts:33`「simple_dev 所有节点 isolate 均为 false（串行基线护栏）」 |
| E11 | 新增并行示例各并行节点 `owns` 互不相交，能通过占用检查 | **满足** | `real-config.test.ts:110`（`detectOwnsOverlaps===[]` 且 `checkBatchOwns().mode==='parallel'`）；本轮 14.3 真跑未被降级（峰值 2 即证明 `parallel` 生效） |

### F. 文档一致性

| # | 条目 | 结论 | 证据 |
| --- | --- | --- | --- |
| F1 | design.md 角色定义/工作流定义/决策语义/并发与隔离表述已同步且不矛盾 | **满足** | `design.md:305-331`（§7.2 角色自解释+契约唯一来源+`owns` 已强制+历史注记）、`:567-591`（§10 并发/隔离/fan-out/join/合并/串行等价/`parallel_dev`/未覆盖）、`:918-940`（§16 Phase 1/2 逐条） |
| F2 | 计划文档受影响章节已同步 | **满足** | `plans/2026-09-18-agentflow-phase0-phase1.md:27-33`（「2026-09-19 修订」：并行已落地、`isolate:false` 仅仍适用 `simple_dev`、串行验收行为未变、codex/G1–G3 仍未实现） |
| F3 | `记录.md` 已更新：`globalConcurrency` 已被消费、`owns` 已强制、并发已实现 | **满足** | `记录.md:965-991`（Task 9/10 节）、`:1002-1019`（Task 11 节）、`:1042-1071`（Task 12/13 节）；均写明「首次消费 `AGENTFLOW_GLOBAL_CONCURRENCY`」「`owns` 已强制」 |
| F4 | `记录.md` 不再存在「并行度恒为 0」类与实现矛盾的表述 | **满足** | `记录.md:199-201`（原条目加「2026-09-19 后记：…已由 Task 9/10/11 落地…"并行度恒为 0" 不再成立」）、`:817`（未完成表该行改写为 ✅ 已实现，原缺口降为「保留备查」）、`:924`（同）、`:970`/`:1048`（显式「本节取代…已过期表述」） |
| F5 | 文档如实列出仍未覆盖范围（PM 拆解质量自动保证、G1–G3 卡点、前端渲染） | **满足** | `design.md:589-591`、`:935-940`；`记录.md:1073-1079`（PM 拆解质量自动保证 / G1–G3 / 前端渲染 / `serialization_key` / worktree 池 / `integrator` / 每引擎并发上限） |

### G. 待用户确认后执行

| # | 条目 | 结论 | 证据 |
| --- | --- | --- | --- |
| G1 | 端到端冒烟 `tests/e2e/smoke.sh` 通过 | **未执行（待用户确认）** | 见 §五。会真实消耗 claude 额度（约 $0.6/次），本轮按约束未运行 |

---

## 七、发现的缺陷 / 需控制者知悉（按严重度）

1. **中｜AC5 失败的跨任务因果关系（需官网负责人处理）**：`tests/website/website.test.ts:447` 写死「只有 3 个角色」，而本 spec Task 12 **必须**新增 3 个角色（`pm_planner` / `backend_dev_module_a` / `backend_dev_module_b`）才能让两个开发节点 `owns` 不相交。两侧并行开发产生交界冲突，非本 spec 可自行解决（禁止改 `tests/website/`）。
2. **低｜未跟踪的 `README.md` 仍与实现矛盾**：`README.md:93`「`AGENTFLOW_GLOBAL_CONCURRENCY`…**当前无消费者**」、`:179`「并发调度 ❌ 未实现…无消费者」、`:181`「`owns` 路径级强制 ❌ 未实现」、`:183`「只有 `simple_dev`…3 个角色」。该文件**未被 git 跟踪**（`git status` 显示 `?? README.md`），不在本 spec 的 F 节文档范围（F 只要求 spec/计划/记录.md），疑似并发 website/用户任务产物，故本 spec 未改。
3. **低｜`web/` 内仍有「无消费者」表述**：`web/src/App.tsx:434`、`web/src/components/NodeCostView.tsx:94` 仍写「`env.globalConcurrency` 无消费者」——属用户掌握的 `web/`，本 spec 明确不碰，需前端侧后续同步。
4. **信息｜`on_missing` 目前是声明式的**：加载期解析并暴露（`GET /api/tasks/:id/flow`），但**内核尚未消费**它区分 fail/wait；join 的「等全部上游」由主循环「有在途节点即 wait」保证。已如实登记（`记录.md:1088-1090`），非缺陷。
5. **信息｜`parallel_dev` 未接线**：`main.ts:12` 仍固定加载 `simple_dev`；`parallel_dev` 配置可加载、可校验、可真跑（本轮已验证），但生产入口未切换。Task 12 未要求接线。

---

## 八、结论摘要

- 本项目自身套件 **265/265 全绿**，`tsc --noEmit` **exit 0**；全量唯一失败为 `tests/website/`（3 条，归用户，明确排除）。
- 串行等价性、并行全链路（扇出→并发不超限→独立 worktree→合并回主工作区→join 等待上游→可追溯→worktree 回收）、并发排队**均以实际断言验证通过**。
- checklist A–F **全部条目满足**，其中三条「变异验证」条目**本轮亲自复现**（loader 契约校验、失败分类、编辑校验），均已精确还原（`git diff` 为空、无 MUTATION 残留）。
- 唯一需用户判定的口径分歧：`web/` 在本 spec 任务提交中未被改，但**同窗口内存在非本 spec 的 `eeb5729` 改了 `web/`**。
- 4 个归档 fixture **逐字未变**；未新增依赖；未真实调用 claude；`smoke.sh` 待用户确认后执行。