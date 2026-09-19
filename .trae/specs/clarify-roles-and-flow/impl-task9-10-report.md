# Task 9 + Task 10 实施报告：拓扑 fan-out/join + 并发执行与上限

> 规格 `.trae/specs/clarify-roles-and-flow/spec.md`「并发执行与确定性合并」；任务清单 Task 9 / Task 10。
> 边界：**未改 `web/`、`src/website/`、`tests/website/`、4 个归档 fixture、`.env.example`**；未新增依赖；未真实调用 claude（并发测试用自建时序 runner）；
> **未实现 Task 11（worktree 隔离与合并）/ Task 12（并行示例工作流）**。分支 `main`。

---

## 1. 每处改了什么（file:line）

### 1.1 决策层：fan-out（`src/kernel/state-machine.ts`）

| 位置 | 改动 |
| --- | --- |
| `src/kernel/state-machine.ts:161-208` | `decideNext` 由「取**第一条**匹配出边即 `return`」改为「遍历**全部**出边，收集**所有条件成立**的目标」。`nodeIds[]` 与 `selectedEdges[i]` 一一对齐；同一目标被多条入边命中时**去重**（`:189`）。`skippedEdges` 收集全部未匹配边。 |
| `src/kernel/state-machine.ts:194-208` | 有任一匹配边即返回 `start`。**单条匹配边时** `reason = selectedEdges[0].reason`——与旧实现逐字一致；多条时才给出汇总文案。 |
| `src/kernel/state-machine.ts:124-133`（未改动，但被复用） | **join 语义的决策侧依据**：`state.currentNodeIds.length > 0` 一律返回 `kind:'wait'`。join 节点的任一上游仍在运行都会命中此分支 → 不启动。 |
| `src/kernel/state-machine.ts:179-186`（未改动） | 死循环保护（`visitCounts >= MAX_NODE_VISITS`）逐个匹配目标判定，语义不变。 |

> 说明：任务书称「决策层已支持多于一个」，实际返回**形状**（`nodeIds: string[]`）已支持，但**逻辑**仍是首条命中即返回。SubTask 9.1 要求「让决策支持多出边同时激活」，故本次改的是其**行为**，形状未变。

### 1.2 内核主循环：并发调度 + join（`src/kernel/kernel.ts`）

| 位置 | 改动 |
| --- | --- |
| `src/kernel/kernel.ts:36-41` | `KernelDeps` 新增 `globalConcurrency?: number`（说明：缺省 1=串行；生产由 `main.ts` 注入 env 值）。 |
| `src/kernel/kernel.ts:89` | `const concurrencyLimit = Math.max(1, deps.globalConcurrency ?? 1);`——**`AGENTFLOW_GLOBAL_CONCURRENCY` 的消费点**。 |
| `src/kernel/kernel.ts:91-93` | 批次就绪队列 `queue` 与本批次生效上限 `batchLimit`（`serialize` 策略把该批次上限降为 1）。 |
| `src/kernel/kernel.ts:95-105` | 在途集合 `running: Map<nodeId, Promise>`；`launch()` 启动一个节点，`runNode` 结束（成功/失败）即自我移除。 |
| `src/kernel/kernel.ts:126-129` | `while (queue.length > 0 && running.size < batchLimit) launch(...)`——**并发上限 + 超限排队**：有空位就启动队首，否则留在队列。 |
| `src/kernel/kernel.ts:131-136` | `if (running.size > 0) { await Promise.race(running.values()); continue; }`——**join 的调度侧保证**：任一上游在跑就不求解下一批次，直到其结束。 |
| `src/kernel/kernel.ts:138-176` | 仅在「无在途、无待启动」时才 `decideNext`；`end`/`wait` 分支语义与文案保持不变。 |
| `src/kernel/kernel.ts:178-196` | **占用检查（Task 8 的闸）保留在批次启动之前**：对 `decision.nodeIds` 全批次 `checkBatchOwns`；`reject` → 落 `task.failed`（含 `owns_overlaps`）并返回；`serialize` → `batchLimit = 1`，`parallel` → `batchLimit = concurrencyLimit`。随后把整个批次入队。 |
| `src/kernel/kernel.ts:253-257` | `transfer.decided.from` 由「上一条转移的目标」改为 **`selectedEdge?.from ?? ''`**（本次激活所用的边）。并发批次内同源扇出的多个节点不再相互串味；单节点串行时两者恒等。 |

