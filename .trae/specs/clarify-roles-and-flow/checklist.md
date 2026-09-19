# Checklist

> 每条都必须是**可验证的事实断言**，不接受"看起来对了"。涉及行为变更的条目需附变异验证或失败前后对照。
> 验收证据见 `.trae/specs/clarify-roles-and-flow/impl-task14-report.md`（A–F 逐条结论与证据）。

## 全局不变量（任何一条不成立即整体不通过）

- [x] `tests/fixtures/` 下 4 个真实归档样本（`claude-stream-sample.jsonl`、`-structured-sample.jsonl`、`-plain-sample.jsonl`、`-maxretries-sample.jsonl`）内容**逐字未变**（工作区 blob 哈希与 HEAD `ls-tree` 逐一相等）
- [x] **未修改 `web/` 下任何文件**（本 spec 的 9 个任务提交均未触及 `web/`；同窗口的 `web/` 改动来自用户自己的提交 `eeb5729`）
- [x] 全量 `npx vitest run` 通过、`npx tsc --noEmit` 退出码 0（**本项目自身套件 265/265 全绿、22 文件**；`tests/website/` 有 3 条失败，属用户官网任务，已在 tasks.md 遗留项登记并排除）
- [x] 未新增生产依赖
- [x] 相对导入均带 `.js` 后缀（ESM 约定）
- [x] 全程**未真实调用 claude**（除最后需用户确认的端到端冒烟外）

## A. 配置层自解释

- [x] 每个角色在配置中声明了职责边界、禁止事项、完成判据，且加载后可通过 API 读回
- [x] `inputs`/`outputs` 与 `consumes`/`produces` 的**唯一权威来源已确定并在文档中写明**（角色 `inputs`/`outputs` 为权威，节点侧为派生）
- [x] 当角色 `outputs` 与节点 `produces` 冲突时，**加载期报错**，错误信息指明角色 id、节点 id、冲突字段
- [x] 上述一致性校验有变异验证：**去掉校验后至少一条测试变红**（2 failed）
- [x] 工作流的边含人类可读说明与条件不满足时的失败语义，且该语义在加载后可读
- [x] 节点含进入条件与人类可读说明

## B. 引擎层可解释

- [x] 转移记录中包含：所用边、条件表达式原文、该表达式的**人类可读说明**、判定依据（相关产物状态）
- [x] 无法流转时，失败原因**同时**包含：未满足的条件、相关产物的实际状态、分类化原因
- [x] 存在**稳定的原因分类枚举**（权限被拒 / 超时 / 载荷不合规 / 结构化输出重试耗尽 / 条件不满足 / 其他），且原始 CLI 文本作为附加信息保留
- [x] 分类写入有变异验证：**把分类写死或写错后至少一条测试变红**（内核 2 failed ／ runner 2 failed）
- [x] `decideNext` 返回结构化结果（激活节点集合、选中边、未选中边及原因、失败与等待的区分），断言覆盖各分支

## C. 后端 API（结构化支撑，不碰前端）

- [x] 角色列表与详情 API 返回职责/禁止事项/完成判据/可写路径/可读路径/模型/预算
- [x] "某任务的角色使用情况" API 返回角色↔节点↔状态↔产出类型↔耗时↔花费
- [x] "某任务的流转视图" API 返回拓扑 + 每节点的进入理由、状态、阻塞原因
- [x] 三类 API 的空/边界情形（无角色、无流转、未知任务）有断言
- [x] 角色编辑 API：合法编辑写回后重新加载得到一致结果
- [x] 角色编辑 API：非法编辑返回明确校验错误，且**配置文件内容与编辑前逐字相同**（原子写：临时文件 + rename，失败回滚）
- [x] 编辑校验有变异验证：**跳过校验后"非法编辑不落盘"的断言变红**（`expected 200 to be 422`）

## D. 路径安全闸（并行的前置）

