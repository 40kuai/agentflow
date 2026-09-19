# Task 12 + Task 13 实现报告：并行示例工作流 + 文档台账同步

- 日期：2026-09-19
- 规格：`.trae/specs/clarify-roles-and-flow/spec.md`；任务清单 `.trae/specs/clarify-roles-and-flow/tasks.md`
- 分支：`main`
- 未新增依赖、**未真实调用 claude**、未触碰全局环境、**未改 `web/`、`src/website/`、`tests/website/`、4 个归档 fixture**

---

## 一、Task 12：并行示例工作流

### 1. 新增文件

| 文件 | 作用 |
| --- | --- |
| `config/workflows/parallel_dev.yaml` | 并行演示工作流（fan-out → 并发 → join） |
| `config/roles/pm_planner.yaml` + `config/prompts/pm_planner.md` | 工作包拆解角色（只读，产出 `work_package_plan`） |
| `config/roles/backend_dev_module_a.yaml` + `config/prompts/backend_dev_module_a.md` | 模块 A 开发角色（`owns: ["src/module_a/**"]`） |
| `config/roles/backend_dev_module_b.yaml` + `config/prompts/backend_dev_module_b.md` | 模块 B 开发角色（`owns: ["src/module_b/**"]`） |

### 2. `parallel_dev.yaml` 结构（5 节点 / 5 边）

节点：

| 节点 id | 角色 | consumes（权威=角色 inputs） | produces（权威=角色 outputs[0]） | isolate |
| --- | --- | --- | --- | --- |
| `pm_analyze`（start） | `pm` | `[]` | `requirement` | false |
| `pm_plan` | `pm_planner` | `[requirement]` | **`work_package_plan`**（首次真正用上该类型） | false |
| `dev_module_a` | `backend_dev_module_a` | `[work_package_plan]` | `code_diff` | **true** |
| `dev_module_b` | `backend_dev_module_b` | `[work_package_plan]` | `code_diff` | **true** |
| `qa_verify`（join） | `qa_engineer` | `[requirement, code_diff]` | `test_report` | false |

边：

| from → to | when | on_missing | 说明 |
| --- | --- | --- | --- |
| `pm_analyze → pm_plan` | `all(artifacts.requirement.status == 'ok')` | `fail` | 需求澄清后才拆解 |
| `pm_plan → dev_module_a` | `all(artifacts.work_package_plan.status == 'ok')` | `fail` | **扇出**（第 1 条出边） |
| `pm_plan → dev_module_b` | `all(artifacts.work_package_plan.status == 'ok')` | `fail` | **扇出**（第 2 条出边） |
| `dev_module_a → qa_verify` | `all(artifacts.code_diff.status == 'ok')` | `wait` | **join**（第 1 条入边） |
| `dev_module_b → qa_verify` | `all(artifacts.code_diff.status == 'ok')` | `wait` | **join**（第 2 条入边） |

所有节点均声明 `description` 与 `entry_condition`；所有边均声明 `description` 与 `on_missing`（加载期必填校验通过）。

### 3. 两个并行开发节点的 `owns` 如何保证不相交

- 两个开发节点使用**两个不同角色**，`owns` 分别为 `["src/module_a/**"]` 与 `["src/module_b/**"]`。
- `ownsPatternsIntersect` 的段级 DP 判定二者不相交：首段字面量 `module_a` ≠ `module_b`，故不存在共同匹配路径。
- 已补测试断言：`detectOwnsOverlaps(batch)` 为空数组，`checkBatchOwns(batch).mode === 'parallel'`（**未退化**为 `serialize`/`reject`）。

**为什么不复用 `backend_dev`**：其 `owns: ["src/**"]` 会让两个并行节点拿到**相同**的 owns → 必然重叠 → 占用检查把该批次降为串行，示例就演示不了并行。故**必须新增按模块划分的角色**（这也是规格 Task 12.2 的显式要求）。

### 4. 测试节点为何复用 `qa_engineer`

`qa_engineer` 的权威 `inputs` 为 `[requirement, code_diff]`。由于契约唯一来源规则（节点 `consumes` 必须等于角色 `inputs`），若直接复用，本流程必须有真实的 `requirement` 产物——因此 `parallel_dev` 保留了起始的 `pm_analyze`（role `pm`）产出 `requirement`，契约**自洽**，无需另造测试角色。

### 5. `simple_dev` 串行基线未变

- 未改 `config/workflows/simple_dev.yaml`（三节点直线、全部 `isolate: false`）。
- 既有断言 `simple_dev 所有节点 isolate 均为 false（串行基线护栏）` 仍通过。

