# AgentFlow 管理台信息架构重构（web/）实施报告

> 目标原话（验收标准）：**"现在的前端不够流程。不知道看什么。也不知道怎么操作。该优化下了。"**
> 本轮是**信息架构重构**（不是加功能）：把"明细平铺"改成"顶层给结论、明细降到二级"。

---

## 1. 三层结构怎么落地（file:line）

```
┌─ 左：任务列表（状态点 + 一句话摘要 + 当前阶段）
├─ 中上：状态条 ← 回答"现在怎么样 / 该做什么"
├─ 中中：流程视图（DAG）← 回答"不够流程"
└─ 下：二级 tab（弱化）→ 节点明细 / 角色与花费 / 日志 / 产物 / 事件
```

`web/src/App.tsx` 的 `return` 就是这三层的字面结构（一行不多）：

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 左·任务列表 | `web/src/App.tsx:365`（`<TaskList>` 传入新的 `flows`） | 由 `refreshList` 一并刷新（`App.tsx:106`）：`GET /api/tasks` + 每个任务 `GET /api/tasks/:id/flow`（并发取，单个失败不影响整体；上限 `LIST_FLOW_LIMIT=20`） |
| 中上·状态条 | `web/src/App.tsx:448` → `web/src/components/StatusBar.tsx:30` | 当前阶段 / 活跃节点（并发并列 + 并行 N 徽章）/ 已花 / 耗时 / 流程健康 / 分类化失败原因 / 取消任务 |
| 中中·流程 DAG | `web/src/App.tsx:461` → `web/src/components/FlowView.tsx:33` | 节点方框 + 边；运行中高亮、join 在等谁、失败原因直显 |
| 下·二级 tab | `web/src/App.tsx:472`（`class="tabs tabs-secondary"`） | 5 个 tab；`tabs-secondary` 做了弱化（`web/src/styles.css:675` 起：更小字号、虚线分隔、降透明度） |

**唯一的数据分工口径**（避免两套真相）：
- 「当前阶段」的证据只能是 `/api/tasks/:id/flow`（`currentNodeIds` / `nodes[].status` / `taskFailure`）；
- 花费与耗时走既有事件流归集 `aggregate.ts`（复用，未重写）；
- 运行中节点的"还在动吗"走既有日志活性 `liveness.ts` + `logparse.ts`（复用，未重写），只把结论搬到了 DAG 的节点方框里（`LiveAgo` + `STAGNANT_THRESHOLD_MS`）。

任务卡片一行回答一个问题（`web/src/components/TaskList.tsx`）：
- 状态点：`statusTone(status)` 上色的 `.dot`（`TaskList.tsx:174`）；
- 一句话摘要：`oneLine()`（`TaskList.tsx:202`）——如 `失败：权限被拒（需求分析） · 节点 0/1`；
- 当前阶段：`stageOf()`（`TaskList.tsx:220`）——如 `失败于 需求分析` / `模块 A 实现 ＋ 模块 B 实现`（用 `＋` 表达并行）。

## 2. DAG 布局算法（`web/src/flow.ts`，零依赖）

- **分层**：拓扑深度取**最长路径** `layer(v) = max(layer(前置)+1)`，用"松弛 + 轮数上限"实现（`flow.ts:46` 的 `layoutFlow`）：
  - 不做 Kahn 拓扑排序，是为了**容忍环**（工作流回边）：最多松弛 n 轮即收敛，绝不抛错、不冻结界面；
  - 边引用不存在的节点 → 忽略该边；孤立节点 → 落在第 0 列，仍被渲染（不静默丢节点）。
- **定位**：`x = layer × (208 + 72)`，`y = row × (112 + 16)`；同列按输入顺序稳定排序。
- **边**：`edgePath()`（`flow.ts:107`）——前向边用三次贝塞尔横向进出（不穿方框）；同列/回边向下绕弧，视觉上立刻区分。已走过的边用 `is-taken` 高亮（蓝），未走的灰。
- **join 等待**：`joinWait()`（`flow.ts:139`）——入边 ≥2 且仍有上游未就绪时给出"未就绪的上游 id"。
  「未就绪」刻意排除 `cancelled`：任务取消后不存在"在等"这回事，继续显示"在等 XXX"是误导。
