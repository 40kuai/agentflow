# CLI 行为探针结论（Phase 0）

探针日期：2026-09-18
claude 版本：`2.1.38 (Claude Code)`
codex 版本：`codex-cli 0.147.0`

## 先读这段：本次探针没有按预期跑完

`claude` 与 `codex` 在本环境中**都无法真正调用到模型**（第三方 Anthropic 兼容代理返回额度不足），
因此：

- `spikes/cli-probe/probe-claude.ts` 从未退出（原因见第 3 问：`--json-schema` 在认证失败路径下无限循环）；
- `spikes/cli-probe/probe-codex.ts` 挂在 API 请求上 9 分 30 秒以上，从未返回；
- 三份产物 `out/claude-stream.jsonl`、`out/codex.txt`、`out/meta.json` **均未生成**（没有伪造产物）；
- `out/` 目录为空，`analyze.ts` 运行后会打印「未找到输出文件」。

下面的每一条结论都来自**真实进程输出**，逐条标注来源，并且区分三种可信度：

- **实测**：本次探针进程的原始 stdout / stderr / 退出码；
- **静态验证**：直接搜索本机已安装的 `claude` 2.1.38 二进制（`/opt/homebrew/Caskroom/claude-code/2.1.38/claude`）
  里内嵌的源码字符串。这不是猜测，但也不是运行时实测；
- **未能验证**：被额度问题阻断，明确标注，不做推测。

## 环境层面的阻塞事实（原始报错）

`claude -p "hi" --output-format json` 的真实输出（**实测**，exit code = 1）：

```json
{"type":"result","subtype":"success","is_error":true,"duration_ms":122,"duration_api_ms":0,"num_turns":1,"result":"Failed to authenticate. API Error: 403 {\"error\":{\"type\":\"new_api_error\",\"message\":\"用户额度不足, 剩余额度: ＄-0.044144 (request id: 202609180901105858298108268d9d6SldxU83N)\"},\"type\":\"error\"}","stop_reason":"stop_sequence","session_id":"b2b955de-e094-4728-9152-7ab49c2c8356","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[]},"modelUsage":{},"permission_denials":[],"uuid":"840af614-c040-4a51-a672-2968a5aba3a0"}
```

同一条错误在 08:59、09:01、09:04、09:09、09:10（UTC）反复出现，剩余额度始终为 `＄-0.044144`，
**不是偶发失败**。

`~/.claude/settings.json` 通过 `env.ANTHROPIC_BASE_URL` 把 CLI 指向第三方代理，并把所有模型名映射到同一个模型。
**本任务没有修改任何全局配置**（`~/.claude`、`~/.codex`、`~/.npmrc` 均未改动）。

## claude

### 1. `--output-format stream-json` 的事件类型清单

**完整清单：未能验证**（探针未能跑完）。**实测**拿到的是认证失败路径下的真实事件序列，
参数为 `-p <prompt> --output-format stream-json --include-partial-messages --verbose --max-budget-usd 0.50 --tools=Read,Grep,Glob`：

```
exit code = 1
stdout 行数 = 5
stderr 字节数 = 0        ← 注意：stream-json 模式下 stderr 为空，事件全部走 stdout
事件类型计数：3 × "type":"system"，1 × "type":"assistant"，1 × "type":"result"
（另有嵌套的 "type":"message" / "type":"text" 各 1 次，属于 assistant.message 内部结构，不是顶层事件）
```

5 行的真实内容（每行前 200 字符，**实测**）：

```
{"type":"system","subtype":"hook_started","hook_id":"...","hook_name":"SessionStart:startup","hook_event":"SessionStart",...
{"type":"system","subtype":"hook_response","hook_id":"...","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"{\"hookSpecificOutput\":...
{"type":"system","subtype":"init","cwd":"/Users/40kuai/Documents/多agent开发流程","session_id":"f4b5dc4d-cff3-4a35-a333-1f5984088326","tools":["Glob","Grep","Read",...
{"type":"assistant","message":{"id":"...","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence",...
{"type":"result","subtype":"success","is_error":true,"duration_ms":23,...
```

