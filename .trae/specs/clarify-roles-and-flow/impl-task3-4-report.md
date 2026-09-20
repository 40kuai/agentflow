# 实现报告：Task 3（失败原因分类化）+ Task 4（决策结构化）

- 规格：`.trae/specs/clarify-roles-and-flow/spec.md`（ADDED「流程流转的可解释性」/ MODIFIED「决策 `decideNext`」）
- 任务：`.trae/specs/clarify-roles-and-flow/tasks.md` Task 3 / Task 4
- 核对：`.trae/specs/clarify-roles-and-flow/checklist.md` B 节（引擎层可解释）
- 分支：`main`｜未新增依赖｜未真实调用 claude｜未触碰全局环境｜**未改 `web/`**｜**未改 `tests/fixtures/` 4 个归档样本**

## 1. 逐处改动（file:line）

### Task 3：失败原因分类化

| 文件:行 | 改了什么 |
| --- | --- |
| `src/shared/events.ts:60` | 新增稳定枚举 `FAILURE_REASONS`（元组） |
| `src/shared/events.ts:69` | `FailureReasonSchema` + `FailureReason` 类型（zod enum） |
| `src/shared/events.ts:73` | `FAILURE_REASON_LABELS`：枚举 → 中文说明 |
| `src/runner/types.ts:28` | `RunnerEvent` 新增 `{ kind:'failure'; reason; detail }`（已分类失败信号 + 原始文本） |
| `src/runner/claude-code-runner.ts:111` | `SUBTYPE_TO_FAILURE_REASON`：已知 CLI subtype → 分类的映射表 |
| `src/runner/claude-code-runner.ts:125` | `classifyResultLine()`：一行 stream-json → 分类；**第一步复用既有 `isStructuredOutputRetriesExhausted`** |
| `src/runner/claude-code-runner.ts:47` | `parseStreamLine` 的 `is_error` 分支在保留 log 原文的同时产出 `failure` 事件 |
| `src/runner/claude-code-runner.ts:372` | 超时路径补发 `failure(reason:'timeout')`（先 log 后 failure，`exited` 仍是最后一条） |
| `src/runner/claude-code-runner.ts:374` | spawn 失败路径补发 `failure(reason:'other')` |
| `src/kernel/kernel.ts:283` | 内核消费 `failure` 事件（`failureReason` / `failureDetail`，**最后一条为准**） |
| `src/kernel/kernel.ts:305` | `failNode()`：统一落 `node.failed` + `task.failed`，均带 `reason_category` + `reason_label`，原文保留在 `error` / `raw` |
| `src/kernel/kernel.ts:340/346/354` | 退出码非 0 / 零产物 / 载荷不合规 三条失败路径接入分类 |
| `src/kernel/kernel.ts:79` | maxSteps 超限（死循环）→ `other` |
| `src/kernel/kernel.ts:138/153` | 节点不在工作流 / 角色未注册 → `other` |

### Task 4：决策结构化

| 文件:行 | 改了什么 |
| --- | --- |
| `src/kernel/state-machine.ts:17` | `EdgeEvaluation`：边的求值结果（`from/to/when/description/matched/reason`） |
| `src/kernel/state-machine.ts:30` | `DecisionFailure`：`category` + `unmetConditions` + `artifactStatuses` |
| `src/kernel/state-machine.ts:46` | `Decision`：`start.nodeIds[]` + `selectedEdges[]` + `skippedEdges[]`；`end.failure?`；`wait.runningNodeIds[]` |
| `src/kernel/state-machine.ts:73` | `evaluateEdge()`（原 `edgeMatches`）：`description` 原文透传，未选中原因可读 |
| `src/kernel/state-machine.ts:146-204` | 无可用转移 → `failed` + `failure{category:'condition_unmet', unmetConditions, artifactStatuses}` |
| `src/kernel/kernel.ts:120` | 主循环消费 `nodeIds[]`（**串行** `await`，fan-out 留给后续任务） |
| `src/kernel/kernel.ts:104` | `end.failed` 时把分类/中文说明/未满足条件/产物状态写入 `task.failed` |
| `src/kernel/kernel.ts:174-188` | `transfer.decided` 记录：`edge` / `when` / `edge_description` / `artifact_statuses` |
| `src/kernel/projector.ts:16` | `TransferRecord` 新增可选 `edge` / `when` / `edgeDescription` / `artifactStatuses` |
| `src/kernel/projector.ts:194-224` | 投影器按「存在才读」填充，旧事件缺失这些键时一律省略（**旧事件可回放**） |