### 1.3 注入（`src/main.ts`）

| 位置 | 改动 |
| --- | --- |
| `src/main.ts:30` | `globalConcurrency: env.globalConcurrency`——把 `AGENTFLOW_GLOBAL_CONCURRENCY`（默认 4）注入内核。 |

### 1.4 测试（新增 11 条，均不真实调用 claude）

| 文件 | 新增 |
| --- | --- |
| `src/kernel/state-machine.test.ts:291-391` | 4 条：多出边**同时激活**（`nodeIds = ['dev_a','dev_b']`）/ **join 未满足 → wait**（`dev_a` 完成、`dev_b` 运行中）/ **join 满足 → 启动 `qa_verify`** / 同一目标去重。 |
| `src/kernel/kernel.test.ts:753-1052` | 5 条（钻石拓扑夹具 + 自建时序 runner `createTimedRunner`）：fan-out **真并发峰值=2** + 转移 `from` 正确 / join **双向**（`dev_b` 挂起时 `qa_verify` 未启动；放行后启动完成）/ **并发上限=2 且 `dev_c` 排队** / owns 重叠 → 占用检查**改串行**（峰值=1）/ `reject` → **启动前拒绝**（只有 `pm_analyze` 启动过）。 |
| `src/kernel/projector.test.ts:73-91` | 1 条：并发多个 `node.started` → `currentNodeIds` **同时含多个**；逐个 `node.succeeded` 各自移除。 |
| `src/kernel/event-store.test.ts:116-150` | 1 条：5 个逻辑任务 × 20 次**交错 append** → seq 全局唯一、严格递增（1..100）、每任务自身升序。 |

---

## 2. 事件库并发写入安全性结论

**结论：安全，无并发竞态，无需修复。**

依据（`src/kernel/event-store.ts:51-101`）：

