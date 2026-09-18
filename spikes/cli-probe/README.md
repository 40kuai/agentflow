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

- **实测**：本环境真实 CLI 进程的原始 stdout / stderr / 退出码
  （**含为规避挂起而单独发起的对照调用，非探针进程**；`probe-claude.ts` 因 `--json-schema` 从未退出、零输出）；
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

> ⚠️ **本次运行的 prompt 实际为 `hi`，未触发工具调用；简报要求的「先读 package.json 再读 tsconfig.json」prompt 从未跑通。**
> 所以下面的证据只代表**无工具调用**的路径：`assistant.message.model` 为 `<synthetic>`（CLI 自己合成，非模型输出），
> 全程**没有 `tool_use` 事件、没有工具结果**。简报第 3 问的前提「在有工具调用（Read/Grep）的场景下」**从头到尾未被触及**。

```
exit code = 1
stdout 行数 = 5
stderr 字节数 = 0        ← 注意：stream-json 模式下 stderr 为空，事件全部走 stdout
事件类型计数：3 × "type":"system"，1 × "type":"assistant"，1 × "type":"result"
（另有嵌套的 "type":"message" / "type":"text" 各 1 次，属于 assistant.message 内部结构，不是顶层事件）
```

5 行的真实内容（**完整原始 JSONL 原文**，非截断；**实测**）——
「5 行 / `duration_ms:23` / stderr 0 字节 / `session_id` 在两处一致」这几个数值型结论的可复核原文就在这里：

> 归档约定（只做复核所必需的掩码，其余逐字保留）：
> - 易变 id（`hook_id` / `uuid` / `message.id` / 错误报文里的 `request id`）→ `<…>`；
> - `hook_response` 的 `stdout` 与 `output` 逐字相同 → 记为 `"<与 output 逐字相同>"`；
> - `init` 的 `slash_commands` / `agents` / `skills` / `output_style` 与工具调用无关 → `<…>`；
> - `session_id` 保留原值（第 5 问的证据）。

```jsonl
{"type":"system","subtype":"hook_started","hook_id":"<hook_id>","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"<uuid>","session_id":"f4b5dc4d-cff3-4a35-a333-1f5984088326"}
{"type":"system","subtype":"hook_response","hook_id":"<hook_id>","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"[codebase-memory] Session context: no indexed graph project matched this working directory. Run index_repository before structural exploration. Once indexed, Active tier: Tier 2 verification. Router: scout=Tier 1 quick, verify=Tier 2 verification, auditor=Tier 3 full graph verification. Coverage invariant for every tier: call check_index_coverage for every file relied on; if incomplete, read the reported missed lines directly and qualify conclusions. Use search_graph, trace_path, and get_code_snippet first; use grep for literals, configs, non-code files, and verification.\"}}","stdout":"<与 output 逐字相同>","stderr":"","exit_code":0,"outcome":"success","uuid":"<uuid>","session_id":"f4b5dc4d-cff3-4a35-a333-1f5984088326"}
{"type":"system","subtype":"init","cwd":"/Users/40kuai/Documents/多agent开发流程","session_id":"f4b5dc4d-cff3-4a35-a333-1f5984088326","tools":["Glob","Grep","Read","mcp__codebase-memory-mcp__index_repository","mcp__codebase-memory-mcp__search_graph","mcp__codebase-memory-mcp__query_graph","mcp__codebase-memory-mcp__trace_path","mcp__codebase-memory-mcp__get_code_snippet","mcp__codebase-memory-mcp__get_graph_schema","mcp__codebase-memory-mcp__get_architecture","mcp__codebase-memory-mcp__search_code","mcp__codebase-memory-mcp__list_projects","mcp__codebase-memory-mcp__delete_project","mcp__codebase-memory-mcp__index_status","mcp__codebase-memory-mcp__check_index_coverage","mcp__codebase-memory-mcp__detect_changes","mcp__codebase-memory-mcp__manage_adr","mcp__codebase-memory-mcp__ingest_traces"],"mcp_servers":[{"name":"codebase-memory-mcp","status":"connected"}],"model":"deepseek-v4-pro-ga-260813","permissionMode":"default","slash_commands":["<…>"],"apiKeySource":"none","claude_code_version":"2.1.38","output_style":"<…>","agents":["<…>"],"skills":["<…>"],"plugins":[],"uuid":"<uuid>","fast_mode_state":"off"}
{"type":"assistant","message":{"id":"<message_id>","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":null,"iterations":null},"content":[{"type":"text","text":"Failed to authenticate. API Error: 403 {\"error\":{\"type\":\"new_api_error\",\"message\":\"用户额度不足, 剩余额度: ＄-0.044144 (request id: <request_id>)\"},\"type\":\"error\"}"}],"context_management":null},"parent_tool_use_id":null,"session_id":"f4b5dc4d-cff3-4a35-a333-1f5984088326","uuid":"<uuid>","error":"authentication_failed"}
{"type":"result","subtype":"success","is_error":true,"duration_ms":23,"duration_api_ms":0,"num_turns":1,"result":"Failed to authenticate. API Error: 403 {\"error\":{\"type\":\"new_api_error\",\"message\":\"用户额度不足, 剩余额度: ＄-0.044144 (request id: <request_id>)\"},\"type\":\"error\"}","stop_reason":"stop_sequence","session_id":"f4b5dc4d-cff3-4a35-a333-1f5984088326","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[]},"modelUsage":{},"permission_denials":[],"uuid":"<uuid>"}
```

