# Task 11 实施报告：worktree 隔离与确定性合并

> 规格 `.trae/specs/clarify-roles-and-flow/spec.md`「并发执行与确定性合并」（Scenario：「并行的产出被合并且可追溯」）与 What Changes 的 E 条；任务清单 Task 11（四个子任务）。
> 边界：**未改 `web/`、`src/website/`、`tests/website/`、4 个归档 fixture**；未新增依赖；未真实调用 claude（测试用自建脚本化 runner）；
> **未实现 Task 12（并行示例工作流）**；未改 server API。分支 `main`。承接 Task 9/10 的并发主循环与 Task 7/8 的路径安全闸（未绕过）。

---

## 1. 一句话结论

- **隔离**：`isolate: true` 的节点、或**可能真并发**（同批次节点数 ≥2 且生效并发上限 ≥2）的批次内节点，各自在独立 git worktree 中运行；
  worktree 基于「HEAD + 主工作区当前**未提交**改动」创建，故节点能看到最新上游产物。
- **合并**：批次**全部结束后**，按 `owns` 归属把各成功节点的改动**逐路径覆盖/删除**回主工作区；因 Task 8 已保证同批次 `owns` 互不相交，
  结果与完成顺序/处理顺序**无关**（确定性），无需三方合并。
- **可追溯**：`node.queued` / `node.started` / `node.succeeded` / `node.failed` 记录工作区标识（`worktree_path` / `isolated` / `worktree_created`），
  终态事件另记录 `changed_paths`；合并结论落 `wp.merged`（复用既有事件类型，此前全仓无生产者）。
- **排除**：失败节点的改动**不被合并**；越界路径**不被合并**（防御性）。
- 相关单测 **41/41 全绿**（kernel 36 + merge 5）；`npx tsc --noEmit` **exit 0**；两处变异验证均按预期变红；`git worktree list` 无残留。

---

## 2. 逐处改动（file:line）

### 2.1 `src/kernel/scheduler.ts`（复用既有骨架，使其可达）

| 位置 | 改动 |
| --- | --- |
| `scheduler.ts:7-19` | `Workspace` 新增 `isolated`（是否与主工作区隔离）与 `branch`（临时分支名）。 |
| `scheduler.ts:21-25` | `isInside()`：判断某路径是否在 workspaceRoot 之内（用于跳过 worktree 自身目录）。 |
| `scheduler.ts:27-62` | **新增 `overlayWorkingTreeChanges()`**：把主工作区当前未提交改动同步进新 worktree（`git worktree add ... HEAD` 只含已提交状态，而上一批合并回来的是未提交改动）。单路径失败即抛中文错误。 |
| `scheduler.ts:64-120` | `prepareWorkspace()`：`isolate=true` → 建 git worktree 并叠加主工作区改动；非 git 仓库或无提交时退化为独立目录（`createdWorktree=false`，仍 `isolated=true`，静态可观测、非静默）。 |
| `scheduler.ts:122-159` | `releaseWorkspace()`：`git worktree remove --force`（仅针对自建临时 worktree）+ `git branch -D`（删除自建临时分支）+ 删除退化隔离目录；失败返回 false。 |

### 2.2 `src/kernel/merge.ts`（新增，纯文件系统操作，可独立单测）

| 位置 | 内容 |
| --- | --- |
| `merge.ts:6-16` | `MergeNodeInput`：nodeId / workspacePath / changedPaths / owns / succeeded。 |
| `merge.ts:18-25` | `MergeNodeOutcome`：mergedPaths / skippedPaths / reason。 |
| `merge.ts:42-95` | `mergeBatchChanges()`：失败节点整体跳过；成功节点按 `matchesOwns` 划分 owned / outOfBounds，逐路径落地；结果按 nodeId 排序。 |
| `merge.ts:97-104` | `dedupeSorted()`：规范化、去空、去重、升序。 |
| `merge.ts:106-127` | `applyPath()`：源存在→`copyFileSync`；源不存在→`rmSync` 删除（同步节点删除）；失败即抛中文错误。 |