## 2. 分类枚举取值与映射表

枚举取值（稳定，不随 CLI 版本扩枚举；未知一律 `other`）：

| 枚举值 | 中文说明 |
| --- | --- |
| `permission_denied` | 权限被拒 |
| `timeout` | 超时 |
| `invalid_payload` | 载荷不合规 |
| `structured_output_retries_exhausted` | 结构化输出重试耗尽 |
| `condition_unmet` | 条件不满足 |
| `other` | 其他 |

runner 层映射（`src/runner/claude-code-runner.ts:111`）：

| 来源信号 | 分类 | 说明 |
| --- | --- | --- |
| `isStructuredOutputRetriesExhausted()`（`subtype=error_max_structured_output_retries`） | `structured_output_retries_exhausted` | **直接复用降级重试的既有判据**，分类与降级行为同源 |
| `result.subtype=error_max_turns` / `error_during_execution` | `other` | 已登记的已知 subtype |
| `result.permission_denials` 非空，或错误文本含 `permission` / `requires approval` / `not allowed` | `permission_denied` | 判据取自 CLI 真实字段，不新造信号 |
| 超时（`timedOut` 标志） | `timeout` | core 在 close 时补发 |
| spawn 失败（ENOENT 等） | `other` | core 在 `error` 回调补发 |
| 其他 `is_error`（如认证失败） | `null` → 内核落 `other` | 归档认证失败样本即此类 |

内核侧映射：退出路径取 runner 分类（缺失则 `other`）；零产物 → runner 分类或 `other`；载荷校验失败 → `invalid_payload`；`decideNext` 无条件满足 → `condition_unmet`；其余控制路径（死循环 / 未注册角色 / 节点缺失 / 超步数）→ `other`。

## 3. `decideNext` 新结构形状

```ts
type EdgeEvaluation = {
  from: string; to: string;
  when: string | null;          // 条件表达式原文（无条件边为 null）
  description: string | null;   // 人类可读说明：直接取工作流边的 description
  matched: boolean;
  reason: string;               // 选中/未选中的原因
};
type DecisionFailure = {
  category: FailureReason;
  unmetConditions: string[];               // 未满足的条件（原文）
  artifactStatuses: { type; status }[];    // 判定依据：相关产物实际状态
};
type Decision =
  | { kind:'start'; nodeIds:string[]; selectedEdges:EdgeEvaluation[]; skippedEdges:EdgeEvaluation[]; reason:string }
  | { kind:'end'; status:'completed'|'failed'; reason:string; failure?: DecisionFailure }
  | { kind:'wait'; reason:string; runningNodeIds:string[] };
```

- **激活节点集合**：`start.nodeIds`（数组，当前串行只含 1 个，为 fan-out 铺路）。
- **选中边**：`start.selectedEdges`。**未选中边及原因**：`start.skippedEdges`。
- **失败/等待区分**：`end/status:'failed'`（无条件满足） vs `wait`（`runningNodeIds` 非空）。

## 4. 串行等价性如何验证

1. **决策层**：`simple_dev` 三节点直线的转移序列不变——`state.transfers` 仍为 `→pm_analyze` / `pm_analyze→dev_implement` / `dev_implement→qa_verify`，`decidedBy` 全为 `rule`；新增用例「串行直线流程的转移序列与决策来源保持不变（串行等价性）」直接钉住。
2. **内核层**：`nodeIds` 递归恒为长度 1，主循环是 `for (… ) await runNode(…)` 的**串行**消费，与改动前 `await runNode(decision.nodeId, …)` 的推进顺序/次数一致；`runner.requests` 长度仍为 3。
3. **既有单测**：`kernel.test.ts` 24/24 全绿（含原「三节点自动流转」「事件重放一致」「转移理由」等），`state-machine.test.ts` 12/12 全绿（仅把断言从旧的 `nodeId` 改为新结构 `nodeIds`/`selectedEdges`，**未放宽任何断言语义**——原 `toEqual` 仍为 `toEqual`，并额外加了边与原因的断言）。
4. **降级重试行为未变**：`claude-code-runner.retry.test.ts` 3/3 全绿（既有 `isStructuredOutputRetriesExhausted` 判据原样复用，未改触发条件）。

