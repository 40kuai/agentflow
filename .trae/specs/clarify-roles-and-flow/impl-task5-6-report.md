# 实现报告：Task 5（角色与流转的查询 API）+ Task 6（角色编辑 API）

- 规格：`.trae/specs/clarify-roles-and-flow/spec.md`
  （ADDED「角色定义的可读性与唯一契约来源」/「角色可编辑且编辑后即时校验」/「本次任务的角色使用情况可查」）
- 任务：`.trae/specs/clarify-roles-and-flow/tasks.md` Task 5 / Task 6（子任务）
- 核对：`.trae/specs/clarify-roles-and-flow/checklist.md` **C. 后端 API**（逐条满足）
- 分支：`main`｜未新增依赖｜未真实调用 claude（注入 Fake Runner）｜未触碰全局环境
- **未改 `web/`、`src/website/`、`tests/website/`、`tests/fixtures/` 4 个归档样本**；**未改 `config/` 下任何真实配置**（测试用 `mkdtemp` 副本）
- 未改 spec / 计划 / `记录.md`（属 Task 13）；未实现 Task 12（并行示例工作流）
- 本任务只做**增量添加**：`src/server/server.ts` 既有端点（健康检查 / 任务列表与详情 / 事件 / 节点日志 / runId 日志 / WS）与 `server.test.ts` 既有 27 条用例**一字未删**

---

## 1. 一句话结论

- Task 5：新增 3 类**结构化**查询端点（角色列表/详情、任务角色使用情况、任务流转视图），字段完整、含空/边界/未知任务处理，前端无需再解析散文。
- Task 6：新增角色编辑端点，走「**临时目录副本里跑生产加载路径校验 → 原子写回 → 重新加载验证**」；校验失败返回明确中文错误且**配置文件逐字不变**。
- 相关单测 **42/42 全绿**（新增 15 条）；`npx tsc --noEmit` **exit 0**；变异验证按预期变红。

---

## 2. 新增端点清单与返回结构（file: `src/server/server.ts`）

| 端点 | 位置 | 返回结构 |
| --- | --- | --- |
| `GET /api/roles` | `server.ts:910` | `{ roles: RoleView[] }`；`RoleView = { id, displayName, systemPromptRef, inputs, outputs, owns, reads, responsibilities, prohibitions, doneCriteria, model, budget:{maxRetries,maxWallTimeMs} }` |
| `GET /api/roles/:roleId` | `server.ts:924` | `RoleView`（同上字段）；未知角色 404 `{code:'ROLE_NOT_FOUND'}`；非法 id 400 `{code:'INVALID_ROLE_ID'}` |
| `GET /api/tasks/:taskId/roles` | `server.ts:947` | `{ taskId, roles:[{ roleId, displayName, model, budget, nodes:[{nodeId,status,produces,artifactTypes,invalidatedArtifactTypes,attempt,durationMs,costUsd}], totalDurationMs, totalCostUsd }], totalCostUsd }` |
| `GET /api/tasks/:taskId/flow` | `server.ts:957` | `{ taskId, title, status, currentNodeIds, completedNodeIds, budgetUsedUsd, nodes:[FlowNodeView], edges:[{from,to,when,description,onMissing}], transfers, taskFailure }` |
| `PUT /api/roles/:roleId` | `server.ts:972` | 成功 `{ role: RoleView, path }`；400 输入不合法；404 角色不存在；422 配置层校验失败 `{code:'INVALID_ROLE_CONFIG'}`；500 写入/回读失败 |

`FlowNodeView`（流转视图单节点）= 拓扑字段（`id/title/role/roleDisplayName/description/entryCondition/consumes/produces/isolate`）
+ 运行时字段（`status`（含 `not_started`）/`attempt`/`current`/**`enterReason`**/**`blockedReason`**/`durationMs`/`costUsd`/`artifactTypes`/`invalidatedArtifactTypes`/`changedPaths`/`worktreePath`）。

- **进入理由**（`enterReason`）直接复用投影器的 `TransferRecord`：`{ from, reason, edge, when, edgeDescription, artifactStatuses }`
  —— 即 Task 3/4 落库的「所用边、条件原文、边的人类可读说明、判定依据（产物状态）」。