### 2.3 `src/kernel/kernel.ts`（接入）

| 位置 | 改动 |
| --- | --- |
| `kernel.ts:16-19` | 引入 `mergeBatchChanges` 与 `Workspace` 类型。 |
| `kernel.ts:51-64` | 新增 `NodeRunResult`（收尾信息：workspace / owns / changedPaths / succeeded）。 |
| `kernel.ts:106-118` | `runTask` 新增 `batchAutoIsolate`、`batchResults`、`liveWorkspaces`。 |
| `kernel.ts:118-133` | `launch()`：把 `batchAutoIsolate` 与 `trackWorkspace` 回调传入 `runNode`；结束时收集 `NodeRunResult`。 |
| `kernel.ts:135-177` | **新增 `finishBatch()`**：本批隔离节点 → `mergeBatchChanges` → 逐条落 `wp.merged`；随后回收全部工作区。 |
| `kernel.ts:179-289` | 主循环包 `try/finally`；在求解下一批**之前**调用 `finishBatch()`（顺序关键：下一批 worktree 需基于合并后的主工作区）；`finally` 兜底回收在途工作区。 |
| `kernel.ts:272` | **隔离触发**：`batchAutoIsolate = batchLimit > 1 && decision.nodeIds.length > 1;` |
| `kernel.ts:318-341` | `runNode` 签名加 `autoIsolate` / `trackWorkspace`，返回 `NodeRunResult | null`；`isolate = node.isolate \|\| autoIsolate`；`prepareWorkspace` 包 try/catch（创建失败 → `task.failed` 中文原因）。 |
| `kernel.ts:379-393` | `node.queued` 载荷加 `worktree_path` / `isolated` / `worktree_created`。 |
| `kernel.ts:414-424` | `node.started` 载荷加同三字段。 |
| `kernel.ts:518-532` | **移除原 `releaseWorkspace` 调用**（否则 worktree 改动会在合并前被删）；新增 `workspaceExtra` 与 `result()`。 |
| `kernel.ts:534-590` | `failNode` 返回 `NodeRunResult`（succeeded=false），`node.failed` 载荷含 `workspaceExtra`（`changed_paths` + 工作区标识）。 |
| `kernel.ts:655-664` | `node.succeeded` 载荷含 `workspaceExtra`；`return result(true)`。 |

### 2.4 配置与测试

| 文件:行 | 改动 |
| --- | --- |
| `config/workflows/simple_dev.yaml:3-6` | 注释更新：由「Phase 1 无合并能力」改为「simple_dev 是串行基线，隔离/合并能力已由 Task 11 提供，并行示例属 Task 12」。**节点值未改（仍全 isolate:false）**。 |
| `src/config/real-config.test.ts:24-33` | 同类注释更新；**断言未改**（simple_dev 全 isolate:false）。 |
| `src/kernel/merge.test.ts`（新增 5 条） | 归属合并落地 / **顺序无关的确定性** / 失败节点不合并 / 越界路径不合并 / 删除同步。 |
| `src/kernel/kernel.test.ts:1057-1368`（新增 4 条） | 真实临时 git 仓库 + 脚本化 runner：worktree 隔离+合并+回收+可追溯 / 自动隔离+worktree 看到未提交上游改动 / 失败节点不合并 / 串行单节点不隔离。 |

---

## 3. 隔离触发条件的选择与理由

**触发条件 = `node.isolate === true` 或「本批次可能真并发」。**

`可能真并发` 的判据为 `batchLimit > 1 && decision.nodeIds.length > 1`——`batchLimit` 是**占用检查之后**的生效并发上限
（`serialize` 策略把它降为 1，`parallel` 时才等于 `AGENTFLOW_GLOBAL_CONCURRENCY`）。

