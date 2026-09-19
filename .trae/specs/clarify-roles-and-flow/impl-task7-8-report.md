# 实现报告：Task 7（`owns` 路径级强制 / 越界检出）+ Task 8（并行前路径占用检查）

- 规格：`.trae/specs/clarify-roles-and-flow/spec.md`（ADDED「`owns` 路径级强制与越界检出」/「并行前的路径占用检查」）
- 任务：`.trae/specs/clarify-roles-and-flow/tasks.md` Task 7 / Task 8（子任务已全部勾选）
- 核对：`.trae/specs/clarify-roles-and-flow/checklist.md` **D. 路径安全闸**（逐条满足，含两个方向断言）
- 分支：`main`｜未新增依赖｜未真实调用 claude｜未触碰全局环境｜**未改 `web/`、`src/website/`、`tests/website/`**｜**未改 `tests/fixtures/` 4 个归档样本**
- 范围：**只做「检查 + 决策 + 明确原因」**，不实现并发调度 / fan-out / join / worktree（Task 9/10/11）

---

## 1. 一句话结论

- 节点结束后按工作区**实际变更路径**（`git status --porcelain --untracked-files=all`，覆盖未跟踪新文件）核对 `owns`，越界即产出**违规事件**（复用既有 `artifact.invalidated`）并把节点判为 `failed`（分类 `permission_denied`）——**不静默继续**。
- 并行批次启动**之前**做 `owns` 占用检查，**覆盖通配前缀重叠**（`src/**` 与 `src/foo/**` 判为重叠；`src/a/**` 与 `src/b/**` 判为不相交）；重叠时按配置（`AGENTFLOW_BATCH_CONFLICT_POLICY`）**改为串行**或**拒绝该批次**，并给出「哪两个节点、哪段路径重叠」。
- 相关单测 **62/62 全绿**；`npx tsc --noEmit` **exit 0**；变异验证两处均按预期变红。

---

## 2. 逐处改动（file:line）

### 2.1 新模块 `src/kernel/path-guard.ts`（纯函数为主，可独立单测）

| 文件:行 | 内容 |
| --- | --- |
| `src/kernel/path-guard.ts:20` | `normalizeRepoPath()`：仓库相对路径规整（反斜杠→`/`、去前导 `/` 与 `./`、合并重复分隔符、去尾随 `/`） |
| `src/kernel/path-guard.ts:77` | `ownsPatternToRegExp()`：单个 `owns` 模式 → 整串正则（带缓存） |
| `src/kernel/path-guard.ts:86` | `matchesOwns()`：路径是否落在允许写入范围内 |
| `src/kernel/path-guard.ts:96` | `findOwnViolations()`：从变更路径里挑出越界项（去重排序；`owns` 为空=只读角色，任何变更都越界） |
| `src/kernel/path-guard.ts:111` | `collectChangedPaths()`：`git status --porcelain --untracked-files=all`；重命名取新路径；**非 git 工作区返回 `[]`** |
| `src/kernel/path-guard.ts:145` | `segmentsIntersect()`：两段「单段 glob」是否有公共匹配串（段内 `*`/`?`） |
| `src/kernel/path-guard.ts:182` | `ownsPatternsIntersect()`：两段 `owns` 模式是否可能相交（段级 DP） |
| `src/kernel/path-guard.ts:209` | `commonLiteralPrefix()`：人类可读的「重叠路径段」 |
| `src/kernel/path-guard.ts:223/226/236` | 类型：`BatchNodeOwns` / `OwnsOverlap` / `BatchConflictPolicy` |
| `src/kernel/path-guard.ts:242` | `detectOwnsOverlaps()`：两两比对；**只读角色（`owns: []`）跳过** |
| `src/kernel/path-guard.ts:267/281` | `BatchGuardDecision` / `checkBatchOwns()`：给出 `parallel` / `serialize` / `reject` 决策 + 明确原因 |

### 2.2 内核接入 `src/kernel/kernel.ts`