- 渲染：`.dag`（相对定位）+ 底层 `<svg>` 画边（绝对定位、`pointer-events:none`）+ HTML 绝对定位节点方框。选 HTML 方框而非纯 SVG `<text>`，是为了方框里能放徽章、多行文本与 hover 才出现的「日志」按钮。

## 3. 删减了什么及理由

| 删减 | 位置 | 理由 |
| --- | --- | --- |
| 旧的 8 格「summary-bar」（总花费/节点进度/任务状态/开始/结束/耗时/当前节点/刷新方式） | 原 `App.tsx` 的 `.summary-bar`；CSS 规则已删（`styles.css` 由"汇总条"段改为"二级 tab"段） | 与状态条**完全重复**，且把结论与实现细节（轮询方式、当前节点 id）混在一起，正是"不知道看什么"的来源 |
| 旧的「N 个节点失败」banner（只列 `lastError` 原文） | 原 `App.tsx` | 被状态条的**分类化失败原因**块取代：现在直接给 `reason_label`（权限被拒/超时/…）+ 原始文本 + 未满足条件 |
| 「本页面暂不展示并行度指标」提示 | `web/src/components/NodeCostView.tsx:93` | 与新的三层结构**冲突**：DAG 现在就是并行度视图。改为"并行度以顶层流程视图为准" |
| 「原始需求」折叠块的位置 | 从 DAG 上方移到「节点明细」tab（`App.tsx:514`） | 属原始数据，不该占顶层注意力 |
| `getNodeLog`/`getRunLog`/`logparse`/`aggregate`/`liveness`/`NodeCostView`/`LogViewer`/`ArtifactView`/`EventView` | 未动（只改了 NodeCostView 的一句提示） | **有真实价值的解析与组件一律复用**，未重写 |
| `TaskHealthLabel` 增加 `'已取消'`；`isTerminal` 增加 `cancelled` | `web/src/liveness.ts:284`、`App.tsx:60` | 取消是终态，必须停止轮询、不再说"运行中" |

## 4. 接入的 API 与字段形状来源

字段形状**全部照后端代码读出来**，不是按文档猜（前端声明不一致会运行期 undefined 而 `tsc` 不报错）：

| 新接入 | 形状来源 | 前端类型 |
| --- | --- | --- |
| `GET /api/tasks/:id/flow` | `src/server/server.ts` 的 `buildFlowView`（`FlowNodeView`/`FlowEdgeView`/`TaskFailureView`，server.ts:481-674） | `web/src/api.ts:240` 起（`FlowView`/`FlowNode`/`FlowEdge`/`FlowEnterReason`/`BlockedReason`/`TaskFailure`） |
| `GET /api/tasks/:id/roles` | `buildRoleUsage`（server.ts:391-478）+ `durationMsOf` | `web/src/api.ts`（`TaskRoleUsage`/`RoleUsage`/`RoleUsageNode`） |
| `GET /api/roles`、`GET /api/roles/:id` | `roleView()`（server.ts:149-164） | `RoleView` |
| `PUT /api/roles/:id` | `RoleEditSchema`（server.ts:111-130，**camelCase**） | `RoleEditInput` |
| `POST /api/tasks/:id/cancel` | 本轮新增（server.ts:1075） | `CancelTaskResult` |

踩到并修掉的真实不一致：后端 `TransferRecord` 里 `edge` / `when` / `edgeDescription` / `artifactStatuses` 都是**可选**（历史事件没有这些键）——前端原来只声明了 4 个字段；现已按后端补齐为可选（`web/src/api.ts:44`），并删掉我误加的重复声明（`tsc` 的 `Duplicate identifier` 报错暴露了它）。

## 5. 取消端点：语义、测试、变异验证

**事实更正**：任务书写"内核已有 `cancel` 能力（`src/kernel/kernel.ts` 的 `cancel`）"——**实测不存在**（全仓只有 `runner.cancel(runId)` 与 `node.cancelled` 事件类型）。故本轮在内核侧补上 `cancel`，再暴露 HTTP。