- **阻塞原因**（`blockedReason`）来自 `node.failed` 的**分类化原因**：`{ category, label, error }`（稳定的 `FAILURE_REASONS` 枚举 + 中文说明 + 原始 CLI 文本）。
- **任务级失败**（`taskFailure`）= `{ reason, category, label, unmetConditions, artifactStatuses }`（同时给出分类、未满足条件、相关产物实际状态）。
- 节点级耗时/花费/产出/改动路径/工作区标识由 `server.ts` 的事件聚合函数 `collectNodeFacts()` 计算（`node.started`→结束事件的 `created_at` 差、累加 `node.usage_recorded`、`artifact.created`/`artifact.invalidated`），因此 Task 9/10/11 的「改动路径清单 + 工作区标识可追溯」也一并暴露。

**边界与空情形**（均有断言）：
- 角色列表/详情未配置 `configDir` → 503 `{code:'CONFIG_DIR_MISSING'}`（不伪装成空列表）；未知角色 → 404；非法 roleId（不符合 `^[A-Za-z0-9_-]+$`）→ 400（挡在文件路径拼接之前）。
- 角色使用情况：只有 `task.created`、无任何节点 → `roles: []`；未知任务 → 404。
- 流转视图：未跑过的任务 → 节点 `status:'not_started'`、`enterReason:null`、`transfers:[]`、`taskFailure:null`；未知任务 → 404；未注入工作流 → 503 `{code:'WORKFLOW_MISSING'}`。

---

## 3. 原子写入的做法

`server.ts` 的 `writeFileAtomic(target, content)`：

1. 先写**同目录**临时文件 `${target}.tmp-${process.pid}-${Date.now()}`；
2. 再 `renameSync(tmp, target)` —— 同一文件系统内 `rename` 是**原子操作**，从根上避免"写了一半"的残缺 YAML 被任何读取方看到；
3. 任一步失败则清理临时文件并抛出，**目标文件保持原状**。

写入后还有一道兜底：用生产加载器 `loadRole(configDir, roleId)` **重新加载验证**；若失败（理论上不应发生）则用编辑前保存的 `originalRaw` 再次原子写回（回滚），并返回 500 `{code:'RELOAD_FAILED'}`，绝不残留半成品配置。

---

## 4. 编辑校验如何「复用加载期校验」

`server.ts` 的 `validateRoleCandidate(configDir, roleId, file, workflowId)` 在**写入真实配置之前**：

1. `mkdir -p` 一个临时目录（`mkdtempSync(tmpdir(), 'agentflow-role-edit-')`）；
2. `cpSync(configDir, tmp, { recursive: true })` 复制**整个**配置（roles/ + workflows/ + prompts/）；
3. 把候选角色写成 `tmp/roles/<roleId>.yaml`；
4. 调用**生产同一条加载路径**：`loadAllRoles(tmp)`（角色 schema + `system_prompt_ref` 指向的提示词文件存在性）+ `loadWorkflow(tmp, workflowId)`
   —— 后者内含 Task 1 的 `assertNodeContractMatchesRole`，即「角色 `inputs`/`outputs` 为权威、节点 `consumes`/`produces` 为派生」的**加载期一致性校验**；
5. `finally` 中 `rmSync(tmp, { recursive:true, force:true })`。

因此三类问题都在**写入前**被拦下并返回 422 中文错误，真实配置文件一字未动：
- 字段缺失/为空/预算为负（角色 schema，中文错误如「缺少必填字段 responsibilities（职责边界）」）；
- 提示词文件不存在；
- **破坏契约唯一来源**的编辑（例如把 `pm.outputs` 改成 `['test_report']`，与工作流 `pm_analyze` 的 `produces: requirement` 冲突 → 「…的契约冲突（字段 produces/outputs）…」）。

另有一层**输入层校验** `RoleEditSchema`（zod，camelCase，中文错误）先返回 400，用于快速、精确的错误定位（`maxWallTimeMs` 为负、`responsibilities` 为空数组等）。

---

## 5. 变异验证输出

临时把 `server.ts:1019` 的校验调用改为 `if (false) validateRoleCandidate(...)`（跳过写入前校验），只跑靶向用例：