## 5. 变异验证（附实际输出）

**变异 1（Task 3，分类写错）**：`src/kernel/kernel.ts:340` 的 `failNode(failureReason ?? 'other', …)` 改为 `failNode('invalid_payload', …)`
→ `npx vitest run src/kernel/kernel.test.ts`：**`Tests 3 failed | 21 passed (24)`**，报 `expected 'invalid_payload' to be 'structured_output_retries_exhausted' / 'timeout' / 'other'`。已还原。

**变异 2（Task 3，分类写死）**：`src/runner/claude-code-runner.ts:136` 复用判据处 `return 'structured_output_retries_exhausted'` 改为 `return 'other'`
→ `npx vitest run src/runner/claude-code-runner.fixture.test.ts`：**`Tests 2 failed | 7 passed (9)`**，报 `- "reason": "structured_output_retries_exhausted"` / `+ "reason": "other"`。已还原。

**变异 3（Task 4，未选中边不记录）**：`src/kernel/state-machine.ts:165` 去掉 `skippedEdges.push(evaluation)`
→ `npx vitest run src/kernel/state-machine.test.ts`：**`Tests 3 failed | 9 passed (12)`**，报 `expected [] to deeply equal [ 'nonexistent.path == 1' ]`（未满足条件丢失）、以及 `skippedEdges` 断言失败。已还原。

## 6. 测试与 tsc 数字

- `npx tsc --noEmit` → **退出码 0**（`TSC_OK`）
- 本次涉及的 7 个测试文件：**`Tests 76 passed (76)`**（7 files）
- 全量 `npx vitest run` → **`Tests 229 passed | 1 failed (230)`**（21 files）
  - 新增：events 2 条、runner fixture 5 条、state-machine（原 12 条改写并加断言）、kernel 7 条
  - **唯一失败 `tests/website/website.test.ts`（37 条中 1 条）与本次无关**：它断言仓库根存在 `website/` 而实际落在 `src/website`——该测试与 `src/website/`、`tests/website/` 均属**并发进程的 website 任务**（未跟踪文件），非本任务产物，我未触碰。

## 7. 疑虑 / 需知悉

1. **并发进程干扰（已处置）**：实施期间有另一进程在写同一仓库并**回退了 5 处早期编辑**（kernel.ts 的 `failureReason/failureDetail` 声明、projector.ts 的 `TransferRecord`、types.ts 与两个测试文件的 import）。我按「先读再改、不覆盖他人改动」的约束逐处核对后重新补上，随后 `tsc` 与相关测试全绿。若合并时发现同类不一致，请以本报告的 file:line 清单为准复核。
2. **`记录.md` 未改**：该文件当前已被上述并发进程修改（`git status` 显示 `M 记录.md`），为避免覆盖/夹带他人改动，本任务**未编辑也未提交** `记录.md`；工作记录以本报告与提交信息为准。
3. **降级场景的分类以「终止性失败」为准**：`createClaudeCodeRunner` 在重试耗尽后会再跑一次；两次尝试都会发出 `failure` 事件，内核**以最后一条为准**。若降级重试成功，则 `exitCode=0` 且产出 artifact，失败信号被自然忽略；若降级重试再失败，分类反映的是最后一次尝试。这是刻意的取舍（终止性失败才是任务的真实死因）。
4. **`permission_denied` 的判据**基于 CLI 真实字段 `permission_denials` 与错误文本迹象，当前无该 subtype 的归档样本，故以合成样本（字段名取自真实 CLI 输出）覆盖；分类本身是稳定枚举，不影响其他路径。
5. `start.skippedEdges` 只含**首条匹配边之前**被求值的边（沿用既有「首条匹配即返回」语义）；匹配边之后的边不求值，与改动前行为一致。