---

## 二、Task 13：文档与台账同步

### 1. 设计文档 `docs/superpowers/specs/2026-09-18-multi-agent-dev-orchestration-design.md`

| 位置（行号） | 改了什么 |
| --- | --- |
| `:305-311`（§7.2 角色定义 yaml） | `owns` 注释由「设计意图（Phase 1 未实现强制）」改为「允许写入的路径，越界会被检出」；新增 `responsibilities`/`prohibitions`/`done_criteria` 三类字段 |
| `:318-328`（§7.2 注） | 原「`owns` **零强制**」整段改写为「契约唯一来源 / 角色自解释 / **`owns` 已强制**」+ **历史注记**（原零强制状态及其越界实测，明确已被取代）；保留 CLI 层不按路径收窄的边界说明 |
| `:472-485`（§9.2 后新增注） | 补「工作流即可读说明书」（节点 `description`/`entry_condition`、边 `description`/`on_missing`）+ **`decideNext` 结构化**（激活节点集合 / 选中边 / 未选中边及原因 / wait 与 failed 区分）+ **失败原因分类枚举** |
| `:505-509`（§9.3 后新增注） | 三层决策「当前只落地第 ① 层规则求值」，LLM 兜底与 G3 人工卡点未实现 |
| `:568-593`（§10.5 后新增注） | **并发与隔离已落地**：fan-out/join、消费 `AGENTFLOW_GLOBAL_CONCURRENCY`、批次启动前占用检查、worktree 隔离与确定性合并、串行等价性、`parallel_dev` 示例；并列出**仍未覆盖**项 |
| `:765-767`（§11.5 后新增注） | 全局并发上限已实现、每引擎并发上限未实现 |
| `:886`（§15 工作区安全行） | 由「Phase 1 未实现路径级强制」改写为「**已实现（Task 7/8/11）**」，并标注 CLI 层边界 |
| `:918-920`（§16 Phase 1 验收后） | 补「实现进展」：串行闭环已跑通 + 并行内核能力已提前落地 + `simple_dev` 仍是串行基线 |
| `:931-941`（§16 Phase 2） | 补「实现进展」：逐条对照**已实现 / 部分或未实现**（PM 拆解质量自动保证、`serialization_key`、worktree 池、`integrator`/`conflict_report`、每引擎并发上限、`type: parallel` 语法均未做） |

历史注记均保留（可回看），但现状已明确标注，不再与实现矛盾。

### 2. 计划文档 `docs/superpowers/plans/2026-09-18-agentflow-phase0-phase1.md`

| 位置（行号） | 改了什么 |
| --- | --- |
| `:27-33`（Global Constraints） | 补「2026-09-19 修订」：并行已由后续规格落地；「所有节点 `isolate: false`」**仅仍适用于 `simple_dev`**；串行验收行为未变；codex / G1–G3 仍未实现 |
| `:4246-4249`（Task 11 Step 7 代码块后） | 订正该步骤注释里「worktree 隔离属 Phase 2」已过时；`simple_dev` 仍全 `isolate: false` |
| `:6428-6434`（本阶段之后仍未做的事） | 并行条目改标：**已部分落地**（fan-out/join、隔离与合并、`owns` 强制、`parallel_dev`）+ **仍未做**清单 |

### 3. `记录.md`

> 改前已重读当前内容（当时工作区中 `记录.md` 无并发进程的未提交改动）。**只改/追加了下列段落，未还原任何他人改动。**

| 位置（行号） | 改了什么 |
| --- | --- |
| `:118` | 契约修复条目 ③ 后加「**当轮状态**；并发调度其后已由 Task 9/10 落地，"恒为 0" 不再成立」 |
| `:200-201` | 契约修复「缺陷 3（假指标）」条目末加 **2026-09-19 后记**：并发已落地、`env.globalConcurrency` 已被消费，"并行度恒为 0" 不再成立（历史条目保留） |
| `:817`（未完成表 `并发调度` 行） | 由「**并发调度未实现** … 全仓无消费者 … 并行度恒为 0**」改写为「**✅ 已实现（Task 9/10/11）**」，原缺口描述降级为「当时记录，保留备查」 |
| `:924`（内部管理台待办表） | 同上一行：`~~并发调度未实现~~` → ✅ 已实现，原表述保留为「当时记录」 |
| `:1035` | Task 11 边界条目「并行示例工作流（Task 12）未实现」加后记（已由 Task 12 落地） |
| `:1042-1091`（文末新增节） | 新增「**并行示例工作流 + 文档台账同步（Task 12 + Task 13）**」一节：已完成、仍未覆盖（PM 拆解质量自动保证 / G1–G3 卡点 / 前端渲染 / `serialization_key` / worktree 池 / `integrator` / 每引擎并发上限）、验证说明与已知边界 |