| 文件:行 | 内容 |
| --- | --- |
| `src/kernel/kernel.ts:8-14` | 引入 path-guard 的 4 个符号 |
| `src/kernel/kernel.ts:31-34` | `KernelDeps.batchConflictPolicy?`（可选，默认 `serialize`；由 `AGENTFLOW_BATCH_CONFLICT_POLICY` 注入） |
| `src/kernel/kernel.ts:129-136` | **Task 8：批次启动前**组装批次节点的 `owns` 并调用 `checkBatchOwns` |
| `src/kernel/kernel.ts:137-151` | `reject` 策略：**在启动这些节点之前**落 `task.failed`，`reason` 含两节点与重叠路径段，附 `owns_overlaps` |
| `src/kernel/kernel.ts:269-271` | **Task 7**：节点启动前记录变更基线 `changesBefore`（前后快照差，避免把既有脏文件算到本节点头上） |
| `src/kernel/kernel.ts:339-349` | 节点结束后、**回收工作区之前**采集 `changesAfter` → 差集 `changedPaths` → `outOfBoundsPaths`；`violationExtra` 供失败落库携带清单 |
| `src/kernel/kernel.ts:358-392` | `failNode()` 新增 `extra` 参数，把越界清单一并写入 `node.failed`/`task.failed` |
| `src/kernel/kernel.ts:400/406/414` | 三条失败路径（退出码非 0 / 零产物 / 载荷不合规）都带 `violationExtra` |
| `src/kernel/kernel.ts:418` | `artifact_id` 提取为局部变量（供作废事件引用） |
| `src/kernel/kernel.ts:439-468` | **越界处理**：产物先落 `artifact.created`，随即落 **`artifact.invalidated`**（含 `out_of_bounds_paths` / `changed_paths` / `reason`），再 `failNode('permission_denied', …)` 并 `return`（不落 `node.succeeded`） |

### 2.3 配置化策略

| 文件:行 | 内容 |
| --- | --- |
| `src/config/env.ts:12-17` | `AppEnv.batchConflictPolicy: 'serialize' \| 'reject'` |
| `src/config/env.ts:31` | 默认值 `serialize` |
| `src/config/env.ts:71-83` | `readConflictPolicy()`：只接受两个取值，**非法值显式报错**（不静默回退） |
| `src/config/env.ts:97-101` | 从 `AGENTFLOW_BATCH_CONFLICT_POLICY` 读取 |
| `src/main.ts:30` | 把 `env.batchConflictPolicy` 注入 `createKernel` |

### 2.4 测试支点与用例

| 文件:行 | 内容 |
| --- | --- |
| `src/runner/fake-runner.ts:12-17` | `FakeRunnerOptions.onRun`：每次 run 开始时回调，测试可在**真实工作区**里模拟节点写入 |
| `src/runner/fake-runner.ts:48` | run 内调用 `options.onRun?.(req)` |
| `src/kernel/path-guard.test.ts`（23 条） | 越界/未越界两方向、`src/**` 不越段、只读角色、未跟踪新文件采集、非 git 不误报、重叠各情形、批次检查各情形 |
| `src/kernel/kernel.test.ts:629-750`（新增 3 条） | 真实临时 git 仓库 + FakeRunner 写文件：**越界被检出**、**未越界不误报**、**只读角色写入即越界** |
| `src/config/env.test.ts:35-46`（新增 2 条） | 策略默认/可指定 + 非法值报错 |

---

## 3. `owns` glob 语义与「重叠判定」算法

### 3.1 glob 语义（`owns` 每一项）

- 仓库相对路径，`/` 分段；
- `**` 作为**整段**，匹配**零或多段**（`src/**` 匹配 `src/a.ts`、`src/a/b.ts`）；
- `*` 段内任意（可空）、`?` 段内单字符，其余按字面量；
- **不支持** `[...]` 字符类、`{a,b}` 花括号、`!` 取反（配置里未使用；如需扩展须一并补测）。

同一语义用在**两个地方**（匹配与重叠），避免出现「匹配说越界、重叠说没事」这类口径分裂：
`ownsPatternToRegExp`（`path-guard.ts:77`）与 `ownsPatternsIntersect`（`path-guard.ts:182`）都按「`**` = 零或多段」。

### 3.2 重叠判定算法（段级 DP + 段内 DP）

`ownsPatternsIntersect` 把两段模式各拆成段列表，做 `f(i, j)`：`a[i..]` 与 `b[j..]` 是否存在公共路径。

1. `a[i] === '**'`：可匹配**零段** → `f(i+1, j)`；或**吃掉 `b[j]` 一段**后仍是 `**` → `f(i, j+1)`。
2. `b[j] === '**'`：对称。
3. 两者皆尽 → `true`；仅一方尽 → `false`。
4. 否则要求 `segmentsIntersect(a[i], b[j])` 且 `f(i+1, j+1)`。