要点：
- 顶层事件类型 = `system` / `assistant` / `result`（**实测**）；
- `system` 事件靠 `subtype` 细分：`hook_started`、`hook_response`、`init`（**实测**）；
- `assistant` 事件里 `message.model` 为 `<synthetic>`，说明这是 CLI 自己合成的消息，不是模型输出（**实测**）。

**静态验证**补充：二进制中存在 `{"type":b.literal("stream_event"),event:...,parent_tool_use_id:...,uuid:...,session_id:...}`，
即 `--include-partial-messages` 对应的顶层事件类型是 `stream_event`；还存在 `user`、`tool_progress`、
`tool_use_summary`、`task_notification`、`status` 等类型。**本次认证失败路径下没有出现 `stream_event`**，
因为根本没有真实的模型流。完整成功路径的清单未能验证。

### 2. 最终结构化结果出现在哪条事件、哪个字段？

**实测**：最终结果是顶层 `type":"result"` 的那一行（每次运行都有且只有一行），
`result` 自身是个**字符串**，不是对象。

**静态验证**：`claude` 2.1.38 二进制里 `type:"result"` 的成功变体 schema 原文：

```
subtype:b.literal("success"),duration_ms:b.number(),duration_api_ms:b.number(),is_error:b.boolean(),
num_turns:b.number(),result:b.string(),stop_reason:b.string().nullable(),total_cost_usd:b.number(),
usage:RQB,modelUsage:b.record(b.string(),eWB),permission_denials:b.array(_QB),
structured_output:b.unknown().optional(),uuid:i2,session_id:b.string()
```

即结构化结果字段路径是 **`result.structured_output`**，且它是 `.optional()`：
`--json-schema` 未给出时该字段**不存在**。失败变体（见第 3 问）里**没有**这个字段。

**运行时从未观测到 `structured_output`**（额度阻断，模型没跑起来），所以字段路径属于静态验证。

### 3. `--json-schema` 在有工具调用的场景下是否返回了符合 schema 的结构？

**未能验证**——而且实测发现它在本环境下是一个**必须规避的陷阱**：

加入 `--json-schema` 后，进程**永不退出**，并疯狂刷以下事件对（两个 15 秒窗口内各刷出 100+ 对）：

```
{"type":"assistant","message":{...,"model":"<synthetic>",...}}          ← 每行形如
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Stop hook feedback:\nYou MUST call the StructuredOutput tool to co...
```

原始探针（`probe-claude.ts`）正是这个参数组合，它的 debug 日志里累计出现
**14,044 次** `[ERROR] API error (attempt 1/11): 403 ... 用户额度不足`，`attempt` 计数**始终停在 1/11**，
即重试循环不收敛。探针进程存活 13 分钟后仍以 45%~50% CPU 空转，被人工终止。

对照实验（真实 A/B，**实测**）：

| 参数组合 | 结果 |
| --- | --- |
| `-p hi --output-format stream-json --verbose` | 5 行事件，exit=1，**秒退** |
| 上者 + `--include-partial-messages` | 5 行事件，exit=1，**秒退** |
| 上者 + `--tools=Read,Grep,Glob` | 5 行事件，exit=1，**秒退** |
| 上者 + `--json-schema {...}` | **无限循环，不退出** |

**静态验证**印证了机制：`--json-schema` 是通过一个名为 `StructuredOutput` 的内部工具实现的
（二进制字符串 `g2="StructuredOutput"`，注册逻辑 `if(Rx_({isNonInteractiveSession:BT})&&$.jsonSchema)JA=qA($.jsonSchema); if(JA){let zA=vWR(JA); if(zA)jR=[...jR,zA]...}`），
模型不调用它时 CLI 会通过 Stop hook 反复注入 `You MUST call the StructuredOutput tool`；
对应的失败终态 subtype 是 `error_max_structured_output_retries`。