理由：
1. **隔离的必要性来自"并发"，而非"配置写了 true"**。spec E 条要求「并行节点在各自独立 worktree 中运行」，其动机是避免并发节点共用一棵工作树互相覆盖
   （Task 9/10 报告 §8.2 已如实记录该风险）。因此凡「可能真并发」的批次内节点**自动隔离**，不依赖配置作者是否记得写 `isolate: true`。
2. **保留显式开关 `isolate: true`**：让配置可表达"即使串行也隔离"（例如未来有副作用的外部步骤），也让该能力可被单测直接驱动。
3. **串行不隔离 → 串行等价性不被破坏**：`simple_dev` 三节点直线、每批 1 个节点 → `nodeIds.length === 1` → 不隔离，
   `workdir` 仍是主工作区，行为与改动前逐字一致（既有全部单测通过 + 新增「串行单节点不隔离」用例专门把守）。
4. 已用测试覆盖**两侧**：`isolate:false` 的并行批次被自动隔离（`kernel.test.ts` 第 2 条）；单节点批次即便 `globalConcurrency=4` 也不隔离（第 4 条）。

---

## 4. 合并算法与确定性论证

### 4.1 算法

批次全部结束后（`running` 清空、队列清空），对**隔离**节点调用 `mergeBatchChanges`：

1. 失败节点：整体跳过，`reason = "节点失败，其改动不予合并（失败产物不可信）"`。
2. 成功节点：`changedPaths` 中落在 `owns` 内者逐路径落地（源文件覆盖目标；源不存在则删除目标）；越界者记入 `skippedPaths` 并给出中文原因。
3. 逐条落 `wp.merged` 事件（`node_id` / `merged_paths` / `skipped_paths` / `reason`）。

**不做三方合并、不看时间戳、不比较分支**。

### 4.2 确定性论证

- **前提**：Task 8 的占用检查（`checkBatchOwns`，在内核**批次启动前**执行，本次未绕过）保证同一批次内任意两节点的 `owns` **可能重叠则改串行/拒绝**；
  实际并行执行的节点 `owns` **两两不相交**（保守的超集近似，宁可误判重叠）。
- **推论**：给定一条仓库相对路径 P，批次内**至多一个**节点拥有它。因此 P 的最终内容只取决于「P 归谁」，与
  「各节点谁先完成」「合并按什么顺序处理节点」**都无关**。合并仅做逐路径赋值（覆盖/删除），不依赖任何顺序敏感状态。
- **实现上的额外保证**：`mergeBatchChanges` 的返回值按 `nodeId` 排序、`mergedPaths/skippedPaths` 去重升序，
  使**合并报告**本身也与处理顺序无关。
- **已落测试**：`merge.test.ts` 的「确定性：合并结果与节点处理顺序无关」——同一批节点**正序与逆序**处理，
  断言两棵工作树逐字相同且 `outcomes` 深度相等（`toEqual`）。

### 4.3 worktree 基于「当前主工作区状态」创建

`git worktree add ... HEAD` 只含**已提交**状态，而上游批次的产物是以**未提交的工作区改动**形式合并在主工作区的（本平台不替用户提交）。
故 `prepareWorkspace` 在建好 worktree 后，用 `git status --porcelain --untracked-files=all` 列出主工作区改动并叠加进 worktree
（存在→复制、已删除→同步删除；跳过 workspaceRoot 自身以免自我复制）。已落测试：主工作区存在未提交的 `src/shared/seed.txt` 改动，
节点在 worktree 中读到了该未提交内容。

---

## 5. 越界 / 失败节点不被合并的处理

| 情形 | 处理 | 理由 |
| --- | --- | --- |
| **节点失败**（退出码非 0 / 零产物 / 载荷不合规 / 越界） | 改动**不合并**（整体跳过），`wp.merged` 记 `merged_paths: []` 与中文原因 | 与 Task 7「越界产物作废」同源：失败意味着产物不可信；把失败节点的改动写回主工作区会污染下游工作区。任务本就 `failed`，不合并也不会让流程"带着污染继续"。 |
| **越界路径**（Task 7 已能检出） | 即便出现在**成功**节点里也**不合并**（`skippedPaths` + 原因） | 越界产物已在 Task 7 判 `failed` 并作废；合并层再过滤一道是防御性冗余（例如未来有路径绕过语义变化时仍安全）。 |
| **非隔离节点** | 不参与合并（其改动已直接落在主工作区） | 避免自我复制；`finishBatch` 只对 `workspace.isolated` 的节点调用合并。 |