（这是完整 5 行，**没有省略任何事件**。再强调一次：这次运行的 prompt 为 `hi`，**未触发工具调用**；
简报的读文件 prompt 从未跑通，所以以上 5 行里没有任何 `tool_use` 事件。）

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

⚠️ **上面这两行只是本文件的转述、无法在仓库内复核**：探针进程被人工终止，而 `probe-claude.ts` 只在 `close`
事件写盘（见脚本 `:20-25`），所以这段 stdout **从未落盘**。`out/` 目录为空（且已被 `.gitignore` 忽略）。
要复核只能按文末「复现方式」重跑（会再次挂起，需手动终止）。

**可复核的原始证据（挂起运行的 debug 日志）**：该次挂起在同机留下了 Claude Code 的 session debug 日志
`~/.claude/debug/09af1339-eb2a-464c-91a5-7a4f8a3cf448.txt`（**34.4 MB / 247,635 行**）。
它是本机**唯一**出现万级重试的 session 日志，量级与时间窗都与挂起探针对应
（⚠️ debug 日志不记录 prompt / argv，因此这一对应关系是**推断**，不是逐字确认）。摘录如下：

```
2026-09-18T08:52:34.329Z [DEBUG] [init] configureGlobalMTLS starting          ← 日志首行
...
2026-09-18T09:09:06.773Z [DEBUG] attribution header x-anthropic-billing-header: cc_version=2.1.38.bb0; ...   ← 日志末行
```

重试计数的**可复核命令与输出**：

```bash
grep -c '\[ERROR\] API error (attempt 1/11)' \
  ~/.claude/debug/09af1339-eb2a-464c-91a5-7a4f8a3cf448.txt
# → 16403

grep -oE 'attempt [0-9]+/[0-9]+' \
  ~/.claude/debug/09af1339-eb2a-464c-91a5-7a4f8a3cf448.txt | sort -u
# → attempt 1/11        ← 计数始终停在 1/11，重试循环不收敛
```

首条与末条错误的原文（`request id` 已掩码）：

```
2026-09-18T08:52:35.128Z [ERROR] API error (attempt 1/11): Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted
2026-09-18T09:09:06.735Z [ERROR] API error (attempt 1/11): 403 403 {"error":{"type":"new_api_error","message":"用户额度不足, 剩余额度: ＄-0.044144 (request id: <request_id>)"},"type":"error"}
```

> **计数更正**：前一版本文件写的是「14,044 次」。本次复核该日志（进程已终止、文件已冻结）实测为 **16,403 次**
> （其中 16,402 次是 403 额度错误，1 次是最开始的 auth 方法缺失错误）。
> 14,044 应是运行中途的中间计数，**以可复核命令算出的 16,403 为准**。

日志时间跨度 08:52:34 → 09:09:06（UTC，约 16 分钟），进程被终止前仍以 45%~50% CPU 空转。

对照实验（真实 A/B，**实测**）：

| 参数组合 | 结果 |
| --- | --- |
| `-p hi --output-format stream-json --verbose` | 5 行事件，exit=1，**秒退** |
| 上者 + `--include-partial-messages` | 5 行事件，exit=1，**秒退** |
| 上者 + `--tools=Read,Grep,Glob` | 5 行事件，exit=1，**秒退** |
| 上者 + `--json-schema {...}` | **无限循环，不退出** |