### 语义（幂等 + 状态不悬挂 + 真止损）

`Kernel.cancel(taskId)`（`src/kernel/kernel.ts:140`）：
1. 未知任务 → 抛错（HTTP 层 404），绝不静默成功；
2. 已终态（completed/failed/cancelled）→ **不写任何事件**，原样返回（幂等）；
3. active → 每个 running/queued 节点写 `node.cancelled`，再写 `task.cancelled` → 任务落到明确的 `cancelled` 终态；
4. running 节点同时 `runner.cancel(runId)`（fire-and-forget：内部 SIGTERM→3s→SIGKILL 进程组）——不杀进程的"取消"会继续烧钱，等于没取消；
5. **取消是终态**：投影器对 cancelled 做**粘滞**处理，在途节点迟到的 succeeded/failed 与 `task.completed` 都不翻转它（`src/kernel/projector.ts:138/155/250/255/259`）；
6. `runTask` 主循环在任务非 active 时**丢弃待启动队列**（`kernel.ts:271`），但**不提前 return**——在途节点仍需自然收尾，否则 `finally` 会在节点还活着时回收它的工作区。

新增事件类型 `task.cancelled`（`src/shared/events.ts:8`）、任务状态 `cancelled`（`src/shared/domain.ts:5`）、能力声明 `task-cancel`（`src/server/server.ts:48`，前端据此在版本落后时禁用按钮而不是点了 404，`web/src/liveness.ts:26`）。

**HTTP 语义**（`server.ts:1075`）：404 未知任务；terminal → `200 {cancelled:false, reason:"任务已处于终态（xxx），无需取消", state}`；active → `200 {cancelled:true, state}`。

**修掉的一处自相矛盾**：取消后"在途节点被终止"会落一条真实的 `task.failed`，于是流转视图会同时说"已取消"和"失败原因：xxx"（浏览器实测复现）。现在 `state.status==='cancelled'` 时 `taskFailure` 置 null（`server.ts:669`，附单测），前端 `currentStage` 也把 cancelled 放在失败之前（`StatusBar.tsx:209`）。

### 测试（新增 12 条，全部随本轮提交）

- `src/kernel/kernel.test.ts`（+4）：运行中取消→节点/任务都 cancelled 且 runner 收到 `cancel(runId)`、重复取消不写事件、迟到成功不翻转；**取消后排队节点不再启动**（fan-out + 并发上限 1）；未知任务抛错；终态幂等。
- `src/kernel/projector.test.ts`（+3）：`task.cancelled` 语义；粘滞（迟到 succeeded + task.completed 不翻转）；**反向断言**普通失败路径不受粘滞影响。
- `src/server/server.test.ts`（+5）：运行中任务取消返回 `cancelled:true` 与完整 state；终态幂等 `cancelled:false` + 中文原因；未知任务 404；`health` 声明 `task-cancel`；取消后迟到的 `task.failed` 不得让流转视图报"失败原因"。

### 变异验证（两处，均为"改坏必被测试抓住"）

**M1**：把主循环的队列丢弃守卫改成 `if (queue.length > 0 && false && …)`：

```
× 取消任务（cancel 的语义与止损） > 取消后主循环不再启动排队中的节点（止损：剩余节点没有 run） 77ms
  → expected [ 'node.queued', 'node.started', …(3) ] to deeply equal []
AssertionError: expected [ 'node.queued', 'node.started', …(3) ] to deeply equal []
      Tests  1 failed | 41 skipped (42)
```

**M2**：把投影器 `task.completed` 的取消粘滞守卫去掉（`state.status = 'completed'`）：

```
× project > 取消是终态：在途节点的迟到 succeeded / failed 与 task.completed 都不翻转 cancelled 3ms
  → expected 'completed' to be 'cancelled' // Object.is equality
AssertionError: expected 'completed' to be 'cancelled' // Object.is equality
      Tests  1 failed | 16 passed (17)
```

两次均已**恢复原实现**并复跑全绿。