**边界如实记录**：节点启动前已脏、节点又修改的同一文件，路径级差集看不到该改动（Task 7 已记录的同类盲区），故此路径不会被合并/覆盖——主工作区保留原状。

---

## 6. 变异验证（实际输出）

### 变异①：合并时不落地（无条件保留主工作区版本）

在 `src/kernel/merge.ts` 的 `applyPath()` 首行插入 `return;`（不做任何路径落地）：

```
   × 按 `owns` 归属的确定性合并（Task 11.2） > 各节点拥有互不相交的路径：改动全部落地，报告按 nodeId 升序
   × 按 `owns` 归属的确定性合并（Task 11.2） > 确定性：合并结果与节点处理顺序无关（正序与逆序得到同一棵工作树）
   × 按 `owns` 归属的确定性合并（Task 11.2） > 失败节点的改动不被合并（失败产物不可信），报告给出原因
   × 按 `owns` 归属的确定性合并（Task 11.2） > 越界路径即便出现在成功节点里也不合并（防御性），主工作区同名文件保持原样
   × 按 `owns` 归属的确定性合并（Task 11.2） > 节点删除的路径在主工作区同步删除（源不存在即删除）
   × worktree 隔离与确定性合并（Task 11） > 并行节点在各自 worktree 中运行，批次结束后确定性合并回主工作区且 worktree 被回收
   × worktree 隔离与确定性合并（Task 11） > isolate:false 的并行节点仍被自动隔离；worktree 能看到主工作区最新的未提交改动
   × worktree 隔离与确定性合并（Task 11） > 失败节点的改动不被合并（成功节点的改动仍合并），worktree 仍被回收
 Test Files  2 failed (2)
      Tests  8 failed | 33 passed (41)
```
→ **合并用例变红（8 条）**，证明「主工作区确实包含各节点改动」等断言真实有效。已还原。

### 变异②：不回收 worktree

在 `src/kernel/scheduler.ts` 的 `releaseWorkspace()` 首行插入 `return true;`：

```
   × worktree 隔离与确定性合并（Task 11） > 并行节点在各自 worktree 中运行，批次结束后确定性合并回主工作区且 worktree 被回收
     → expected [ …(3) ] to have a length of 1 but got 3
   × worktree 隔离与确定性合并（Task 11） > isolate:false 的并行节点仍被自动隔离；worktree 能看到主工作区最新的未提交改动
     → expected [ …(2) ] to deeply equal []
   × worktree 隔离与确定性合并（Task 11） > 失败节点的改动不被合并（成功节点的改动仍合并），worktree 仍被回收
     → expected [ …(2) ] to deeply equal []
 Test Files  1 failed (1)
      Tests  3 failed | 33 passed (36)
```
→ **回收用例变红（3 条）**：`git worktree list` 由 1 行变 3 行、workspaceRoot 下出现残留目录。已还原。

> 两处变异均已还原，`grep -rn "MUTATION" src/ config/` 无残留；还原后相关测试 41/41 全绿。

---

## 7. 测试与 tsc 数字

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **exit 0**（`TSC_OK`） |
| 本次相关单测（kernel + merge） | **41/41 通过**（kernel.test 36、merge.test 5） |
| `src/kernel` + `src/config` 整目录 | **162/162 通过**（12 文件） |
| 全量 `npx vitest run` | **2 failed \| 282 passed (284)**（23 文件） |

- 本次新增用例 **9 条**（merge.test 5、kernel.test 4）。
- 全量失败 **2 条均在 `tests/website/website.test.ts`**（AC2 站点位置、AC6 对既有内容零改动），
  属**并发进程的 website 任务**（我未触碰 `web/`、`src/website/`、`tests/website/`），与本次改动无关，未修复。
  对比：Task 9/10 时为 1 条失败（274 passed / 275），现为 2 条 —— 差额来自该 website 任务自身状态的推进，非本任务引入。