**A/B 两侧的 stderr 原始证据（如实标注）**：

- **A 侧（不含 `--json-schema`，秒退）**：stderr = **0 字节**。三次分流重定向留下的
  `claude-full.err` / `claude-t5.err` / `claude-t2.err` 文件大小**都是 0**（stdout 侧分别是
  `claude-full.jsonl` / `claude-t5.jsonl` / `claude-t2.jsonl`，各 5 行）。这就是
  「stream-json 模式下 stderr 为空、事件全走 stdout」这句结论的唯一依据，可在 `/tmp` 里复核。
- **B 侧（含 `--json-schema`，挂起）**：stderr **没有单独落盘**（进程被人工终止，探针只在 `close` 写盘），
  因此没有「B 侧 stderr 头尾若干行」可贴；唯一可复核的 B 侧原始产物就是上面那份 session debug 日志。

**静态验证**印证了机制：`--json-schema` 是通过一个名为 `StructuredOutput` 的内部工具实现的
（二进制字符串 `g2="StructuredOutput"`，注册逻辑 `if(Rx_({isNonInteractiveSession:BT})&&$.jsonSchema)JA=qA($.jsonSchema); if(JA){let zA=vWR(JA); if(zA)jR=[...jR,zA]...}`），
模型不调用它时 CLI 会通过 Stop hook 反复注入 `You MUST call the StructuredOutput tool`；
对应的失败终态 subtype 是 `error_max_structured_output_retries`。

**结论**：在本环境（请求必然失败）下，`--json-schema` 让 CLI 卡在无尽的 stop-hook 重试里；
「有工具调用时 schema 是否可靠」这一问，**没有拿到任何正面证据，也未能验证**。
按简报要求，我没有为了让探针「成功」而去掉工具调用或改写参数。

### 4. usage / token 信息：出现在哪条事件、字段路径是什么？是否边跑边给？

**实测**字段路径（出现在 `result` 事件内）。
⚠️ **来源限定**：本次 `usage` 的最初证据来自**文首**那次 `claude -p "hi" --output-format json`
（**json 模式**），**不是** stream-json 模式——json 模式打印的对象就是同一个 `type:"result"` 事件对象，
所以「路径一致」原本属于跨调用模式的推断。**现在这个推断已被补上的原始证据直接证实**：
第 1 问归档的 5 行 stream-json 原文里，第 5 行 `type:"result"` 事件就**逐字包含同一个 `usage` 对象**，
可在本文件内直接复核。字段路径清单：

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

**是否边跑边给：未能验证。** 本次只拿到**一条携带 usage 的事件**（最终 `result`），没有拿到中间的增量 usage 事件。
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

**是：实测被接受且确实生效。**

- 该写法没有触发任何参数解析错误——同一套参数下的进程正常启动、正常退出（exit=1，认证失败）；
- **生效证据**（`system/init` 事件的 `tools` 字段原文，**实测**）：

```
"tools":["Glob","Grep","Read","mcp__codebase-memory-mcp__index_repository","mcp__codebase-memory-mcp__search_graph","mcp__codebase-memory-mcp__query_graph","mcp__codebase-memory-mcp__trace_path","mcp__codebase-memory-mcp__get_code_snippet","mcp__codebase-memory-mcp__get_graph_schema","mcp__codebase-memory-mcp__get_architecture","mcp__codebase-memory-mcp__search_code","mcp__codebase-memory-mcp__list_projects","mcp__codebase-memory-mcp__delete_project","mcp__codebase-memory-mcp__index_status","mcp__codebase-memory-mcp__check_index_coverage","mcp__codebase-memory-mcp__detect_changes","mcp__codebase-memory-mcp__manage_adr","mcp__codebase-memory-mcp__ingest_traces"]
```

对照组：不带 `--tools` 时同一字段为
`"tools":["Task","TaskOutput","Bash","Glob","Grep","ExitPlanMode","Read",...]`（完整内置工具集）。

**额外说明（影响 Task 10）**：

1. `--tools` **只约束内置工具，不约束 MCP 工具**（**实测**）：上表里 `mcp__codebase-memory-mcp__*` 全部保留。
   想要「只读且只有 Read/Grep/Glob」，还得配合 `--disallowed-tools` 或 `--strict-mcp-config`（后者未实测）。