## 6. 浏览器验证（Chrome DevTools MCP，真实页面）

环境：vite dev `http://127.0.0.1:5173`（proxy→8787）+ 新代码后端。**未通过 HTTP 新建任何任务**（新建会真实调用 claude 花钱）。

### 阶段一：真实库中已有数据（后端 `restart --force` 加载新代码后）

> 注：8787 上原先跑的是**更旧代码**的遗留 dev 服务（`/api/roles`、`/flow` 全 404），已按 `scripts/server.sh restart --force` 正常重启（重启前 `claudeProcesses: []`，无在途任务；被 `--force` 中断的只是那条 8 小时前的陈旧 active 残留 `task_e5cb…`）。

- 任务列表 5 条全部渲染：`失败：权限被拒（需求分析） · 节点 0/1` / `当前阶段 失败于 需求分析` / 状态点颜色正确。
- 选中 `创业项目官网`（completed，3 节点）：状态条 `当前阶段 已完成 / 活跃节点 无 / $4.4765 / 27.9min / 流程健康 已完成 节点 3/3`；DAG 3 个方框落在 3 列（`left=0px,280px,560px`）、2 条边均 `is-taken`；5 个二级 tab 渲染。
- 选中失败任务 `task_eaa49…`：状态条 `失败原因 | 权限被拒 | permission_denied` + 原始原因 + 失败节点行；
  DAG 上失败节点 `class="dag-node is-failed"`，其 strip **直接显示** `权限被拒 越界写入 2 个路径：src/shared/artifacts.test.ts, src/shared/artifacts.ts`（不用展开）。
- 「角色与花费」tab：3 个角色 × 节点 × 状态 × 产出 × 耗时 × 花费，合计 `$4.4765` 与 `TaskState.budgetUsedUsd` 一致；角色清单 6 个（含 owns）。
- **角色编辑 UI**：打开 `qa_engineer` → 表单预填正确（含 responsibilities/prohibitions/done_criteria/owns/reads/outputs/inputs/预算）→ 把 `outputs` 改成 `code_diff` → 保存 → 界面显示后端中文错误：
  `编辑被拒绝：工作流 simple_dev 的节点 qa_verify 与角色 qa_engineer 的契约冲突（字段 produces/outputs）… （INVALID_ROLE_CONFIG，状态码 422）`；
  随后 `git status --short config/` **为空**、`git diff config/` **为空**——校验失败确实一字未落盘。

### 阶段二：并行 / join / 取消（用 Fake Runner 起的临时桩，零花费、零真实数据写入）

库里没有"正在运行"的任务，而新任务会花钱，故用一次性桩：内存事件库 + Fake Runner + 真实 `createServer`，冻结在"两个 dev 节点并行、qa_verify 等两个上游"的状态（桩文件在 `/tmp`，验证后已删除；未写 `data/`、`logs/`、`config/`）。

实测 DOM（`document.querySelector` 取值）：

```
flowHead: 流程 | 4 个节点 · 4 条边 | 并行 2 个节点同时活跃 | 1 个已完成
active: 2      waiting: 1
dag: 需求分析 已完成 is-done        strip=任务开始，进入起始节点
     模块 A 实现 运行中 is-active   strip=运行中 等待日志…
     模块 B 实现 运行中 is-active   strip=运行中 等待日志…
     汇总验证   未开始 is-waiting   strip=在等模块 A 实现、模块 B 实现   join=tag
状态条: 当前阶段=模块 A 实现 ＋ 模块 B 实现 / detail=2 个节点并行推进中（内核并发批次）
        活跃节点=并行 2 + 两个节点 chip / 已花·耗时 / 流程健康
```

**三项要求逐项通过**：并发高亮（2 个 `.dag-node.is-active` 同时高亮）✅ / join 显示在等哪些上游 ✅ / 失败原因直显 ✅（阶段一真实数据）。

点「取消任务」→ 出现二次确认 `确认取消？已花费用不会退回。` → 点「确认取消」后：

