# I4 交接单：`required:["status"]` 与 `default:"ok"` 并存

> 目的：让新会话**不必重新调查**即可开工
> 日期：2026-09-19
> 来源：`docs/superpowers/specs/2026-09-19-agentflow-phase2-requirements.md` §10.1 的 Important I4
> 优先级：**Phase 2 开工前最高**（与原始缺陷 C1 同源）

---

## 1. 问题（一句话）

发往 CLI 的 `--json-schema` 里，`status` **同时**被声明为 `required` 且带 `default:"ok"`。若 harness 对缺失字段应用 JSON Schema `default`，则「**模型漏给 status → 被兜成 ok → 工作流边条件恒真**」这条静默路径**并未真正关闭**——只是从"契约里没有该字段"换成了"有字段但缺失时被兜底"。

## 2. 为什么这是最高优先（原始缺陷现场）

一次真实任务失败时的硬证据链：

1. `config/prompts/pm.md` 要求模型「把 status 判为 blocked」，但当时 payload schema **没有 `status` 字段**
2. 模型只能把判断塞进 `problem` 字符串（原始日志逐字可见：`"status: blocked —— 需求…存在关键歧义"`）
3. 模型 5 次 `StructuredOutput` 调用**键集合完全合规**（恰好只有 schema 要求的 4 个键），每次工具返回 "Structured output provided successfully" —— **模型没做错**
4. 内核写死 `status: 'ok'`，而工作流边条件是 `all(artifacts.requirement.status == 'ok')`
5. → **模型的语义判断被静默吃掉**，任务没有按"需求有歧义"停下来

`4fe53c2` + `f3a7300` 修好了 1–5（status 进入契约、内核消费、边条件真实翻转、有端到端断言）。**I4 是这条链上可能残留的最后一个静默口**。

## 3. 相关位置与证据

| 环节 | 位置 | 现状 |
| --- | --- | --- |
| zod payload schema | `src/shared/artifacts.ts` 的 `ARTIFACT_PAYLOAD_SCHEMAS`（4 个类型各有一处 `status: z.enum([...]).default('ok')`） | 含 `.default('ok')` |
| JSON Schema 生成 | `src/shared/artifacts.ts` 的 `jsonSchemaForArtifact` | 注入 `required:["status"]`（`f3a7300` 所做），但**属性仍带 `default:"ok"`** |
| 发往 CLI | `src/kernel/kernel.ts` 传 `outputSchema` → `src/runner/claude-code-runner.ts` 拼 `--json-schema` | 内核**恒传** `outputSchema` |
| 服务端解析 | `src/shared/artifacts.ts` 的 `parseArtifactPayload` | 返回 `{status, payload}`，status 从 payload 剔除 |
| 验收判据 | `config/workflows/simple_dev.yaml` 的边条件 `all(artifacts.requirement.status == 'ok')` | 依赖 status 真实取值 |

评审已实测（非推断）：打印 4 个类型的 JSON Schema，`required` 均含 `status`，且 `properties.status` 形如
`{"type":"string","enum":["ok","needs_changes","blocked"],"default":"ok"}`。

## 4. ⚠️ 决定修法的关键约束（先读这条再动手）

**不能简单地把 `.default('ok')` 删掉。** 因为：

- 归档 fixture（`tests/fixtures/claude-stream-structured-sample.jsonl` 等 3 份）是在 `status` 字段存在**之前**采集的**逐字真实证据**
- `tests/fixtures/**` **只增不改**——这是本项目的硬规则（它们是契约的唯一可信来源）
- 评审已实测：让归档样本过 `parseArtifactPayload` 会得到 `status=ok`，**这个 ok 正是来自该 default**
- 若删掉 default，归档样本将解析失败，**破坏向后兼容并导致既有契约测试变红**

### 因此：解析侧与签发侧必须分开

同一个 zod schema 服务两个**不同消费者**，它们的诉求相反：

| 消费者 | 诉求 |
| --- | --- |
| **解析**（服务端处理历史载荷/归档 fixture） | 缺失 `status` 时**要**有 `ok` 兜底（兼容旧数据） |
| **签发**（发往 CLI 的 `--json-schema`） | 缺失 `status` 时**绝不能**兜底（否则静默成功） |

