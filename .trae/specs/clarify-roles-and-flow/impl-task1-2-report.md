# 实现报告：Task 1 + Task 2（配置层自解释）

> 规格：`.trae/specs/clarify-roles-and-flow/spec.md`；任务清单：同目录 `tasks.md`；核对清单：同目录 `checklist.md`（「A. 配置层自解释」）。
> 工作目录：`/Users/40kuai/Documents/多agent开发流程`（分支 `main`）。
> 结论：**DONE_WITH_CONCERNS** —— Task 1 / Task 2 全部子任务完成并通过验证；concern 见文末（并发进程与"类型容忍度"取舍）。

---

## 0. 一句话结论

- 契约**唯一权威来源 = 角色的 `inputs`/`outputs`**；节点的 `consumes`/`produces` 为**派生**，加载期一致性校验，冲突报错且**指明角色 id、节点 id、冲突字段**。
- 角色新增 `responsibilities` / `prohibitions` / `doneCriteria`；工作流节点新增 `description` / `entryCondition`，边新增 `description` / `onMissing`（`fail` | `wait`）。
- `npx vitest run` = **179/179 通过**；`npx tsc --noEmit` **exit 0**；变异验证**恰好 2 条**用例变红。
- `web/` **未被触碰**；`tests/fixtures/` 4 个归档样本**未改**；未新增依赖；未调用真实 claude。

---

## 1. Task 1：角色契约唯一来源 + 角色定义自解释

### 1.1 领域类型（`src/shared/domain.ts`）

| 字段 | 位置 | 说明 |
| --- | --- | --- |
| `responsibilities?: string[]` | `:32` | 职责边界（边界之内做什么） |
| `prohibitions?: string[]` | `:34` | 禁止事项 |
| `doneCriteria?: string[]` | `:36` | 完成判据 |

**数组 vs 字符串的选择（为什么用数组）**：三类字段本质上都是"多条清单"——职责通常多条、禁止事项需逐条列举、
完成判据要逐条对照验收；数组便于逐条阅读、逐条校验（任一条为空即报错）、逐条展示。只有"单一不可分割的说明"
才用字符串（本任务中边的 `description`、节点的 `entry_condition` 即此类）。YAML 侧字段名为 snake_case
（`responsibilities` / `prohibitions` / `done_criteria`），与既有 `display_name`、`max_retries` 风格一致；TS 侧 camelCase。

同时补充了 `WorkflowNodeDef.consumes`/`produces` 的注释（`:50` / `:52`），点明它们是**派生**字段。

### 1.2 文件 schema（`src/config/schema.ts`）

- 角色三类字段为**必填**，中文校验错误：`:14-33`
  - 缺字段 → `缺少必填字段 responsibilities（职责边界）`（`required_error`）
  - 类型错 → `responsibilities（职责边界）必须是字符串数组`（`invalid_type_error`）
  - 空数组 → `responsibilities（职责边界）至少声明一条`
  - 空字符串条目 → `responsibilities（职责边界）的每一项都不得为空`
  - `prohibitions` / `done_criteria` 同构。

### 1.3 三个角色 YAML（`config/roles/*.yaml`）

均声明了职责边界、禁止事项、完成判据，并把路径语义写进注释：

- `config/roles/pm.yaml`：`owns: []`（只读角色），三类字段见 `:11-21`。
- `config/roles/backend_dev.yaml`：`owns: ["src/**"]`，越界写列为禁止事项，见 `:8-25`。
- `config/roles/qa_engineer.yaml`：`owns: ["tests/**"]`，"报告缺陷通过产物内容"写进注释与职责，见 `:9-29`。

### 1.4 契约唯一来源 + 加载期一致性校验（`src/config/loader.ts`）

- `loadRole` 带出三类字段：`:47` / `:48` / `:49`。
- 集合比较（顺序无关）：`sameStringMultiset` `:75`。
- 校验函数：`assertNodeContractMatchesRole` `:86`
  - `consumes` 冲突 → `:91` 抛出：`工作流 {id} 的节点 {node} 与角色 {role} 的契约冲突（字段 consumes/inputs）：节点声明 consumes=[…]，角色权威值 inputs=[…]；…`
  - `produces` 冲突 → 抛出：`… 的契约冲突（字段 produces/outputs）：节点声明 produces=…，角色权威值 outputs=[…]；…`