1. `append` **不使用 `lastSeq()`**，而是 `INSERT` 后直接用 `info.lastInsertRowid` 作为返回 seq（`:82-83`）。因此**不存在「读 lastSeq → 写」这类竞态**（全仓检索：`lastSeq()` 仅被测试/管理台读取，不在任何写入路径上）。
2. `seq` 由 SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` 在 INSERT 时分配（`:27`），是**单条语句的原子操作**；`better-sqlite3` 为**同步 API**，Node 单线程下每次调用完整执行、不被其它 JS 打断 → 交错写入下 seq 全局唯一且严格递增。
3. 事件库无 UPDATE/DELETE，仅插入 → **append-only** 成立。
4. 已落测试钉死：`src/kernel/event-store.test.ts:116-150` 用 5 个 async 任务交错 append（`await Promise.resolve()` 强制交错），断言 `readAll()` 的 seq 恰为 `1..100`（无空洞、无重复、无覆盖），各逻辑任务自身事件升序。

由此，并发 `runNode` 各自多次 `append` 只会**交错**（不同节点的载荷不会混进同一条事件），`readTask ORDER BY seq` 给出确定的全序，事件库一致性不被破坏。

---

## 3. 投影器并发处理结论

**结论：已能正确处理并发事件，无需改动投影器。**

- `project()`（`src/kernel/projector.ts:77-269`）是**纯函数、按事件序列折叠**：`node.started` 把节点 push 进 `currentNodeIds`（`:126-128`，已去重），`node.succeeded`/`node.failed`/`node.cancelled` 各自从 `currentNodeIds` 过滤移除（`:139`、`:154`、`:162`）。
- 因此多个 `node.started` 交错到达时，`currentNodeIds` **可同时包含多个节点**；某个节点结束只移除它自己，不影响仍在运行的其它节点。`nodes[id]` 按 id 单键写入，互不干扰；`visitCounts` 按 id 累加。
- 已落测试：`src/kernel/projector.test.ts:74-92`（两个并发 `node.started` → `['dev_a','dev_b']`；只重放 `dev_a` 成功 → `['dev_b']`）。
- 集成层验证：`src/kernel/kernel.test.ts` 的 join 用例在并发中途断言 `project(getEvents()).currentNodeIds === ['dev_b']` 且 `nodes['qa_verify']` 尚未出现。

---

## 4. 串行等价性如何验证

「无并发时行为与改动前等价」通过三重方式守住：

1. **拓扑层**：`decideNext` 只有「存在**多条**匹配出边」时才与旧实现不同；`simple_dev`/既有自环工作流每个节点至多一条匹配出边 → 返回值逐字相同（旧单测 `state-machine.test.ts` 的等值断言 `toEqual` 未改一字，仍绿）。
2. **调度层**：`KernelDeps.globalConcurrency` **缺省为 1**，且既有测试的 `makeKernel` 未传该值 → 单节点批次天然串行；主循环对单节点批次的行为是「入队 → 立即启动 → `Promise.race` 等它结束」，与旧的 `await runNode(...)` 等价。
3. **既有全量单测**：
   - `simple_dev` 三节点直线：`state.completedNodeIds === ['pm_analyze','dev_implement','qa_verify']`、`transfers` 序 `'→pm_analyze','pm_analyze→dev_implement','dev_implement→qa_verify'`、`decidedBy==='rule'`、`runner.requests === 3`——`src/kernel/kernel.test.ts`（含显式命名「串行等价性」用例）与 `src/server/server.test.ts`、`src/config/real-config.test.ts`（真实加载 `config/workflows/simple_dev.yaml`）全部通过。
   - `transfer.decided.from` 的取值改动：对串行链路，`selectedEdge.from` 恒等于原「上一条转移的目标」，故转移序列断言不变（同上用例覆盖）。

---

## 5. 并发上限与排队如何实现

- **配置入口**：`AGENTFLOW_GLOBAL_CONCURRENCY`（`src/config/env.ts:96`，默认 4）→ `src/main.ts:30` → `KernelDeps.globalConcurrency` → `src/kernel/kernel.ts:89` `concurrencyLimit`。
- **上限**：主循环每次迭代按 `running.size < batchLimit` 从队列取就绪节点启动（`kernel.ts:127`），故同时在途数 ≤ `batchLimit ≤ concurrencyLimit`。
- **排队**：`decision.nodeIds` 一次性入队（`kernel.ts:195-198`），超限者留在 `queue` 中；`await Promise.race(running)` 等到至少一个节点结束、腾出空位后，下一轮迭代再启动队首。队列顺序 = 决策给出的 `nodeIds` 顺序（确定性）。
- **与安全闸协同**：`checkBatchOwns` 在**入队启动之前**执行（`kernel.ts:186`）。`serialize` 策略把 `batchLimit` 降为 1（该批次串行，不与全局上限叠加）；`reject` 直接失败返回。
- **验证**：`kernel.test.ts`「并发上限被遵守」用例 = 3 个就绪节点 + 上限 2 → `runner.peak() === 2`、三个节点都执行、`timeline` 中 `dev_c` 启动索引 > 首个 dev 结束索引（排队证据）；「owns 重叠 → 峰值 1」用例证明占用检查生效。

---

## 6. 变异验证（实际输出）

### 变异①：忽略并发上限

把 `kernel.ts` 的启动循环 `while (queue.length > 0 && running.size < batchLimit)` 改为 `while (queue.length > 0)`（无条件全部启动）：

```
 ❯ src/kernel/kernel.test.ts (32 tests | 1 failed | 31 skipped)
   × fan-out / join / 并发上限（Task 9 + Task 10） > 并发上限被遵守：3 个就绪节点在上限 2 下峰值并发为 2，超限节点排队等待
     → expected 3 to be 2 // Object.is equality