2. **「CLI 是否校验工具名」未能验证**：`--tools=BogusTool`（不存在的工具名）会不会报错，
   本次**没有任何实测证据**——既没保存这条命令的输出，文末「复现方式」里也没有它
   （前一版本文件曾把它写成「也**不报错**」的发现，属于无证据断言，现更正为未验证）。
   **不要**据此认为写错工具名会「静默少一个工具、不会失败」；额度恢复后需补跑一次
   `claude -p "hi" --output-format json --tools=BogusTool` 并保存输出，才能定论。

## codex

### 7. `codex exec` 的 stdout 是否包含可机器解析的结构化结果？

**未能验证**：codex 的请求始终没有返回。**实测**事实：

- 简报给的探针 `codex exec -s read-only -C <dir> "<prompt>"` 运行 **9 分 30 秒以上**，两个相关进程
  都是 0% CPU（在等 `POST /responses`），没有任何模型输出，最终被人工终止；
- 一次 30 秒的受控复现（stdout / stderr 分离重定向，**实测**）：

```
stdout = 0 字节        （文件 /tmp/codex-out.txt）
stderr = 61602 字节    （82 行，文件 /tmp/codex-err.txt）
```

**`stderr` 头尾原文**（长 otel 前缀用 `…` 缩略，`request id` 已掩码）：

```
Reading additional input from stdin...
2026-09-18T09:09:35.682172Z  WARN codex_core_plugins::remote::remote_installed_plugin_sync: remote installed plugin bundle sync failed error=chatgpt authentication required for remote plugin catalog; api key auth is not supported
2026-09-18T09:09:35.739095Z  INFO …: codex_otel.log_only: event.name="codex.conversation_starts" provider_name=NewAPI … model=deepseek-v4-flash-ga-260731 slug=deepseek-v4-flash-ga-260731
…
2026-09-18T09:09:43.572913Z  INFO session_loop{thread_id=01a0b3c7-…}:…: codex_core::session::turn: Turn error: unexpected status 403 Forbidden: 用户额度不足, 剩余额度: ＄-0.044144 (request id: <request_id>), url: https://aiproxy.nanshe-arch.com/v1/responses
ERROR: unexpected status 403 Forbidden: 用户额度不足, 剩余额度: ＄-0.044144 (request id: <request_id>), url: https://aiproxy.nanshe-arch.com/v1/responses
ERROR: unexpected status 403 Forbidden: 用户额度不足, 剩余额度: ＄-0.044144 (request id: <request_id>), url: https://aiproxy.nanshe-arch.com/v1/responses
2026-09-18T09:09:43.588980Z  INFO session_loop{thread_id=01a0b3c7-…}:…: codex_core::session::handlers: Shutting down Codex instance
```

补充实测细节：这次 30 秒窗口的复现其实在 **~8 秒**就以 403 结束（日志时间跨度 09:09:35 → 09:09:43），
`61602` 字节全是 banner / 信息块 / tracing 日志。所以 stdout 为空**不是因为还在等**，
而是**codex 的机器可读信息本来就不走 stdout**（至少在无模型响应时如此）。

即：**在拿到模型响应之前，`codex exec` 的 stdout 是空的，所有内容（`OpenAI Codex v0.147.0` banner、
`workdir:` / `model:` / `sandbox:` 等信息块、以及大量 tracing 日志）全部走 stderr。**
「最终答案走 stdout 还是 stderr」未能验证，因为从未拿到答案。

对 Task 10 的直接影响：codex runner **必须同时捕获两个流**，不能假设 stdout 就是结果；
且必须自带超时（本环境下它不返回也不退出）。

### 8. 若需要提取 JSON，可用的策略是什么？

**未能实测**（没有拿到任何模型响应，无法验证提取策略）。**实测**可用的环境事实只有：
`codex exec` 的输出里 banner/信息块/日志混在 stderr，stdout 本次观测为长期为空（30 秒窗口）。

因此只给一条有事实依据的**待验证**建议：不要对 stdout 做「整体 `JSON.parse`」，
应对**两个流分别捕获**、再在拼接文本里做「取最外层 `{...}` 块 + `JSON.parse` + 失败则放宽」的宽松提取，
并且整个调用必须有超时。这一条属于建议，**不是结论**。

## 对 Task 10 的结论（必须明确写出）