**正确修法**：`jsonSchemaForArtifact` **在输出前剥离 `status` 属性上的 `default`**（或让签发路径使用一份不含 default 的变体），解析路径保持 `.default('ok')` 不变。

- 不要改 zod schema 本身的 `.default('ok')`
- 不要改 `parseArtifactPayload` 的行为
- 不要在 schema 里删掉 `status`（`required` 要保留）
- `additionalProperties: false` 必须保留

## 5. 必须先做的判定（决定是"修"还是"验"）

先确认一个事实问题：**`--json-schema` 的 harness 到底会不会对缺失字段应用 JSON Schema `default`？**

- 若**会**应用 → 必须按第 4 节修（这是 bug）
- 若**不会**应用 → 该 `default` 是无害冗余，但仍建议剥离，因为它**语义含混**（"必填"与"默认值"同时声明自相矛盾），且未来 CLI 版本可能改变行为

判定手段（按成本排序）：
1. **代码/文档层面**：查 CLI 对 `default` 的处理（不花钱）
2. **一次最小真实调用**（会花钱，约 $0.05）：用一个**明确指示模型不要输出 status** 的 prompt + 带 `required`+`default` 的 schema，观察结果是"被兜成默认值"还是"报错/重试"。**注意：单次样本不足以下结论**，只能作为旁证
3. 无论判定结果如何，**剥离 default 都是可以做的**（它消除含混），所以推荐直接修 + 加回归护栏

## 6. 验收标准（可测）

1. **签发侧无默认值**：对 4 个 artifact 类型逐一断言——生成的 JSON Schema 中 `required` 包含 `status`，且 `properties.status` **不含 `default`**
2. **解析侧兼容不变**：3 份归档 fixture 的解析测试**仍全绿**；`tests/fixtures/**` 的 blob **逐字未变**（用 `git diff --stat` 证明）
3. **语义真实生效**：既有端到端断言仍绿——「模型判 `blocked` → 边不通过 → `task.failed` 且 reason 含 `requirement=blocked`」（`src/kernel/kernel.test.ts`）
4. **变异验证**：把 `default` 重新加回签发路径 → 第 1 条断言**必须变红**；把解析侧的 `.default('ok')` 删掉 → 归档 fixture 测试**必须变红**。两个方向都要验（证明两边各有判别力，不是"改了都绿"）

## 7. 硬性约束

- **`tests/fixtures/**` 只增不改**（唯一例外是新增样本，且必须逐字归档）
- 不新增依赖；项目是 ESM，相对导入带 `.js` 后缀；代码注释用中文；提交信息 `类型: 说明`
- 不要改动 `parseArtifactPayload` 的返回形状（`{status, payload}` 已被内核与前端消费）
- **不要**在本次顺手做其他 P0/P1 项（避免范围蔓延与冲突）
- **不要**真的批量调用 claude；若做第 5 节的判定，控制在 1 次、`--max-budget-usd` 设小

## 8. ⚠️ 并行开发：动手前先重新确认文件占用

本仓库有**多方同时开发**，占用情况变化很快。**开工前必须先跑一次 `git status --short` 与 `git log --oneline -n 15`**，确认下列文件当时**没有**被他人改：

| 文件 | 上次检查（2026-09-19） | 说明 |
| --- | --- | --- |
| `src/shared/artifacts.ts` | 🟢 空闲（**本次主战场**） | 若已被改动，先协调 |
| `src/kernel/kernel.ts` | 🔴 他人主责（并发/调度） | 本任务**只需读**，不要改 |
| `src/runner/claude-code-runner.ts` | 🟠 可能被卷入 | 仅在确需时改 |
| `web/**` | 🔴 已变争用区 | 本任务**不需要**改前端 |
| `记录.md` | 🟠 被多人改 | 追加而非改写；或请示控制者 |

**已知的他人进展**：并发调度**已实现**（`kernel.ts` 的 `concurrencyLimit` 与批上限、`guard.mode === 'serialize'` 退化路径、`main.ts` 已接线 `globalConcurrency`）。因此 Phase 2 需求文档 §1.2 的 P1/P2 已失效——**不要去"实现并发"**。

## 9. 完成后的回报要求

- 逐条给出第 6 节 4 项的**实际执行命令与输出**
- 第 5 节的判定结论（会/不会应用 default）与依据
- 报告须与事实一致（本项目曾出现报告结论被真实数据证伪的情况，务必自查）
- 若发现本交接单的判断有误（例如剥离 default 会破坏别的东西），**如实推翻并说明**，不要迁就本单