```
statusBadge: cancelled        stage: 已取消（终态）
notice: 已取消：任务进入 cancelled 终态，内核已通知终止在途 CLI 进程（已花费用不退回）。
actions: 重跑方式：新建任务
dag: 模块 A/B 实现 → 已取消 is-cancelled；汇总验证 → （尚未进入）（不再显示"在等"）
failureBlock: null（取消了"已取消 + 失败原因"并存的自相矛盾）
桩 stdout: [stub] runner.cancel 被调用（第 N 次）——说明前端"取消"确实传到了 runner
```

**重跑未硬做**：内核不提供原地重跑，故 UI 不放"重跑"按钮，只在终态时如实显示一句"重跑方式：新建任务"（点击左侧创建即可，历史事件不会被覆盖）。

### console 结论

- **`error` 级消息：0 条**（`list_console_messages({types:['error']})` → `<no console messages found>`）。
  唯一曾出现的 404 是浏览器自动请求 `/favicon.ico`，已通过 `web/index.html` 内联 SVG 图标消除。
- 阶段二桩环境下曾出现 36 条 `404 /api/tasks/.../nodes/dev_a/log` ——**是桩的产物**（Fake Runner 不写日志文件，日志端点如实返回 `FILE_NOT_FOUND`），真实 runner 会写日志，阶段一无此现象。
- 有 1 条 `warn`：`WebSocket connection to 'ws://127.0.0.1:5173/ws' failed: WebSocket is closed before the connection is established.` 这是 **React StrictMode（dev）双挂载**导致首次 WS 在 CONNECTING 阶段被 `close()`；随后自动重连成功（顶栏 `WS 已连接`）。属既有行为、非 error、仅 dev 出现，故未改动 WS 生命周期（避免为消警告动到整页依赖的重连路径）。

## 7. 测试与构建结果

| 检查 | 结果 |
| --- | --- |
| `cd web && npx tsc --noEmit` | **通过**（0 错误） |
| `cd web && npx vite build` | **通过**（`dist/assets/index-*.js` 233.71 kB / css 24.74 kB） |
| `npx vitest run src` | **287 passed / 22 files**（原 275，+12；全绿） |
| `npx tsc --noEmit`（后端） | **通过** |
| `npx vitest run`（含官网） | **321 passed / 3 failed**；3 条全在 `tests/website/website.test.ts` AC2/AC6（**既有失败，与本轮无关**） |
| 新增依赖 | **无**（前端只新增 4 个自研文件；后端零新依赖） |
| 未触碰 | `src/website/**`、`tests/website/**`、`tests/fixtures/**`、`.env.example`、`config/**` 全部未改（`git status` 佐证） |

## 8. 疑虑与未完成

1. **取消无法回收已花费用、也不撤销已写入工作区的改动**：在途节点收尾后仍会走既有的合并流程（与失败路径同）。已在 `kernel.cancel` 的注释里如实写明。若要求"取消后不合并"，需要在 `finishBatch` 里按任务终态过滤 `succeeded`，属新的语义决策，未擅自做。
2. **列表内「当前阶段」的代价是 N 次 `/flow` 请求**（每 5 秒一轮，上限 20 个任务）。单机小规模可接受；任务规模上来后应改为 `/api/tasks` 直接带 `currentStage`（后端加字段），或分页。
3. **`warn` 级 WS 提示**（见 §6）我选择保留而非改代码，理由已说明；如果评审认为"console 必须零噪音"，改法是在 `openEventSocket` 的清理里等 `open` 后再 `close()`。
4. **桩验证是临时手段**：桩文件已删除，仓库里没有任何桩/假数据；但"并行 + join"的活体场景因此只在桩下验证过，真实 runner 下的长期并行行为未实测（需真花钱的任务，未做）。
5. **陈旧残留**：重启前 8787 上的遗留服务与其陈旧 active 任务 `task_e5cb8206ec9442c6b355`（0 花费、8 小时前）已被 `--force` 重启覆盖；我**没有**去 cancel/清理那条任务（避免改写用户数据）。
6. **`/api/tasks/:id/flow` 需要后端注入 `workflow`**：未注入时返回 503，前端会显式显示"流程视图不可用 + 请重启服务"，而不是装作没有流程。