- `loadWorkflow`：先做 start/边存在性校验，再 `loadAllRoles` 逐节点核对：
  - 未注册角色 → `:138` `工作流 {id} 的节点 {node} 引用了未注册的角色：{role}`
  - 一致时**以角色值回填派生字段**（`consumes` 取 `role.inputs` 顺序、`produces` 取 `role.outputs[0]`）：`:145-147`

**报错三要素自检**：消息文本同时含 **角色 id**（`角色 pm`）、**节点 id**（`节点 n1`）、**冲突字段**（`consumes/inputs` 或 `produces/outputs`）——测试逐项断言（见 §3）。

---

## 2. Task 2：工作流拓扑自解释

### 2.1 领域类型（`src/shared/domain.ts`）

- 节点：`description?`（`:56`，本节点在流程中的职责）、`entryCondition?`（`:58`，进入本节点的条件说明）。
- 边：`description?`（`:67`）、`onMissing?: 'fail' | 'wait'`（`:72`；`fail`=判定任务失败，`wait`=保持等待，供 join 语义使用）。

### 2.2 文件 schema（`src/config/schema.ts`）

- 节点：`description` / `entry_condition` 为**可选**，声明时不得为空串（`:50` / `:52`）——与 spec「节点 SHALL **可**声明」一致。
- 边：`description`（`:60-62`）与 `on_missing`（`:65-69`）为**必填**；`on_missing` 用自定义 `errorMap` 覆盖 zod 默认英文消息
  （`ZodEnum` 的 `invalid_enum_value` 不受 `invalid_type_error` 影响，实测后改用 `errorMap`）。
  - 缺 `description` → `缺少必填字段 description（边的人类可读说明）`
  - 缺 `on_missing` → `on_missing（条件不满足时的失败语义）只能是 fail 或 wait`
  - 非法取值 → 同上。

### 2.3 工作流配置（`config/workflows/simple_dev.yaml`）

- 3 个节点均声明 `description` + `entry_condition`（`:14-15` / `:23-24` / `:33-34`）。
- 2 条边均声明 `description` + `on_missing: fail`（`:45-46` / `:51-52`）。
- 顶部注释写明：节点的 `consumes`/`produces` 是派生字段、权威来源是角色 YAML（`:8-9`）。
- 三个节点的 `isolate` 仍全为 `false`（Phase 1 硬约束未变）；节点/边的 `consumes`/`produces`/`when` 语义未变，**不改变串行行为**。

### 2.4 引擎是否消费 `on_missing`？

**否**——本任务只落地配置字段（Task 2 明确范围为配置层）。`on_missing` 的消费属 **Task 4**（决策结构化/失败语义）。
当前 `simple_dev` 两条边均为 `fail`，与现有"无条件满足即 failed"的行为一致，故无行为变化。

---

## 3. 测试与验证

### 3.1 新增/更新测试

- `src/config/loader.test.ts`（新增 12 条）：
  - 角色带出三类字段；缺职责边界时校验失败（中文）。
  - 契约唯一来源：`consumes` 冲突、`produces` 冲突（各断言**节点 id / 角色 id / 冲突字段**三个要素）、未注册角色报错、
    一致时以角色为权威回填（`consumes` 顺序按角色 `inputs`）。
  - 拓扑字段：节点 `description`/`entry_condition` 解析保留；节点 `description` 空串报错；边缺 `description` 报错；
    边缺 `on_missing` 报错；边 `on_missing` 非法值报错；边 `description`/`on_missing` 加载后可读（`wait` 值）。
- `src/config/real-config.test.ts`（新增 3 条）：三角色均声明三类字段且加载后可读；`simple_dev` 节点含说明与进入条件、
  边含说明与失败语义；节点 `consumes`/`produces` 与角色 `inputs`/`outputs` 一致（唯一权威来源）。
- 既有夹具更新：`loader.test.ts` 内联 YAML（角色三类字段、`bad2.yaml` 边字段）；
  `src/kernel/state-machine.test.ts`、`src/kernel/facts.test.ts` 的边字面量补字段（仅使字面量自解释；因领域类型上这些字段可选，非编译必需）。

### 3.2 全量结果

```
Test Files  20 passed (20)
     Tests  179 passed (179)

npx tsc --noEmit
tsc exit=0
```