- **串行等价性**：`simple_dev` 三节点直线的既有用例（转移序列、`decidedBy`、`runner.requests`）全部保持通过；新增用例专门断言单节点批次 `isolated=false`。

---

## 8. `git worktree list` 结果

```
/Users/40kuai/Documents/多agent开发流程       71537ee [main]
```
**仅主工作树，无残留 worktree；`git branch --list 'agentflow/*'` 为空。**（测试全部在 `mkdtemp` 临时 git 仓库中进行，未在本项目工作区做合并实验。）

---

## 9. 未触碰声明

- **未改** `web/`、`src/website/`、`tests/website/`、`tests/fixtures/`（4 个归档样本）、`package.json` / 锁文件（无新依赖）、`.env.example`。
- **未改** server API、未新增并行示例工作流（Task 12）。
- **未真实调用 claude**、未触碰全局环境、未执行破坏性 git 命令（`--force` 仅用于移除本平台自建的临时 worktree；`branch -D` 仅删除自建临时分支）。
- 相对导入均带 `.js` 后缀。

---

## 10. 疑虑 / 已知边界

1. **overlay 是"近似当前工作区状态"**：只按路径同步主工作区**已变更**的文件（`git status` 视角），不做内容寻址；大仓库上会遍历全部改动路径（已设上限由 git 控制）。
2. **删除同步**：节点删除的路径会在主工作区同步删除（测试覆盖）；但**重命名**在 `git status` 里记录为「新路径」，旧路径不会被删除（主工作区会同时留下旧文件）——Phase 1 的主要场景是新文件，属已知边界。
3. **路径级差集盲区**（承接 Task 7）：节点启动前已脏、节点又改动的同一文件不会被识别为本节点改动，故不会被合并。
4. **失败节点改动不合并**：若一个批次里部分节点失败，任务是 `failed`，但**成功节点的改动仍会合并**（按 spec「批次结束即合并」的字面语义）。这会让失败任务在主工作区留下部分产物；已在报告中明示。
5. **`wp.merged` 语义复用**：该事件类型此前全仓无生产者，本次用于记录节点级合并结论；`projector` 早已显式忽略它（不影响任务状态）。
6. **退化路径**：非 git 仓库或无提交时，隔离退化为独立空目录（`worktree_created=false`，可观测）；此路径下节点看不到主工作区文件，仅在仓库不可用时触达。
7. **`.env.example` 未改**：`AGENTFLOW_GLOBAL_CONCURRENCY` / `AGENTFLOW_BATCH_CONFLICT_POLICY` 仍未写入，原因同 Task 7/8（会打破并发 website 任务对键集合的断言），本任务不引入新环境变量。

---

## 11. 改动文件清单

**新增**：`src/kernel/merge.ts`、`src/kernel/merge.test.ts`
**修改**：`src/kernel/scheduler.ts`、`src/kernel/kernel.ts`、`src/kernel/kernel.test.ts`、`src/config/real-config.test.ts`、`config/workflows/simple_dev.yaml`
**文档**：`.trae/specs/clarify-roles-and-flow/tasks.md`（勾选 Task 11）、`记录.md`（追加一节）、本报告

---

## 12. 复现命令

```bash
npx tsc --noEmit                                                  # exit 0
npx vitest run src/kernel/kernel.test.ts src/kernel/merge.test.ts # 41/41
npx vitest run src/kernel src/config                              # 162/162
npx vitest run                                                    # 2 failed | 282 passed（失败均在 tests/website，属并发 website 任务）
# 变异①：merge.ts applyPath 首行 return;  → 41 中 8 failed
# 变异②：scheduler.ts releaseWorkspace 首行 return true; → kernel.test 3 failed
git worktree list                                                 # 仅主工作树
```