**结论**：在本环境（请求必然失败）下，`--json-schema` 让 CLI 卡在无尽的 stop-hook 重试里；
「有工具调用时 schema 是否可靠」这一问，**没有拿到任何正面证据，也未能验证**。
按简报要求，我没有为了让探针「成功」而去掉工具调用或改写参数。

### 4. usage / token 信息：出现在哪条事件、字段路径是什么？是否边跑边给？

**实测**字段路径（出现在 `result` 事件内，完整对象原文见文首 JSON）：

```
usage.input_tokens                       = 0
usage.cache_creation_input_tokens        = 0
usage.cache_read_input_tokens            = 0
usage.output_tokens                      = 0
usage.server_tool_use.web_search_requests
usage.server_tool_use.web_fetch_requests
usage.service_tier                       = "standard"
usage.cache_creation.ephemeral_1h_input_tokens
usage.cache_creation.ephemeral_5m_input_tokens
usage.inference_geo                      = ""
usage.iterations                         = []
total_cost_usd                           = 0        ← 在 result 顶层，不在 usage 里
modelUsage                               = {}       ← 在 result 顶层
```

**是否边跑边给：未能验证。** 本次只拿到最终 `result` 一条事件，没有拿到中间的 usage 事件。
（`--include-partial-messages` 打开后真实模型流会产生 `stream_event`，但本次没有模型流，所以无法证实。）
**静态验证**补充：`result` 事件里另有 `num_turns`、`duration_ms`、`duration_api_ms`、`stop_reason`、
`permission_denials`、`uuid`、`modelUsage` 等字段。

### 5. session id 字段名与位置？是否可用于 `--resume`？

**实测**：字段名就是 `session_id`，出现在两条事件里：

- `{"type":"system","subtype":"init",...,"session_id":"f4b5dc4d-cff3-4a35-a333-1f5984088326",...}`
- `{"type":"result",...,"session_id":"f4b5dc4d-cff3-4a35-a333-1f5984088326",...}`

**同一次运行内 `system/init` 与 `result` 的 `session_id` 完全一致**：对整份 5 行输出做
`grep -oE '"session_id":"[a-f0-9-]+"' | sort -u`，只得到一个值。

**是否可用于 `--resume`：未能验证**（没有额度做第二次调用）。
**静态/文档层面**：`claude --help` 与 `记录.md` 已核实 CLI 支持 `--resume` / `--session-id` / `--fork-session`，
但「拿本次 session_id 去 `--resume` 能否续跑」没有实测证据。

### 6. `--tools=Read,Grep,Glob` 这种写法是否被接受？若不接受，正确写法是什么？

**受：实测被接受且确实生效。**

- 该写法没有触发任何参数解析错误——同一套参数下的进程正常启动、正常退出（exit=1，认证失败）；
- **生效证据**（`system/init` 事件的 `tools` 字段原文，**实测**）：

```
"tools":["Glob","Grep","Read","mcp__codebase-memory-mcp__index_repository","mcp__codebase-memory-mcp__search_graph","mcp__codebase-memory-mcp__query_graph","mcp__codebase-memory-mcp__trace_path","mcp__codebase-memory-mcp__get_code_snippet","mcp__codebase-memory-mcp__get_graph_schema","mcp__codebase-memory-mcp__get_architecture","mcp__codebase-memory-mcp__search_code","mcp__codebase-memory-mcp__list_projects","mcp__codebase-memory-mcp__delete_project","mcp__codebase-memory-mcp__index_status","mcp__codebase-memory-mcp__check_index_coverage","mcp__codebase-memory-mcp__detect_changes","mcp__codebase-memory-mcp__manage_adr","mcp__codebase-memory-mcp__ingest_traces"]
```