AssertionError: expected 3 to be 2 // Object.is equality
 ❯ src/kernel/kernel.test.ts:993:27
```
→ **上限用例变红**（峰值 3 ≠ 2），证明该用例真的守住了 `AGENTFLOW_GLOBAL_CONCURRENCY`。还原后全绿。

### 变异②：join 不等上游

把 `state-machine.ts:126` 的 `if (state.currentNodeIds.length > 0)` 改为 `if (false && state.currentNodeIds.length > 0)`（不再因有节点运行而 wait）：

```
 ❯ src/kernel/state-machine.test.ts (16 tests | 1 failed | 12 skipped)
   × fan-out 与 join（Task 9） > join 未满足：dev_a 已完成但 dev_b 仍在运行时，qa_verify 不启动（wait）
     → expected 'start' to be 'wait' // Object.is equality
AssertionError: expected 'start' to be 'wait' // Object.is equality
 ❯ src/kernel/state-machine.test.ts:349:20
```
→ **join 用例变红**（`dev_b` 仍在跑就激活了 `qa_verify`），证明该用例真的守住了「等待全部上游」。还原后全绿。

> 两处变异均已还原，全仓已 `grep MUTATION` 确认无残留。

---

## 7. 测试与 tsc 数字

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **exit 0** |
| 本次相关 4 个测试文件 | **72/72 通过**（state-machine 16、kernel 32、projector 14、event-store 10） |
| `src/kernel` 整目录 | **120/120 通过** |
| 全量 `npx vitest run` | **1 failed \| 274 passed (275)** |

全量唯一失败：`tests/website/website.test.ts` → `AC2 站点位于仓库根独立目录 website/`（站点实际落在 `src/website/` 而非仓库根 `website/`）。**归属并发进程的 website 任务，与本次改动无关，未触碰、未修复。**

---

## 8. 疑虑 / 已知边界

1. **join 的通用性边界**：转移只从「**最后一个**完成的节点」的出边求解（`lastCompletedNodeId`）。钻石拓扑（多个上游都有边指向 join）不受影响；但若 join 的入边**只**来自更早完成的节点（非最后完成者），当前实现不会激活它。彻底修复需引入**边级触发台账**（记录哪些边已触发），属后续增强，本次未做（避免扩大改动面与破坏串行等价性）。
2. **共享工作区的并发污染**：`isolate:false` 的并发节点共用主工作区，`collectChangedPaths` 会把同批次其它节点的改动算作自身改动 → 即便 `owns` 互不重叠，也可能**互相看见对方的变更**而误报越界。占用检查只能挡「owns 重叠」，真正的隔离由 **Task 11 的 worktree** 提供。本次并发测试用**不写文件**的时序 runner 规避了该副作用。
3. **`globalConcurrency` 缺省 1**：`KernelDeps.globalConcurrency` 未传时按 1（串行）处理——这是为「不显式配置就不改变既有串行行为」而设的保守缺省；生产路径由 `main.ts` 恒注入 env 值（默认 4），故不影响 `AGENTFLOW_GLOBAL_CONCURRENCY` 的实际消费。
4. **`AGENTFLOW_GLOBAL_CONCURRENCY` / `AGENTFLOW_BATCH_CONFLICT_POLICY` 未写入 `.env.example`**：加入会打破并发 website 任务对键集合的断言（Task 7/8 已实测），刻意不改；变量仍可经 `.env`/`process.env` 生效。
5. **步数预算口径变化**：主循环的 `maxSteps` 现按「调度迭代」（含每次 `Promise.race`）计数，与旧的「每节点一迭代」不同但同量级（既有用例与生产 `maxSteps=20/50` 均充裕，测试全绿）。