- [x] 节点结束后会采集其工作区实际变更路径
- [x] 实际变更路径超出 `owns` 时**产生违规事件并附越界路径清单**，任务不据此静默继续（节点判 `failed` + 分类 `permission_denied`，产物 `artifact.invalidated` 作废）
- [x] 未越界时**不产生**违规记录（反向断言存在）
- [x] `owns` 重叠检测覆盖通配前缀重叠（非仅字面相等）（段级 DP：`src/**` ↔ `src/foo/**` 判重叠；对真实路径为保守超集，宁可退化为串行）
- [x] 重叠检测在**批次启动之前**执行，重叠时给出涉及的两个节点与重叠路径段（`kernel.ts` 中位于 `await runNode` 之前）
- [x] 重叠被挡 / 不相交被允许：**两个方向都有断言**

## E. 并行协作

- [x] 决策支持多出边同时激活（一批次多个就绪节点），有断言
- [x] join 节点在其上游未全部进入终态时**不启动**；全部终态后启动——两个方向都有断言（`qa_verify` 启动索引 8 > 两 dev 结束索引 [6,7]）
- [x] 主循环可同时推进多个就绪节点
- [x] `AGENTFLOW_GLOBAL_CONCURRENCY` **被真正消费**（`src/config/env.ts` 解析 → `src/main.ts` 注入 → `src/kernel/kernel.ts` 消费；不再是"有配置无消费者"）
- [x] 实际并发数不超过该上限，超出的节点进入排队；有断言（就绪 3 > 上限 2 时峰值 = 2，第 3 个节点启动晚于首个结束）
- [x] 并行节点在**各自独立 worktree** 中运行，且批次结束后 worktree 被回收（`git worktree list` 无残留）
- [x] 批次结束后各节点改动被**合并回主工作区**：断言主工作区确实包含各节点改动
- [x] 每个节点事件记录其改动路径与工作区标识（"改动来自哪个节点"可追溯），有断言
- [x] **串行等价性**：不产生多就绪节点时行为与改动前等价，且既有全部单测保持通过（真实 `simple_dev.yaml` 实跑：转移序列、`decidedBy` 全 `rule`、`runner.requests=3`、无隔离）
- [x] `config/workflows/simple_dev.yaml` 作为串行基线**行为未变**
- [x] 新增的并行示例工作流的各并行节点 `owns` **互不相交**，能通过占用检查（`detectOwnsOverlaps === []`、`mode === 'parallel'`）

## F. 文档一致性

- [x] spec（`docs/superpowers/specs/...design.md`）中关于角色定义、工作流定义、决策语义、并发与隔离的表述已同步，且与实现不矛盾
- [x] 计划文档中受影响章节已同步
- [x] `记录.md` 已更新：`globalConcurrency` 已被消费、`owns` 已强制、并发已实现
- [x] `记录.md` 中**不再存在**"并行度恒为 0"这类与实现矛盾的表述
- [x] 文档如实列出**本次仍未覆盖**的范围（PM 拆解质量的自动保证、G1–G3 卡点、前端渲染）

## G. 待用户确认后执行

- [x] 端到端冒烟 `tests/e2e/smoke.sh` 通过（**已 PASS**：2026-09-19 一次跑通，3/3 节点 succeeded、`completedNodeIds` 为三节点、
  3 条 `transfer.decided`（`decided_by=rule`，带 `reason`）、3 个 artifact（requirement/code_diff/test_report 均 `status=ok`）、
  `self_test_result=passed`、3/3 `log_ref` 存在、AgentFlow 仓库未被 agent 触碰；实测总花费 **$0.4115058**；端口被占用时脚本自动改用空闲端口，绝不静默白跑）

## 范围外的已知过期文案（不属本 spec 验收项，如实登记）

以下位置仍含与实现矛盾的表述，但**不在本 spec 范围**（属用户文件或未跟踪文件），按"不回退用户改动"原则未处理：

- 未跟踪的 `README.md`（写「`globalConcurrency` 无消费者 / 并发未实现 / `owns` 未强制 / 仅 3 角色」）
- `web/src/App.tsx`、`web/src/components/NodeCostView.tsx` 内的同类表述（`web/` 归用户）