已确认 `记录.md` 中「并行度恒为 0 / 并发调度未实现 / `globalConcurrency` 无消费者」类**与实现矛盾的表述**：要么被改写为既成事实，要么被明确标注为「当时记录（已被取代）」。

---

## 三、测试与验证

### 1. 新增/更新的测试

- `src/config/real-config.test.ts`
  - 更新：角色清单断言扩为 6 个角色（新增 3 个）。
  - 新增 3 条：
    1. `parallel_dev 示例工作流能通过全部加载期校验（契约一致性 / 边引用完整性）`（5 节点、逐节点核对 consumes/produces、description/entryCondition 存在）。
    2. `parallel_dev 结构：PM 产出 work_package_plan 后扇出两个开发节点，再 join 到测试节点`（扇出/join 边断言 + join 边 `on_missing === 'wait'`）。
    3. `parallel_dev 的两个并行开发节点 owns 经占用检查判定为不相交（可并行）`（`detectOwnsOverlaps === []` 且 `checkBatchOwns().mode === 'parallel'`）。
- `src/server/server.test.ts`
  - 更新 1 条测试期望值：`GET /api/roles` 用例原先硬编码期望三个角色，改为按真实 `config/roles` 注册数（6 个）。**仅改测试期望值，服务实现代码一字未改**（见「疑虑」）。

### 2. 结果

- `npx tsc --noEmit` → **exit 0**。
- 相关单测：`src/config/real-config.test.ts` **9/9**、`src/config/loader.test.ts` **21/21**、`src/kernel/path-guard.test.ts` **23/23**、`src/server/server.test.ts` **42/42**。
- 全量 `npx vitest run` → `Test Files 1 failed | 22 passed (23)`，`Tests 3 failed | 299 passed (302)`。
  - **3 条失败全部在 `tests/website/website.test.ts`**（并发进程的 website 任务，未触碰、未修复）：
    - `AC2 站点位于仓库根独立目录 website/`、`AC6 对仓库其余内容零改动` —— **既有失败**（与本次无关）。
    - `AC5 已实现角色数（3）与 config/roles 实际注册一致` —— **由本次新增 3 个角色触发**（该断言直接读 `config/roles` 文件数并写死 `['backend_dev','pm','qa_engineer']`）。
      见「疑虑」。

---

## 四、疑虑 / 需控制者知悉

1. **新增角色必然使 website 的 AC5 失败**：并行示例要求两个开发节点 `owns` 不相交，而 `owns` 只来自角色定义，故**必须新增角色**（规格 Task 12.2 明确要求）。
   这会让 `tests/website/website.test.ts::AC5`（写死"只有 3 个角色"）失败。该文件属用户并行开发的官网任务、任务约束禁止修改，故未动。
   **需要官网负责人**把站点文案的角色数/列表与 `config/roles` 实际注册数对齐（当前为 6）。这属于两个并行任务的交界，非本次可自行解决。
2. **`src/server/server.test.ts` 的期望值更新**：新增角色后，`GET /api/roles` 用例的硬编码期望必然失败。我把它按真实注册数最小更新（**仅测试期望值**，未改 `server.ts` 任何实现逻辑）。若控制者认为该文件属"已完成任务、不得触碰"的严格范围，请指示——但没有它相关单测无法全绿。
3. **`on_missing` 目前是声明式的**：加载期解析、经 API 暴露，但内核尚未消费它来区分 fail/wait；join 的"等全部上游"由主循环「有在途节点即 wait」保证。因此 `parallel_dev` 的 join 边写 `on_missing: wait` 表达**意图**，运行期行为与 `fail` 当前一致。已在设计文档 §9 注与 `记录.md` 如实标注。
4. **`parallel_dev` 未被 `main.ts` 引用**：`main.ts` 仍固定加载 `simple_dev`（未改，属已完成任务的接线）。`parallel_dev` 是配置层可加载、可校验的示例；要实际跑它需另行指定（属后续接线）。
5. 剩余未覆盖范围（已在文档与 `记录.md` 如实登记）：PM 工作包拆解质量的自动保证、G1–G3 人工卡点、前端渲染（`web/` 归用户）、`serialization_key`、warm worktree 池、`integrator`/`conflict_report`、每引擎并发上限。