---

## 附：本次评审的其余 4 项 Important（供后续排期，不在本单范围）

| # | 问题 | 位置 | 冲突风险 |
| --- | --- | --- | --- |
| I1 | UI 文案与自己刚修好的契约矛盾（仍称"日志引用要等节点结束才写入"，且该分支对新 run 不可达 → 会误导排障的死文案） | `web/src/components/LogViewer.tsx` | 🔴 前端为争用区 |
| I2 | 孤儿判定未经数据门控（只要 `claudeProcCount > 0` 就报"可能有孤儿残留"，未结合"当前是否有运行中节点" → 正常运行的 run 就会误报） | `web/src/App.tsx` | 🔴 前端为争用区 |
| I3 | 前端判定逻辑零自动化测试，且不在仓库级闸门内（根 `tsconfig.json` 的 include 只覆盖 `src/**`/`spikes/**`/`tests/**`，`npm run typecheck` 不覆盖 `web/**`） | `web/src/liveness.ts`、`logparse.ts`、`aggregate.ts` | 🟠 需先决定是否引入前端测试框架（涉及新依赖） |
| I5 | `canFallback=true` 的异常路径缺断言（现有 spawn-error / timeout 用例的 `req` 不带 `outputSchema`，实际走 `canFallback=false` 分支，故 `events[0] === started` 未覆盖生产配置） | `src/runner/*.test.ts` | 🟢 相对空闲 |

---

## 10. 执行结果（2026-09-19，提交 `2ca46ef`）

### 10.1 §5 判定：**harness 不会应用 default**（I4 不是活 bug）

**依据强度高于真实调用**：反编译本机 `claude 2.1.38`，`--json-schema` 的 `StructuredOutput` 工具使用
`new Ajv({ allErrors: true })` 校验（`vWR` → `$.jsonSchema`），**未启用 `useDefaults`**（Ajv 默认为 `false`）
→ 缺失字段走「报错重试」，而非被兜成 `ok`。

- **零真实调用**（比单次 n=1 样本更确定，但结论**绑定 2.1.38**，已写入代码注释）
- 含义：本单第 2 节担心的静默路径**当时并未被触发**。但第 4 节的修法**依然正确且应当保留**——它消除「必填与默认值并存」的语义含混，并防住未来 CLI 版本启用 `useDefaults`

### 10.2 修法已落地

`jsonSchemaForArtifact` 在输出前剥离 `status` 的 `default`；解析侧 `.default('ok')` 与 `parseArtifactPayload` 行为不变。
4 个 artifact 类型逐一断言：`required` 均含 `status`、`properties.status` 均无 `default`、`additionalProperties:false` 保留。

### 10.3 双向变异验证（均已变红后还原）

| 方向 | 结果 |
| --- | --- |
| A：把 `default` 加回签发路径 | `artifacts.test.ts` 的签发侧断言**精确变红** |
| B：删掉解析侧 `.default('ok')` | 归档兼容用例**变红** |

### 10.4 ⚠️ 本单 §6.2 的措辞已更正（判断结论不变，机制描述有误）

原文称「3 份归档 fixture 的解析测试」依赖解析侧 default。**实际机制不同**：
- fixture **文件**只经 `parseStreamLine`，**不经过** `parseArtifactPayload`
- 真正依赖解析侧 default 的是 `artifacts.test.ts` 里的**内联用例**与 kernel 用例

因此「**不能删解析侧 `.default('ok')`**」这一结论**仍然成立**，但理由是"存在依赖该 default 的解析用例"，而非"fixture 文件本身依赖它"。

### 10.5 遗留

- `tests/fixtures/**` 4 个 blob SHA **逐字未变**（已取证）
- 全量：`tsc --noEmit` exit 0；`vitest run` **308 passed / 3 failed**，3 条失败**全部**在他人并发的 `tests/website/website.test.ts`（站点落 `src/website/` 而非 `website/`），与本改动无关
- **本次改动尚未过独立评审**（项目标准要求引擎契约类改动过第三方评审）。改动小且双向变异已验证，但 §10.1 的"反编译结论"属强主张，建议复审时优先核实该主张的可靠性与其版本绑定风险