（改前基线：20 文件 / 164 通过；本次 +15 条，其中 loader 12 条、real-config 3 条。）

### 3.3 变异验证（Task 1.4 要求）

在 `assertNodeContractMatchesRole` 首行临时插入 `return; // 变异验证：临时禁用一致性校验`，重跑：

```
 ❯ src/config/loader.test.ts (21 tests | 2 failed) 28ms
   × 契约唯一来源… > 节点 consumes 与角色 inputs 冲突时加载报错，并指明角色 id、节点 id、冲突字段
   × 契约唯一来源… > 节点 produces 与角色 outputs 冲突时加载报错，并指明角色 id、节点 id、冲突字段
     → expected [Function] to throw an error
 Test Files  1 failed (1)
      Tests  2 failed | 19 passed (21)
```

**结论**：去掉校验后**至少一条测试变红（实测恰好 2 条）**；还原后重新全绿（179/179、tsc exit 0）。

---

## 4. `owns` / `reads` 语义裁决与理由

**裁决**：`owns` = **允许写入的路径（写边界）**；`reads` = **允许读取的路径**；空 `owns` = 只读角色。
两者在 Phase 1 仍只是 prompt 中的硬约束提示，**路径级强制属后续任务**（本任务不改运行时行为）。

针对规格 Why 第 2 条的两处矛盾：

1. **`backend_dev`：`owns: ["src/**"]` 但实测写了 `README.md` / `scripts/hello.sh`**
   - 裁决：**不放宽 `owns`**。这两处写入就是**越界**，应在后续"路径级强制"（Task 7）中被检出并记为违规；
     放宽 `owns` 去追认越界行为，等于把越界合法化，与 D 段"越界写必须被检出"的目标相悖。
   - 落地：在 `prohibitions` 明确列出"不得写入 `src/**` 之外的任何路径（含 `README.md`、`scripts/**`、`tests/**`）"，
     并在 `done_criteria` 加"`files_changed` 全部落在 `owns` 之内"。
   - 影响面：仅语义澄清；越界检出由 Task 7 实现（本任务不动 `kernel.ts`）。

2. **`qa_engineer`：`owns: ["tests/**"]` 与"报告缺陷"职责冲突**
   - 裁决：**不冲突**。"报告缺陷"是通过 **`test_report` 产物的内容（`failures` / `failed`）** 表达的，
     **不是**通过修改被测代码实现的；`owns: ["tests/**"]` 指"允许写自己的测试脚本"，与其职责自洽。
     （`config/prompts/qa_engineer.md` 本就要求"不要为了让测试通过而修改实现代码；发现缺陷就在 failures 里写清楚"。）
   - 落地：`prohibitions` 明确"不得修改 `src/**`（只读）：不得为让测试通过而改实现代码"、"不得写入 `owns` 之外的路径"；
     职责与完成判据均写明缺陷走 `failures`。
   - 影响面：仅语义澄清，无行为变化。

3. **`pm`：`owns: []`** = 只读角色（不写任何文件），需求以 `requirement` 产物表达。

---

## 5. 一处设计取舍（需知悉）

**"配置即说明书"落在文件 schema 上，TS 领域类型保持容忍**：

- `src/config/schema.ts`：角色三类字段、边的 `description`/`on_missing` 为**必填**——配置文件必须自解释。
- `src/shared/domain.ts`：上述字段在类型上为**可选**——允许程序化构造 `RoleDef`/`WorkflowDef`（测试、后续 fan-out/join）
  不必填展示性字段；加载后的真实配置始终带值（`loader` 会回填/带出）。

这么做的直接原因：**工作区正有另一进程并发编辑** `src/kernel/kernel.test.ts`、`src/server/server.test.ts`、
`src/kernel/{kernel,projector}.ts`、`src/server/server.ts`、`web/**`（详见 §6）。若把这几类字段设为**领域类型必填**，
则这些并发文件里现存的字面量会立刻 `tsc` 失败——那会破坏他人正在进行的工作。故取"文件强制、类型容忍"。
若后续希望类型层也强制，可在并发工作落定后把 `domain.ts` 的 `?` 去掉（改动极小）。

---

## 6. 疑虑与并发风险（concern）