对照组：不带 `--tools` 时同一字段为
`"tools":["Task","TaskOutput","Bash","Glob","Grep","ExitPlanMode","Read",...]`（完整内置工具集）。

**两个额外发现（都影响 Task 10）**：

1. `--tools` **只约束内置工具，不约束 MCP 工具**：上表里 `mcp__codebase-memory-mcp__*` 全部保留。
   想要「只读且只有 Read/Grep/Glob」，还得配合 `--disallowed-tools` 或 `--strict-mcp-config`（后者未实测）。
2. `--tools=BogusTool`（不存在的工具名）**也不报错**，同样直接走到 API 调用。即 CLI 不校验工具名，
   写错了表现为「静默少一个工具」，不会失败。

## codex

### 7. `codex exec` 的 stdout 是否包含可机器解析的结构化结果？

**未能验证**：codex 的请求始终没有返回。**实测**事实：

- 简报给的探针 `codex exec -s read-only -C <dir> "<prompt>"` 运行 **9 分 30 秒以上**，两个相关进程
  都是 0% CPU（在等 `POST /responses`），没有任何模型输出，最终被人工终止；
- 一次 30 秒的受控复现（stdout / stderr 分离重定向，**实测**）：

```
stdout = 0 字节
stderr = 61602 字节
```

即：**在拿到模型响应之前，`codex exec` 的 stdout 是空的，所有内容（`OpenAI Codex v0.147.0` banner、
`workdir:` / `model:` / `sandbox:` 等信息块、以及大量 tracing 日志）全部走 stderr。**
「最终答案走 stdout 还是 stderr」未能验证，因为从未拿到答案。

对 Task 10 的直接影响：codex runner **必须同时捕获两个流**，不能假设 stdout 就是结果；
且必须自带超时（本环境下它不返回也不退出）。

### 8. 若需要提取 JSON，可用的策略是什么？

**未能实测**（没有拿到任何模型响应，无法验证提取策略）。**实测**可用的环境事实只有：
`codex exec` 的输出里 banner/信息块/日志混在 stderr，stdout 可能长期为空。

因此只给一条有事实依据的**待验证**建议：不要对 stdout 做「整体 `JSON.parse`」，
应对**两个流分别捕获**、再在拼接文本里做「取最外层 `{...}` 块 + `JSON.parse` + 失败则放宽」的宽松提取，
并且整个调用必须有超时。这一条属于建议，**不是结论**。

## 对 Task 10 的结论（必须明确写出）

- **解析入口事件类型**：`"result"`（**实测**）。
  解析器应逐行 `JSON.parse`，只认顶层 `type === "result"` 的那一行作为终态；
  其余 `"system"`（`subtype` 有 `hook_started` / `hook_response` / `init`）与 `"assistant"` 行按日志处理（**实测**）。
- **结构化结果的字段路径**：`result.structured_output`（**静态验证**，二进制 schema 原文
  `structured_output:b.unknown().optional()`；成功变体才有该字段，失败变体没有）。
  ⚠️ **运行时未能观测到该字段**：额度阻断，模型没跑起来。
  ⚠️ 但 `result` 顶层字段（`subtype`/`is_error`/`result`/`usage`/`total_cost_usd`/`session_id`/`num_turns`/
  `duration_ms`/`stop_reason`/`permission_denials`/`uuid`/`modelUsage`）**全部实测存在**。
- **usage 字段路径**：`usage.input_tokens` / `usage.output_tokens`（**实测**）；
  成本字段是 `result.total_cost_usd`（**实测**，注意它不在 `usage` 内）。
  另有实测存在的 `usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens` /
  `usage.service_tier` / `usage.server_tool_use.*` / `usage.cache_creation.*` / `usage.inference_geo` / `usage.iterations`。