- **解析入口事件类型**：`"result"`（**实测**）。
  解析器应逐行 `JSON.parse`，只认顶层 `type === "result"` 的那一行作为终态；
  其余 `"system"`（`subtype` 有 `hook_started` / `hook_response` / `init`）与 `"assistant"` 行按日志处理（**实测**）。
- **结构化结果的字段路径**：`result.structured_output`（**静态验证**，二进制 schema 原文
  `structured_output:b.unknown().optional()`；成功变体才有该字段，失败变体没有）。
  （⚠️ 读这条时**必须先看本段落末尾的 gate**：采用下面推荐的参数数组时，该字段**永远不会出现**。）
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

- 🚧 **gate（Task 10 采用上面这组参数时的硬约束，必须照办）**：
  上面推荐的参数数组**已经去掉了 `--json-schema`**，因此在它下面
  **`result.structured_output` 永远不会存在**（第 2 问已自述该字段 `.optional()`，未给 schema 时不存在）。
  也就是说，本段落里「结构化结果的字段路径 = `result.structured_output`」与「采用上面这组参数」
  **不能同时成立**：
  - 照抄上面参数数组 → 拿不到结构化结果；
  - 要拿结构化结果 → 必须加 `--json-schema` → 本环境下进程**永不退出**（警告一）。

  因此：
  1. **采用上述参数数组时，不要解析 `result.structured_output`**（它不会出现；解析它会永远拿不到东西）；
  2. **结构化输出的获取路径整体属于「未验证」**。Task 10 必须在 claude 额度恢复后
     **补跑一次带 `--json-schema` 的真实调用、并给子进程加超时 + `kill`**，
     才有证据决定要不要把 `structured_output` 纳入解析路径；在此之前不要把结构化输出当作可用能力。

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
2. **`subtype:"success"` 变体还有样本里没有的顶层字段**（本次该变体是认证失败、模型未运行）；
   `duration_ms`、`duration_api_ms`、`num_turns`、`stop_reason`、
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

# 【待补跑·未验证】CLI 是否校验工具名（额度恢复后再跑，并保存输出）
claude -p "hi" --output-format json --tools=BogusTool

# 验证可正常退出的参数集（本文件「对 Task 10 的结论」里那组）
claude -p "hi" --output-format stream-json --include-partial-messages --verbose \
  --max-budget-usd 0.50 --tools=Read,Grep,Glob

# 原始探针脚本（本环境跑不通，仅作留档）
npx tsx spikes/cli-probe/probe-claude.ts
npx tsx spikes/cli-probe/probe-codex.ts
npx tsx spikes/cli-probe/analyze.ts
```

## 原始证据索引（本文件引用的数值都可在此复核）

| 事实 | 数值 | 可复核来源 |
| --- | --- | --- |
| 认证失败路径的完整 5 行事件 | 5 行 / `duration_ms:23` / stderr 0 字节 | 第 1 问归档的 JSONL 原文（本文件内）；原始文件 `/tmp/claude-full.jsonl`、`claude-t5.jsonl`、`claude-t2.jsonl` |
| `--tools` 生效的对照组 | `init.tools` 有/无 `--tools` 的差异 | 第 6 问的 `tools` 原文；对照组原始文件 `/tmp/claude-t2.jsonl` |
| 挂起重试次数 | 16,403 次，计数恒为 `attempt 1/11` | `grep -c '\[ERROR\] API error (attempt 1/11)' ~/.claude/debug/09af1339-eb2a-464c-91a5-7a4f8a3cf448.txt` |
| codex 两路输出分流 | stdout 0 字节 / stderr 61602 字节（82 行） | `/tmp/codex-out.txt`、`/tmp/codex-err.txt` |

⚠️ **注意**：`probe-claude.ts` / `probe-codex.ts` 只在子进程 `close` 事件写盘（见脚本 `:20-25`），
进程被 `kill` 就**零产物**——这正是 `out/` 为空、本文件不得不外挂原始片段的原因。
Task 10 的子进程管理不能复制这个写法，必须**边收边落盘**或先设超时。

⚠️ **不要为了复核而重跑探针**：本机 claude 额度已耗尽（剩余额度为负），重跑只会得到 403 认证失败输出、
拿不到成功路径，且会白白消耗额度。上表中除「待补跑」标注的命令外，其余都可用**已冻结的文件**复核。