`segmentsIntersect`（`path-guard.ts:145`）是段内通配的匹配 DP：
- `*` 可吃零字符（`g(i+1,j)`）或吃一个字符（`g(i,j+1)`，对方那一位只要能产出该字符即可——字面量/`?`/`*` 都行）；
- `?` 与字面量/`?` 各自恰好产出一个字符，故 `?` 与任意非空单字符段位可相交；
- 两个不同字面量 → 不相交。

复杂度：段级 O(m·n)、段内 O(|sa|·|sb|)，均带记忆化，配置规模下无性能顾虑。

### 3.3 算法边界与取舍（**保守的超集近似**）

- `**` 统一按「零或多段」处理，因此 `src/*` 与 `src/a/**` 会被判为**重叠**（真实文件路径里 `src/*` 只匹配直接子项，未必真撞车）。
  **这是刻意的**：安全侧误报的代价只是「退化为串行、少一点并行」；危险侧漏报的代价是「两个 agent 写同一路径、数据混乱」。
  用户明确要求「避免无用的并行导致数据混乱」，故宁可多判重叠。已在代码注释（`path-guard.ts:176-181`）写明。
- 只比较**仓库相对 POSIX 路径**；不支持跨平台大小写差异（macOS 默认大小写不敏感）、不支持 symlink 解析。
- 只读角色（`owns: []`）不写任何路径，**不参与冲突**（`detectOwnsOverlaps` 直接跳过）。

### 3.4 规格给定用例的实测结论

| 模式 A | 模式 B | 判定 | 是否规格要求 |
| --- | --- | --- | --- |
| `src/**` | `src/foo/**` | **重叠** | ✅ 要求重叠 |
| `src/a/**` | `src/b/**` | 不相交 | ✅ 要求不相交 |
| `src/**` | `tests/**` | 不相交 | 附加 |
| `src/*.ts` | `src/a.ts` | 重叠 | 附加（段内通配） |
| `**` | `src/a/**` | 重叠 | 附加（零段语义） |

---

## 4. 越界后的任务语义：选择「节点 failed + 分类原因」以及理由

**选择的语义**：越界 → 节点判 **`failed`**，分类 **`permission_denied`（权限被拒）**，任务随之 `failed`；本次产出的产物先落 `artifact.created`、随即以 **`artifact.invalidated`** 作废（附越界路径清单）。**不静默继续**。

**理由**：

1. **越界的产物不可信**。`backend_dev` 的真实越界（写 `README.md`、`scripts/hello.sh`）意味着它不仅改了 `src/**`，还改了别的东西。若只「告警后继续」，下游 `qa_verify` 会在被污染的产物上继续工作——这正是用户要避免的「数据混乱」。判 failed 让流程**停在污染点**。
2. **与既有失败基础设施同构**。项目已有稳定的失败分类枚举与 `node.failed`/`task.failed` 落库形态（Task 3 建立）。越界复用「失败」语义，界面无需新增展示分支即可看到根因。
3. **不扩稳定枚举**。`FAILURE_REASONS` 刻意保持稳定（`events.ts:56-59` 注释明确「不要为新增 subtype 扩枚举」）。越界写本质是一次**越权写入**，归入已有的 `permission_denied`（中文「权限被拒」）最贴切；具体根因由 `reason` 文本 + `out_of_bounds_paths` 精确表达。
4. **备选（仅告警后继续）被否决**：它满足「不静默」，但会让越界产物进入下游，与「避免数据混乱」的诉求相悖，且需要额外的产物可信度传播机制（Phase 1 不值得引入）。

**影响面**：`owns` 从「prompt 里的一句话」变为**内核层强制**后，**历史上越界的任务将从 `completed` 变为 `failed`**——这是修复的目标行为，不是回归。对合法写入（全部落在 `owns` 内）无任何影响（见 §6 变异 1 的反向用例）。

**边界（如实记录）**：

- 越界核对在**每次节点结束**时执行；但**专门的违规事件 `artifact.invalidated` 只在「本次产出了结构化产物」时产生**（它需要引用一个 `artifact_id`）。若节点因别的原因（退出码非 0 / 零产物 / 载荷不合规）失败，任务本就 `failed`（不静默），此时越界清单仍会附在 `node.failed`/`task.failed` 的载荷里（`violationExtra`），只是不再单独发 `artifact.invalidated`。
- 用「前后快照差」而非「全量快照」判定本节点的变更：非隔离节点（`isolate: false`）共用主工作区，全量快照会把节点启动前就存在的脏文件算到本节点头上（误报）。**已知代价**：若某文件在节点启动前已脏、节点又改了它，路径级差集**看不出来**（该路径已在基线里）。要覆盖这种情况需要内容哈希级别的 diff，属后续增强。
- `collectChangedPaths` 用 `--untracked-files=all` 以列出**未跟踪的新文件个体**（`git diff --name-only` 不含未跟踪文件，而实测越界恰恰都是新文件）。大仓库上输出量更大，已设 `maxBuffer=32MB`；超出会抛错并被捕获为「无法判定 → 不误报」。