1. **并发进程正在编辑共享文件**：`git status` 显示除我的文件外，另有他人未提交改动：
   `src/kernel/kernel.test.ts`（+`project` 导入与一条 `log_ref` 用例）、`src/kernel/kernel.ts`、`src/kernel/projector.ts`、
   `src/kernel/projector.test.ts`、`src/server/server.ts`、`src/server/server.test.ts`、`web/src/api.ts`、
   `web/src/components/LogViewer.tsx`，以及未跟踪的 `src/website/`。**这些均非我所作，我未改、未回退、也不会提交。**
   编辑过程中，我对 `src/kernel/state-machine.test.ts` 的 4 处边字面量改动一度被并发写覆盖（17/18/80/182 行回退）；
   因领域类型上边字段可选，这**不影响编译与测试**，故未强行反复重写（避免与并发写互相踩踏）。
2. **提交范围**：仅逐个 `git add` 我自己的文件（见 §7），不使用 `git add -A`；`web/**`、`src/website/`、
   `src/kernel/kernel.ts`、`src/kernel/projector.ts`、`src/server/server.ts` 等一律不纳入。
3. **边 `description`/`on_missing` 的领域类型可选**（同 §5）：若未来有人仅用代码构造工作流且不带
   `onMissing`，Task 4 消费时需容错（本任务未引入消费）。已在注释标注。
4. **未做**（属后续任务，符合约束）：`owns` 路径级强制、并发、fan-out/join、`on_missing` 的引擎消费、角色/流程查询与编辑 API。

---

## 7. 改动文件清单（file:line 摘要）

| 文件 | 改动 |
| --- | --- |
| `src/shared/domain.ts` | `RoleDef` 加 `responsibilities`/`prohibitions`/`doneCriteria`（`:32/34/36`）；`WorkflowNodeDef` 加 `description`/`entryCondition`（`:56/58`）；`WorkflowEdgeDef` 加 `description`/`onMissing`（`:67/72`）；`consumes`/`produces` 注释说明派生 |
| `src/config/schema.ts` | 角色三类字段必填+中文错误（`:14-33`）；节点 `description`/`entry_condition` 可选（`:50/52`）；边 `description`/`on_missing` 必填+中文错误（`:60-69`） |
| `src/config/loader.ts` | 角色三类字段映射（`:47-49`）；`sameStringMultiset`（`:75`）、`assertNodeContractMatchesRole`（`:86-…`）；`loadWorkflow` 加载角色、未注册角色报错（`:138`）、校验（`:140`）、派生回填（`:145-147`）、节点/边字段映射（`:149-163`） |
| `config/roles/pm.yaml` | 三类字段（`:11-21`）、`owns` 只读语义注释 |
| `config/roles/backend_dev.yaml` | 三类字段（`:8-25`）、越界列为禁止事项 |
| `config/roles/qa_engineer.yaml` | 三类字段（`:9-29`）、"报告缺陷走产物"说明 |
| `config/workflows/simple_dev.yaml` | 节点 `description`/`entry_condition`（`:14-15`, `:23-24`, `:33-34`）、边 `description`/`on_missing`（`:45-46`, `:51-52`）、契约来源注释（`:8-9`） |
| `src/config/loader.test.ts` | 内联夹具补字段；新增契约唯一来源与拓扑字段共 12 条用例 |
| `src/config/real-config.test.ts` | 新增 3 条真实配置断言 |
| `src/kernel/state-machine.test.ts` | 边字面量补 `description`/`onMissing`（自解释；非编译必需） |
| `src/kernel/facts.test.ts` | 同上（1 处） |
| `记录.md` | 新增「配置层自解释：Task 1 + Task 2」小节 |
| `.trae/specs/clarify-roles-and-flow/tasks.md` | Task 1 / Task 2 及子任务标记完成 |

**未触碰**：`web/**`（任何文件）、`tests/fixtures/**`（4 个归档样本）、`package.json`/`package-lock.json`（无新依赖）、
全局环境（`~/.npmrc`、全局安装、系统 Python）。

---

## 8. 复现命令

```bash
npx vitest run            # 179/179
npx tsc --noEmit          # exit 0
# 变异验证：在 src/config/loader.ts 的 assertNodeContractMatchesRole 首行加 `return;`
npx vitest run src/config/loader.test.ts   # 2 failed | 19 passed
git status --short        # 确认仅我的文件被改动（web/ 不在其中）
```