- **最终采用的 claude 调用参数数组**（⚠️ **不是**简报原来那组，见下方警告）：

  ```ts
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--max-budget-usd', '0.50',
    '--tools=Read,Grep,Glob',
  ];
  ```

  **实测**：该数组（相对简报版本**去掉了 `--json-schema`**）在 23ms 内完成启动与退出，
  产出 5 行 stream-json（3×`system` / 1×`assistant` / 1×`result`），stderr 0 字节，exit code = 1（认证失败）。
  其中 `--tools=Read,Grep,Glob`、`--include-partial-messages`、`--output-format stream-json --verbose`
  都单独实测过可正常启动与退出。

  ⚠️ **警告一**：原简报数组里的 `--json-schema` 在本环境下会让进程**永不退出**（见第 3 问）。
  Task 10 若仍要 `--json-schema`，**必须**给子进程加超时 + `kill`，并且不能只读 `result.structured_output`
  一条路径。
  ⚠️ **警告二**：`--tools` 不约束 MCP 工具（第 6 问），「只允许 Read/Grep/Glob」的目标并未真正达成。
  ⚠️ **警告三**：`--output-format stream-json` 在 `-p` 模式下**必须**同时给 `--verbose`，否则直接报错
  （原样报错：`Error: When using --print, --output-format=stream-json requires --verbose`，**实测**）。

## 与简报 Task 10 测试样本（`SAMPLE_RESULT`）的差异

`SAMPLE_RESULT` 的关键字段**全部在真实输出中被证实存在**：`type:'result'`、`subtype`、`session_id`、
`result`（字符串）、`usage.input_tokens`、`usage.output_tokens`、`total_cost_usd`、`is_error`。
但有 **5 处需要 Task 10 注意的差异/补充**：

1. **`subtype:'success'` 可以和 `is_error:true` 同时出现**（**实测**：认证失败的输出正是
   `"subtype":"success","is_error":true`）。→ Task 10 必须用 `is_error` 判定失败，**不能**用 `subtype` 判定失败。
   这也解释了为什么 `SAMPLE_RESULT` 第 4 个用例（`subtype:'error_max_turns'` + `is_error:true`）是合法形状：
   `subtype` 的错误枚举确实存在，且为
   `["error_during_execution","error_max_turns","error_max_budget_usd","error_max_structured_output_retries"]`
   （**静态验证**）。
2. **真实成功变体还有样本里没有的顶层字段**：`duration_ms`、`duration_api_ms`、`num_turns`、`stop_reason`、
   `modelUsage`、`permission_denials`、`uuid`（**实测**）。→ 解析器不要用「字段白名单 + 校验失败即报错」的写法。
3. **`usage` 对象比样本丰富得多**（见第 4 问），且 `usage` 内还嵌了 `server_tool_use`、`cache_creation` 等对象。
4. **`subtype:'success'` + 无 `structured_output`** 是正常情况（该字段 `.optional()`，**静态验证**）。
5. **`result.is_error` 为真时退出码为 1**（**实测**两次：认证失败都是 exit=1）。
   反向情形（`is_error:false` → 退出码 0）**未实测**，仅有**静态验证**支持：
   `_7(U?.type==="result"&&U?.is_error?1:0)`。

## 复现方式

```bash
# 验证 claude 凭据（几秒返回，会打印 403 原始报文）
claude -p "hi" --output-format json

# 验证 --json-schema 的无限循环（会一直不退出，需手动终止）
claude -p "hi" --output-format stream-json --verbose --include-partial-messages \
  --json-schema '{"type":"object","properties":{"a":{"type":"string"}},"required":["a"],"additionalProperties":false}'

# 验证可正常退出的参数集（本文件「对 Task 10 的结论」里那组）
claude -p "hi" --output-format stream-json --include-partial-messages --verbose \
  --max-budget-usd 0.50 --tools=Read,Grep,Glob

# 原始探针脚本（本环境跑不通，仅作留档）
npx tsx spikes/cli-probe/probe-claude.ts
npx tsx spikes/cli-probe/probe-codex.ts
npx tsx spikes/cli-probe/analyze.ts
```