---

## 5. 检查函数如何被 Task 9/10 接入

- 现成接口：`checkBatchOwns(nodes: BatchNodeOwns[], policy)` → `{ mode: 'parallel' } | { mode: 'serialize' | 'reject'; reason; overlaps }`。
- 已在**主循环**接好调用点（`kernel.ts:129-151`）：拿到 `decision.nodeIds`（激活节点集合）后、`await runNode(...)` **之前**执行。
- 当前 `decideNext` 恒激活 1 个节点，`checkBatchOwns` 对 `nodes.length < 2` 直接返回 `parallel`，故**行为与改动前等价**；Task 9 让 `decideNext` 支持 fan-out（一批次多个 `nodeIds`）后，该分支立即生效，**无需再改内核**。
- 后续消费方式：
  - `mode === 'parallel'` → Task 10 在此处并发推进该批次（消费 `AGENTFLOW_GLOBAL_CONCURRENCY`）；
  - `mode === 'serialize'` → 保持当前串行 `for` 循环（已是默认行为）；
  - `mode === 'reject'` → 内核已落 `task.failed`（含 `owns_overlaps`），不再启动任何节点。
- 配置入口：`AGENTFLOW_BATCH_CONFLICT_POLICY=serialize|reject`（默认 `serialize`），经 `env.ts` → `main.ts` → `KernelDeps.batchConflictPolicy`。

> 注：**未**把该变量写入 `.env.example`，原因见 §8「疑虑 1」。

---

## 6. 变异验证（附实际输出）

### 变异 1（Task 7）——去掉越界核对

把 `src/kernel/kernel.ts:444` 的 `if (outOfBoundsPaths.length > 0)` 改为 `if (false && outOfBoundsPaths.length > 0)`：

```
$ npx vitest run src/kernel/kernel.test.ts
 FAIL  … > owns 路径级强制与越界检出（Task 7） > 越界写被检出：artifact.invalidated + permission_denied，任务不静默继续
 FAIL  … > owns 路径级强制与越界检出（Task 7） > 只读角色（owns 为空）写入任何路径都算越界
   → expected 'other' to be 'permission_denied'
 Test Files  1 failed (1)
      Tests  2 failed | 25 passed (27)
```

**结论**：去掉核对后越界用例**变红（2 条）**；同时 **「未越界时不误报」仍为绿**（证明两条断言互不代偿）。已还原。

### 变异 2（Task 8）——重叠检测退化为字面相等

把 `src/kernel/path-guard.ts:205` 的 `return overlap(0, 0)` 改为 `return normalizeRepoPath(patternA) === normalizeRepoPath(patternB)`：