```
$ npx vitest run src/server/server.test.ts -t '破坏契约一致性'
 ❯ src/server/server.test.ts (42 tests | 1 failed | 41 skipped) 117ms
   × Task 6：角色编辑 API > 破坏契约一致性的编辑（改 outputs）：写入前被拒 422，配置文件逐字不变
     → expected 200 to be 422 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 41 skipped (42)
```

**结论**：跳过校验后，非法编辑**真的落盘**（HTTP 200 而非 422），「非法编辑不落盘」的断言**变红**——证明该断言非空跑。已还原（`grep validateRoleCandidate(deps.configDir` 复核命中唯一 1 处、调用形式正确），还原后单文件 42/42 全绿。

---

## 6. 测试与 tsc 数字

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **exit 0**（`TSC_EXIT=0`） |
| `npx vitest run src/server/server.test.ts` | **42 passed (42)**（原 27 条 + 新增 15 条） |
| 全量 `npx vitest run` | **`2 failed | 297 passed (299)`**（23 文件） |

- 新增 15 条：角色列表/详情 3、任务角色使用情况 3、任务流转视图 4、角色编辑 5。
- 全量 **2 条失败均在 `tests/website/website.test.ts`**（AC2「站点未落在仓库根 `website/`，实际在 `src/website/`」、AC6「既有文档被接线改动：`docs/superpowers/specs/2026-09-19-agentflow-phase2-requirements.md`」）——属**并发进程的 website 任务**，与本次无关，**未触碰、未修复**。
- 与改动前对照：`src/website/`、`tests/website/` 为并发任务的**未跟踪**目录。

---

## 7. `config/` 是否无改动

**是，无改动。** `git status --short -- config web src/website tests/website` 仅输出 `?? src/website/`、`?? tests/website/`，`config/` 与 `web/` **零条目**。测试全部在 `mkdtempSync` 出来的临时目录副本上做（`makeTempConfigDir()` 先 `cpSync` 真实 `config/` 再编辑副本），真实配置文件从未被写入。

## 8. `web/` 与 website 是否被触碰

**否。** `git status --short` 中 `web/` 无条目；`src/website/`、`tests/website/` 是并发进程的未跟踪目录，本次未读改其中任何文件。

---

## 9. 改动文件清单

**修改**：`src/server/server.ts`（增量：3 个查询端点 + 1 个编辑端点 + 纯逻辑辅助）、`src/server/server.test.ts`（增量：`boot` 加 `configDir`/`omitWorkflow` 选项 + 15 条用例）、`src/main.ts`（把 `configDir`/`workflow`/`roles` 注入 `createServer`）
**新增**：本报告

---

## 10. 疑虑 / 需知悉

1. **`ServerDeps` 新增的三个字段均为可选**（`configDir?`/`workflow?`/`roles?`），以保证既有调用方不破坏：未提供时角色 API 返 503、流转视图返 503、任务角色使用情况仍可返回（仅显示名/null 预算）。生产入口 `main.ts` 始终注入三者。
2. **编辑只更新配置文件，不热更新运行中内核的内存角色表**。规格要求的是「写入前校验 + 随后加载该配置能得到与提交一致的角色」，已由 `GET /api/roles`、`loadRole` 满足；但已在内存里的 `kernel.roles` 仍是旧定义，**重启服务后才对新建任务生效**。若要"编辑后即时影响后续节点"，属于额外范围（需把新 RoleDef 热替换进内核角色表），本次刻意不做以免改变运行时行为。
3. **编辑校验用的 `workflowId = deps.workflow?.id ?? 'simple_dev'`**。当前仅 `simple_dev`。若将来 `main.ts` 使用另一个工作流 id 而该 id 的工作流文件不在 `configDir` 中，所有编辑都会因 `loadWorkflow` 找不到文件而 422——需同步保证「内核工作流 id ↔ config 内的工作流文件」一致。
4. **校验临时目录会复制整个 `configDir`**。当前配置很小，代价可忽略；若将来配置体积显著增长，可改为只复制被编辑角色 + 引用它的工作流。
5. **测试在 `/tmp` 留下了临时配置目录与仓库目录**（`mkdtempSync` 产物，未清理），与既有测试风格一致；非仓库文件，不入库。
6. 并发风险已知悉：改文件前均先读当前内容、改后 `grep`/重跑复核落盘（本报告 §5 已复核变异已还原、校验调用存在且唯一）。