```
$ npx vitest run src/kernel/path-guard.test.ts
 × owns 重叠判定（Task 8） > 覆盖通配前缀重叠：`src/**` 与 `src/foo/**` 重叠   → expected false to be true
 × owns 重叠判定（Task 8） > 段内通配参与重叠判定：`src/*.ts` 与 `src/a.ts` 重叠… → expected false to be true
 × owns 重叠判定（Task 8） > `**` 与任意模式重叠（含零段语义）               → expected false to be true
 × 批次启动前的占用检查（Task 8） > 重叠被挡：返回涉及的两个节点与重叠路径段，默认策略为串行 → expected 'parallel' to be 'serialize'
 × 批次启动前的占用检查（Task 8） > 重叠被挡：策略为 reject 时拒绝该批次     → expected 'parallel' to be 'reject'
 Test Files  1 failed (1)
      Tests  5 failed | 18 passed (23)
```

**结论**：退化为字面相等后，**「通配前缀重叠」用例变红（含 5 条）**；**「不相交被允许」仍为绿**（本身期望 false，退化后照样 false，正好说明该用例只守反向）。已还原。

---

## 7. 测试与 tsc 数字

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **exit 0**（`TSC_OK`） |
| `npx vitest run src/kernel/path-guard.test.ts src/kernel/kernel.test.ts src/runner/fake-runner.test.ts src/config/env.test.ts` | **`Tests 62 passed (62)`**（4 files） |
| 全量 `npx vitest run` | **`Tests 1 failed | 263 passed (264)`**（22 files） |

- 本次新增用例 **28 条**：`path-guard.test.ts` 23、`kernel.test.ts` 3、`env.test.ts` 2（另有 `fake-runner.ts` 的 `onRun` 钩子为测试支点，无新增用例数）。
- 全量**唯一失败**是 `tests/website/website.test.ts`（AC2「站点位于仓库根独立目录 website/」）——它断言仓库根存在 `website/`，而该站点实际落在 `src/website/`。`src/website/`、`tests/website/` 均为**并发进程的 website 任务未跟踪文件**，**非本任务产物，我未触碰**（见 §8）。

---

## 8. 疑虑 / 需知悉

1. **未把 `AGENTFLOW_BATCH_CONFLICT_POLICY` 写进 `.env.example`（刻意）**：我一度加过，`tests/website/website.test.ts` 随即**新增一条失败**——该用例断言 `.env.example` 的键集合与并发进程正在开发的网站「环境变量表」**完全一致**。为不把失败带进他人未完成的任务，已回退 `.env.example`。
   - 变量**依然可用**：`loadEnv` 从 `.env`/`process.env` 读取，与其它 `AGENTFLOW_*` 同一机制，默认 `serialize`；已在 `env.ts` 与 `KernelDeps` 注释里写明变量名。
   - website 任务落地后，建议补回 `.env.example` 一行：`AGENTFLOW_BATCH_CONFLICT_POLICY=serialize`（并同步其站点文档）。
2. **并发进程已回退过我的一处编辑（已复核补回）**：`kernel.ts:406` 的 `failNode(..., violationExtra)` 一度被并发写覆盖（grep 复核时发现与预期不符），已按「先读再改、不覆盖他人改动」重做并复核落盘。同类不一致若在合并时出现，以本报告 §2 的 file:line 清单为准。
3. **`记录.md` 的处理**：该文件在我开始前即为 `M`（并发进程改动）。我只在**文件末尾追加**一节本任务记录，不触碰他人已写内容。
4. **未实现（属后续任务）**：并发调度（Task 10）、fan-out/join（Task 9）、worktree 隔离与合并（Task 11）、并行示例工作流（Task 12）。本任务**只**交付检查 + 决策 + 明确原因，并已把调用点接进主循环。
5. **越界判定的已知盲区**：节点启动前已脏、节点又改动的同一文件，路径级差集看不到（§4 边界）。另：非 git 工作区无法判定变更 → 返回空、不报越界（宁可漏报不误报）。
6. **策略 `reject` 的当前可达性**：主循环当前批次恒为 1 个节点，`reject` 分支在真实运行中尚不可达；其行为已由 `checkBatchOwns` 单测（`serialize`/`reject` 两方向）与内核 reject 落库代码覆盖，Task 9 引入多节点批次后即可端到端触发。

---

## 9. 改动文件清单

**新增**：`src/kernel/path-guard.ts`、`src/kernel/path-guard.test.ts`
**修改**：`src/kernel/kernel.ts`、`src/kernel/kernel.test.ts`、`src/config/env.ts`、`src/config/env.test.ts`、`src/main.ts`、`src/runner/fake-runner.ts`
**文档**：`.trae/specs/clarify-roles-and-flow/tasks.md`（勾选 Task 7/8）、`记录.md`（追加一节）、本报告

**未触碰**：`web/**`、`src/website/**`、`tests/website/**`、`tests/fixtures/**`（4 个归档样本）、`package.json`/`package-lock.json`（无新依赖）、`.env.example`、全局环境。

---

## 10. 复现命令

```bash
npx tsc --noEmit                                   # exit 0
npx vitest run src/kernel/path-guard.test.ts src/kernel/kernel.test.ts \
               src/runner/fake-runner.test.ts src/config/env.test.ts   # 62/62
npx vitest run                                     # 1 failed | 263 passed（唯一失败为并发 website 任务）
# 变异 1：kernel.ts:444 改 `if (false && outOfBoundsPaths.length > 0)` → kernel.test.ts 2 failed | 25 passed
# 变异 2：path-guard.ts 把 ownsPatternsIntersect 的 return 改为字面相等 → path-guard.test.ts 5 failed | 18 passed
git status --porcelain                             # 仅本任务文件 + 他人的 src/website、tests/website、README.md、记录.md
```