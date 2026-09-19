# AgentFlow Phase 0 + Phase 1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跑通"一个需求文本输入 → PM / 后端开发 / 测试 三个角色自动串行流转完成"，且整个过程可从事件库重放出来，并能在页面上看到状态流转。

**Architecture:** 事件驱动编排内核。所有状态变更是 append-only 事件；任务当前状态由事件重放投影得出。角色之间零自由对话，只通过结构化 Artifact 交接。执行层把角色翻译成 `claude -p` 的 headless 调用，通过引擎无关的归一化 `RunnerEvent` 流把产出交回内核。

**Tech Stack:** Node 22 + TypeScript（ESM）、Fastify、better-sqlite3、zod、yaml、vitest、React 18 + Vite（极简观测页）

**Spec:** `docs/superpowers/specs/2026-09-18-multi-agent-dev-orchestration-design.md`

## Global Constraints

- Node 版本下限：**22**（`package.json` 的 `engines.node` 必须为 `>=22`）
- 依赖安装一律走国内镜像：在每条 `npm` 命令后追加 `--registry=https://registry.npmmirror.com`；**禁止修改全局 npm 配置**，禁止全局安装任何包
- **绝对禁止修改系统基础环境**：不动系统 Python（3.9.6）、不卸载任何已安装的包、不改 `~/.npmrc` 之外的全局配置
- 禁止硬编码绝对路径、API Key、密码。所有可变配置走 `.env`（模板为 `.env.example`），代码内只通过 `src/config/env.ts` 读取
- HTTP / WebSocket **只绑定 `127.0.0.1`**
- 原始运行日志写入 `logs/runs/<run_id>.jsonl`，**不得写入事件库**；事件库只存 `log_ref` 引用
- 代码注释用中文
- 提交信息用中文，格式 `类型: 说明`（如 `feat: 新增事件存储`）
- 本阶段实现的 Artifact 类型**只有 4 种**：`requirement` / `work_package_plan` / `code_diff` / `test_report`。其余类型在后续阶段补充
- 本阶段是**单引擎（claude-code）、串行**流程。并行、codex、卡点 G1–G3 均不属于本计划范围
- **Artifact status 规则（本阶段）**：CLI 退出码为 0 且载荷通过 zod 校验 → 内核写入 `status: 'ok'`；否则节点失败。也就是说 **Phase 1 中 status 恒为 `ok`**，工作流边条件里的 `artifacts.*.status == 'ok'` 实际起的是"确认产物存在且合法"的作用。从载荷内容派生出 `needs_changes` / `blocked` 需要 LLM 判断，留到引入 LLM 决策器的阶段再做
- **本阶段所有工作流节点的 `isolate` 一律为 `false`**：Phase 1 没有合并能力，若在 worktree 里写代码，worktree 回收后代码即丢失，后续节点看不到改动，闭环就断了。worktree 隔离必须与合并能力一起引入，属于 Phase 2

## 目录与文件结构

```
多agent开发流程/
├── .env.example
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── config/
│   ├── workflows/simple_dev.yaml
│   ├── roles/{pm,backend_dev,qa_engineer}.yaml
│   └── prompts/{pm,backend_dev,qa_engineer}.md
├── spikes/cli-probe/            # Task 2 探针（一次性，不入正式代码路径）
├── src/
│   ├── shared/                  # 领域类型与 schema（Task 3）
│   │   ├── ids.ts
│   │   ├── domain.ts
│   │   ├── artifacts.ts
│   │   └── events.ts
│   ├── config/
│   │   ├── env.ts               # Task 1
│   │   ├── schema.ts            # Task 11
│   │   └── loader.ts            # Task 11
│   ├── kernel/
│   │   ├── event-store.ts       # Task 4
│   │   ├── projector.ts         # Task 5
│   │   ├── facts.ts             # Task 6
│   │   ├── expression.ts        # Task 6
│   │   ├── state-machine.ts     # Task 7
│   │   ├── context-assembler.ts # Task 9
│   │   ├── scheduler.ts         # Task 12
│   │   └── kernel.ts            # Task 12
│   ├── runner/
│   │   ├── types.ts             # Task 8
│   │   ├── fake-runner.ts       # Task 8
│   │   └── claude-code-runner.ts# Task 10
│   ├── server/server.ts         # Task 13
│   └── main.ts                  # Task 13
├── web/                         # Task 14（独立 package.json）
└── tests/e2e/                   # Task 15
```

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `src/config/env.ts`
- Create: `src/config/env.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `loadEnv(): AppEnv`，其中
  `AppEnv = { dbPath: string; logDir: string; workspaceDir: string; configDir: string; host: string; port: number; maxPromptTokens: number; globalConcurrency: number; claudeBin: string; codexBin: string }`

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "agentflow",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/websocket": "^11.0.0",
    "better-sqlite3": "^11.0.0",
    "fastify": "^5.0.0",
    "pino": "^9.0.0",
    "yaml": "^2.5.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "pino-pretty": "^11.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: 创建 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "spikes/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: 创建 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: 创建 `.env.example`**

```
# AgentFlow 配置模板。复制为 .env 后按需修改，.env 不提交。
AGENTFLOW_DB_PATH=./data/agentflow.sqlite
AGENTFLOW_LOG_DIR=./logs
AGENTFLOW_WORKSPACE_DIR=./workspaces
AGENTFLOW_CONFIG_DIR=./config
AGENTFLOW_HOST=127.0.0.1
AGENTFLOW_PORT=8787
AGENTFLOW_MAX_PROMPT_TOKENS=30000
AGENTFLOW_GLOBAL_CONCURRENCY=4
AGENTFLOW_CLAUDE_BIN=claude
AGENTFLOW_CODEX_BIN=codex
```

- [ ] **Step 5: 写失败的测试 `src/config/env.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

// 这些测试必须与真实 .env 隔离：显式传入一个不存在的 env 文件路径，
// 否则开发者一旦创建了 .env，默认值断言就会失败。
const NO_ENV_FILE = '/nonexistent/agentflow-test.env';

describe('loadEnv', () => {
  it('未提供环境变量时使用默认值', () => {
    const env = loadEnv({}, NO_ENV_FILE);
    expect(env.host).toBe('127.0.0.1');
    expect(env.port).toBe(8787);
    expect(env.maxPromptTokens).toBe(30000);
    expect(env.globalConcurrency).toBe(4);
    expect(env.dbPath).toBe('./data/agentflow.sqlite');
  });

  it('环境变量覆盖默认值，且端口被解析为数字', () => {
    const env = loadEnv(
      { AGENTFLOW_PORT: '9999', AGENTFLOW_DB_PATH: '/tmp/x.sqlite' },
      NO_ENV_FILE,
    );
    expect(env.port).toBe(9999);
    expect(env.dbPath).toBe('/tmp/x.sqlite');
  });

  it('端口非法时抛错', () => {
    expect(() => loadEnv({ AGENTFLOW_PORT: 'abc' }, NO_ENV_FILE)).toThrow(/AGENTFLOW_PORT/);
  });

  it('env 文件不存在时静默使用默认值，不抛错', () => {
    expect(() => loadEnv({}, '/nonexistent/definitely-missing.env')).not.toThrow();
  });
});
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL —— 找不到模块 `./env.js`

- [ ] **Step 7: 实现 `src/config/env.ts`**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type AppEnv = {
  dbPath: string;
  logDir: string;
  workspaceDir: string;
  configDir: string;
  host: string;
  port: number;
  maxPromptTokens: number;
  globalConcurrency: number;
  claudeBin: string;
  codexBin: string;
};

const DEFAULTS: AppEnv = {
  dbPath: './data/agentflow.sqlite',
  logDir: './logs',
  workspaceDir: './workspaces',
  configDir: './config',
  host: '127.0.0.1',
  port: 8787,
  maxPromptTokens: 30000,
  globalConcurrency: 4,
  claudeBin: 'claude',
  codexBin: 'codex',
};

/** 读取 .env 文件为键值对；文件不存在时返回空对象 */
export function readDotEnvFile(filePath = resolve(process.cwd(), '.env')): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function readInt(source: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`环境变量 ${key} 必须是正整数，实际为 "${raw}"`);
  }
  return n;
}

function readStr(source: Record<string, string | undefined>, key: string, fallback: string): string {
  const raw = source[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** 合并 .env 文件与显式传入的环境变量（后者优先），产出类型安全的配置 */
export function loadEnv(
  overrides: Record<string, string | undefined> = {},
  envFilePath = resolve(process.cwd(), '.env'),
): AppEnv {
  const merged = { ...readDotEnvFile(envFilePath), ...process.env, ...overrides };
  return {
    dbPath: readStr(merged, 'AGENTFLOW_DB_PATH', DEFAULTS.dbPath),
    logDir: readStr(merged, 'AGENTFLOW_LOG_DIR', DEFAULTS.logDir),
    workspaceDir: readStr(merged, 'AGENTFLOW_WORKSPACE_DIR', DEFAULTS.workspaceDir),
    configDir: readStr(merged, 'AGENTFLOW_CONFIG_DIR', DEFAULTS.configDir),
    host: readStr(merged, 'AGENTFLOW_HOST', DEFAULTS.host),
    port: readInt(merged, 'AGENTFLOW_PORT', DEFAULTS.port),
    maxPromptTokens: readInt(merged, 'AGENTFLOW_MAX_PROMPT_TOKENS', DEFAULTS.maxPromptTokens),
    globalConcurrency: readInt(merged, 'AGENTFLOW_GLOBAL_CONCURRENCY', DEFAULTS.globalConcurrency),
    claudeBin: readStr(merged, 'AGENTFLOW_CLAUDE_BIN', DEFAULTS.claudeBin),
    codexBin: readStr(merged, 'AGENTFLOW_CODEX_BIN', DEFAULTS.codexBin),
  };
}
```

- [ ] **Step 8: 安装依赖（走国内镜像，不阻塞后续）**

```bash
npm install --registry=https://registry.npmmirror.com
```

装完后确认 `package-lock.json` 已生成——**lockfile 即为版本锁定依据，必须提交**。

- [ ] **Step 9: 运行测试与类型检查，确认通过**

Run: `npx vitest run src/config/env.test.ts && npx tsc --noEmit`
Expected: 4 个测试 PASS，类型检查无错误

- [ ] **Step 10: 提交**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example src/config/env.ts src/config/env.test.ts
git commit -m "chore: 初始化项目脚手架与配置加载"
```

---

## Task 2: Phase 0 — CLI 行为探针（阻塞 Task 10）

**Files:**
- Create: `spikes/cli-probe/probe-claude.ts`
- Create: `spikes/cli-probe/probe-codex.ts`
- Create: `spikes/cli-probe/analyze.ts`
- Create: `spikes/cli-probe/README.md`
- Modify: `记录.md`

**Interfaces:**
- Consumes: 无
- Produces: `spikes/cli-probe/out/claude-stream.jsonl`、`out/codex.txt`、`out/meta.json` 三份产物，以及 `README.md` 中记录的**确切可用调用参数**（Task 10 直接照抄）

**为什么这个任务必须最先做且阻塞 Task 10**：runner 适配层的解析代码完全取决于 CLI 的真实输出结构。不先跑探针就写解析代码，等于凭空猜测字段名。

- [ ] **Step 1: 创建探针脚本 `spikes/cli-probe/probe-claude.ts`**

```ts
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(import.meta.dirname, 'out');
mkdirSync(outDir, { recursive: true });

// 探针要验证的核心问题：在有工具调用（Read/Grep）的场景下，
// --json-schema 是否仍能稳定返回符合 schema 的最终结构
const schema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files_read: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files_read'],
  additionalProperties: false,
};

const prompt = [
  '请先读取当前目录下的 package.json，再读取 tsconfig.json。',
  '然后返回结构化结果：',
  '- summary：一句话说明这个项目配置了什么',
  '- files_read：你实际读取过的文件名列表',
].join('\n');

const args = [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--json-schema', JSON.stringify(schema),
  '--max-budget-usd', '0.50',
  '--tools=Read,Grep,Glob',
];

const startedAt = Date.now();
const child = spawn('claude', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

const stdout: Buffer[] = [];
const stderr: Buffer[] = [];
child.stdout.on('data', (c: Buffer) => stdout.push(c));
child.stderr.on('data', (c: Buffer) => stderr.push(c));

child.on('close', (code) => {
  writeFileSync(resolve(outDir, 'claude-stream.jsonl'), Buffer.concat(stdout));
  writeFileSync(resolve(outDir, 'claude-stderr.txt'), Buffer.concat(stderr));
  writeFileSync(
    resolve(outDir, 'meta.json'),
    JSON.stringify({ exitCode: code, durationMs: Date.now() - startedAt, args }, null, 2),
  );
  console.log(`claude 探针结束，exitCode=${code}，耗时 ${Date.now() - startedAt}ms`);
});
```

- [ ] **Step 2: 创建 codex 探针 `spikes/cli-probe/probe-codex.ts`**

```ts
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(import.meta.dirname, 'out');
mkdirSync(outDir, { recursive: true });

const prompt = [
  '请读取当前目录下的 package.json，然后用 JSON 输出：',
  '{"summary": "<一句话说明项目配置了什么>", "files_read": ["<文件名>"]}',
  '只输出 JSON，不要输出任何其他文字。',
].join('\n');

const args = ['exec', '-s', 'read-only', '-C', process.cwd(), prompt];

const startedAt = Date.now();
const child = spawn('codex', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

const stdout: Buffer[] = [];
const stderr: Buffer[] = [];
child.stdout.on('data', (c: Buffer) => stdout.push(c));
child.stderr.on('data', (c: Buffer) => stderr.push(c));

child.on('close', (code) => {
  writeFileSync(resolve(outDir, 'codex.txt'), Buffer.concat(stdout));
  writeFileSync(resolve(outDir, 'codex-stderr.txt'), Buffer.concat(stderr));
  writeFileSync(
    resolve(outDir, 'meta-codex.json'),
    JSON.stringify({ exitCode: code, durationMs: Date.now() - startedAt, args }, null, 2),
  );
  console.log(`codex 探针结束，exitCode=${code}，耗时 ${Date.now() - startedAt}ms`);
});
```

- [ ] **Step 3: 创建分析脚本 `spikes/cli-probe/analyze.ts`**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(import.meta.dirname, 'out');

function analyzeClaude(): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(outDir, 'claude-stream.jsonl'), 'utf8');
  } catch {
    console.log('[claude] 未找到输出文件，请先运行 probe-claude.ts');
    return;
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const histogram = new Map<string, number>();
  const keysByType = new Map<string, Set<string>>();
  let parseFailures = 0;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const type = String(obj.type ?? '<no-type>');
      histogram.set(type, (histogram.get(type) ?? 0) + 1);
      const bucket = keysByType.get(type) ?? new Set<string>();
      for (const k of Object.keys(obj)) bucket.add(k);
      keysByType.set(type, bucket);
    } catch {
      parseFailures += 1;
    }
  }

  console.log(`[claude] 总行数=${lines.length}，JSON 解析失败=${parseFailures}`);
  console.log('[claude] 事件类型直方图：');
  for (const [type, count] of [...histogram.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type} × ${count}  keys=[${[...(keysByType.get(type) ?? [])].join(', ')}]`);
  }
  console.log('[claude] 结论要点：');
  console.log('  1) 是否存在 type=result 的最终事件？其内的 structured_output / result 字段是什么？');
  console.log('  2) usage 是否在流中出现？出现在哪个事件里？');
  console.log('  3) session_id 出现在哪条事件？可否用于 --resume？');
}

function analyzeCodex(): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(outDir, 'codex.txt'), 'utf8');
  } catch {
    console.log('[codex] 未找到输出文件，请先运行 probe-codex.ts');
    return;
  }
  console.log(`[codex] 输出总长度=${raw.length} 字符`);
  const jsonBlocks = raw.match(/\{[\s\S]*\}/g);
  console.log(`[codex] 可提取的 JSON 候选块数量=${jsonBlocks?.length ?? 0}`);
  if (jsonBlocks?.[0]) {
    try {
      JSON.parse(jsonBlocks[0]);
      console.log('[codex] 第一个候选块可被 JSON.parse 解析');
    } catch {
      console.log('[codex] 第一个候选块无法被 JSON.parse 解析（说明需要更宽松的提取策略）');
    }
  }
  console.log('[codex] 输出前 40 行预览：');
  console.log(raw.split('\n').slice(0, 40).join('\n'));
}

analyzeClaude();
analyzeCodex();
```

- [ ] **Step 4: 依次运行探针并保存原始输出**

```bash
npx tsx spikes/cli-probe/probe-claude.ts
npx tsx spikes/cli-probe/probe-codex.ts
npx tsx spikes/cli-probe/analyze.ts
```

注意：`out/` 目录需加入 `.gitignore`（在 Step 6 处理）。若 claude 未登录会直接报错，此时记录到 README 并停止本任务。

- [ ] **Step 5: 把结论逐条写入 `spikes/cli-probe/README.md`**

README 必须**逐条回答**下列问题，答案必须来自 Step 4 的真实输出，**不允许写"预计"或"可能"**：

```markdown
# CLI 行为探针结论（Phase 0）

探针日期：<填写实际日期>
claude 版本：<`claude --version` 输出>

## claude

1. `--output-format stream-json` 的事件类型清单：
   <粘贴 analyze.ts 打印的直方图>
2. 最终结构化结果出现在哪条事件、哪个字段？
   <粘贴该条事件的实际 JSON 片段>
3. `--json-schema` 在有工具调用的场景下是否返回了符合 schema 的结构？
   <是/否 + 证据片段>
4. usage / token 信息：出现在哪条事件、字段路径是什么？是否边跑边给？
   <粘贴证据>
5. session id 字段名与位置？是否可用于 `--resume`？
   <粘贴证据>
6. `--tools=Read,Grep,Glob` 这种写法是否被接受？若不接受，正确写法是什么？
   <是/否 + 实际报错或行为>

## codex

7. `codex exec` 的 stdout 是否包含可机器解析的结构化结果？
   <是/否 + 证据>
8. 若需要提取 JSON，可用的策略是什么？
   <具体策略>

## 对 Task 10 的结论（必须明确写出）

- 解析入口事件类型：<确切字符串>
- 结构化结果的字段路径：<如 `result.structured_output`>
- usage 字段路径：<...>
- 最终采用的 claude 调用参数数组：<完整参数，Task 10 直接照抄>
```

- [ ] **Step 6: 把探针产物加入 `.gitignore`**

在 `.gitignore` 末尾追加：

```
# 探针原始输出（体积大，不入库）
spikes/cli-probe/out/
```

- [ ] **Step 7: 把要点同步回 `记录.md`**

在 `记录.md` 的"未完成 / 待验证"表格中，把 Phase 0 探针那一行标记为已完成，并把 README 中的"对 Task 10 的结论"四条复制过去。

- [ ] **Step 8: 提交**

```bash
git add spikes/cli-probe .gitignore 记录.md
git commit -m "chore: 新增 CLI 行为探针并记录 Phase 0 结论"
```

---

## Task 3: 共享领域类型与 Artifact schema

**Files:**
- Create: `src/shared/ids.ts`
- Create: `src/shared/domain.ts`
- Create: `src/shared/artifacts.ts`
- Create: `src/shared/artifacts.test.ts`
- Create: `src/shared/events.ts`
- Create: `src/shared/events.test.ts`

**Interfaces:**
- Consumes: 无（仅依赖 zod）
- Produces:
  - `newId(prefix: string): string`（来自 `ids.ts`）
  - `ArtifactType`、`ArtifactStatus`、`Artifact`、`ArtifactRef`、`ARTIFACT_PAYLOAD_SCHEMAS`、`jsonSchemaForArtifact(type)`（来自 `artifacts.ts`）
  - `KERNEL_EVENT_TYPES`、`KernelEvent`、`NewEvent`（来自 `events.ts`）
  - `NodeRunStatus`、`TaskStatus`、`RoleId`（来自 `domain.ts`）

- [ ] **Step 1: 创建 `src/shared/ids.ts`**

```ts
import { randomUUID } from 'node:crypto';

/** 生成带语义前缀的 id，便于在日志和事件库里肉眼辨认实体类型 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
```

- [ ] **Step 2: 创建 `src/shared/domain.ts`**

```ts
export type TaskStatus = 'active' | 'completed' | 'failed';

export type NodeRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'waiting_gate';

/** 本阶段只用这三个角色 */
export type RoleId = 'pm' | 'backend_dev' | 'qa_engineer';

/** 角色定义（来自 config/roles/*.yaml，由 Task 11 加载） */
export type RoleDef = {
  id: string;
  displayName: string;
  systemPrompt: string;
  inputs: string[];
  outputs: string[];
  owns: string[];
  reads: string[];
  model: string;
  maxPromptTokens?: number;
  maxWallTimeMs: number;
};

/** 工作流定义（来自 config/workflows/*.yaml，由 Task 11 加载） */
export type WorkflowNodeDef = {
  id: string;
  title: string;
  role: string;
  consumes: string[];
  produces: string;
  /** 该节点是否需要在独立 git worktree 中执行 */
  isolate: boolean;
};

export type WorkflowEdgeDef = {
  from: string;
  to: string;
  /** 受限表达式；为空表示无条件转移 */
  when?: string;
};

export type WorkflowDef = {
  id: string;
  start: string;
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
};
```

- [ ] **Step 3: 写失败的测试 `src/shared/artifacts.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { ARTIFACT_PAYLOAD_SCHEMAS, jsonSchemaForArtifact } from './artifacts.js';

describe('Artifact payload schema', () => {
  it('requirement 接受合法载荷', () => {
    const r = ARTIFACT_PAYLOAD_SCHEMAS.requirement.safeParse({
      problem: '用户无法自动流转任务',
      goals: ['支持多角色自动流转'],
      non_goals: ['不做分布式调度'],
      acceptance_criteria: ['一个需求输入后三角色自动完成'],
    });
    expect(r.success).toBe(true);
  });

  it('requirement 缺少 problem 时拒绝', () => {
    const r = ARTIFACT_PAYLOAD_SCHEMAS.requirement.safeParse({
      goals: ['x'],
      non_goals: [],
      acceptance_criteria: [],
    });
    expect(r.success).toBe(false);
  });

  it('work_package_plan 缺少 interface_contract 或 acceptance_refs 时拒绝', () => {
    const bad = ARTIFACT_PAYLOAD_SCHEMAS.work_package_plan.safeParse({
      packages: [{ id: 'wp1', name: '后端接口', owns: [], reads: [], depends_on: [] }],
    });
    expect(bad.success).toBe(false);

    const good = ARTIFACT_PAYLOAD_SCHEMAS.work_package_plan.safeParse({
      packages: [
        {
          id: 'wp1',
          name: '后端接口',
          owns: ['src/server/**'],
          reads: ['docs/**'],
          depends_on: [],
          interface_contract: { 'GET /health': '返回 {ok:true}' },
          acceptance_refs: ['健康检查接口可用'],
        },
      ],
    });
    expect(good.success).toBe(true);
  });

  it('工作包缺少 owns 键时拒绝', () => {
    // 单独隔离 owns 的必填性：其余字段全部合法，只缺 owns
    const r = ARTIFACT_PAYLOAD_SCHEMAS.work_package_plan.safeParse({
      packages: [
        {
          id: 'wp1',
          name: '无写入范围',
          reads: ['docs/**'],
          depends_on: [],
          interface_contract: {},
          acceptance_refs: [],
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('owns: [] 合法——代表该工作包没有写入范围（只读），这是有意为之', () => {
    // 这条用例用测试固定住「空 owns = 只读」的语义，
    // 防止将来有人误给 owns 加上 .min(1)（那会让「只读」无法在 schema 层表达）
    const r = ARTIFACT_PAYLOAD_SCHEMAS.work_package_plan.safeParse({
      packages: [
        {
          id: 'wp1',
          name: '只读工作包',
          owns: [],
          reads: ['docs/**'],
          depends_on: [],
          interface_contract: {},
          acceptance_refs: [],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('jsonSchemaForArtifact 产出可序列化的 JSON Schema 且顶层为 object', () => {
    const schema = jsonSchemaForArtifact('test_report') as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(() => JSON.stringify(schema)).not.toThrow();
  });
});
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `npx vitest run src/shared/artifacts.test.ts`
Expected: FAIL —— 找不到模块 `./artifacts.js`

- [ ] **Step 5: 实现 `src/shared/artifacts.ts`**

```ts
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ARTIFACT_TYPES = [
  'requirement',
  'work_package_plan',
  'code_diff',
  'test_report',
] as const;

export const ArtifactTypeSchema = z.enum(ARTIFACT_TYPES);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactStatusSchema = z.enum(['ok', 'needs_changes', 'blocked']);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

const RequirementPayload = z.object({
  problem: z.string().min(1),
  goals: z.array(z.string().min(1)),
  non_goals: z.array(z.string()),
  acceptance_criteria: z.array(z.string().min(1)),
});

const WorkPackageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  owns: z.array(z.string().min(1)),
  reads: z.array(z.string()),
  depends_on: z.array(z.string()),
  /** 接口契约：键为接口签名，值为行为描述。冻结后不可变 */
  interface_contract: z.record(z.string()),
  acceptance_refs: z.array(z.string()),
});

const WorkPackagePlanPayload = z.object({
  packages: z.array(WorkPackageSchema).min(1),
});

const CodeDiffPayload = z.object({
  wp_id: z.string().min(1),
  branch: z.string().min(1),
  files_changed: z.array(z.string()),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  self_test_result: z.enum(['passed', 'failed', 'not_run']),
  notes: z.string(),
});

const TestReportPayload = z.object({
  wp_id: z.string().min(1),
  suites: z.array(z.string()),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failures: z.array(z.object({ test: z.string(), reason: z.string() })),
});

/** 本阶段实现的 4 种 Artifact 载荷 schema */
export const ARTIFACT_PAYLOAD_SCHEMAS = {
  requirement: RequirementPayload,
  work_package_plan: WorkPackagePlanPayload,
  code_diff: CodeDiffPayload,
  test_report: TestReportPayload,
} satisfies Record<ArtifactType, z.ZodTypeAny>;

export const ArtifactRefSchema = z.object({
  kind: z.enum(['file', 'commit', 'artifact']),
  uri: z.string().min(1),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ArtifactSchema = z.object({
  artifact_id: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().min(1),
  type: ArtifactTypeSchema,
  status: ArtifactStatusSchema,
  schema_version: z.number().int().positive(),
  payload: z.unknown(),
  refs: z.array(ArtifactRefSchema),
  /** 唯一会进入下游 prompt 的部分，控制在 500 token 内 */
  summary: z.string().max(4000),
  created_at: z.number().int(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ARTIFACT_SCHEMA_VERSION = 1;

/** 校验并解析载荷；失败时抛出带 artifact 类型信息的错误 */
export function parseArtifactPayload(type: ArtifactType, raw: unknown): unknown {
  const schema = ARTIFACT_PAYLOAD_SCHEMAS[type];
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Artifact(${type}) 载荷校验失败：${result.error.message}`);
  }
  return result.data;
}

/** 导出 JSON Schema，供 claude --json-schema 使用 */
export function jsonSchemaForArtifact(type: ArtifactType): object {
  return zodToJsonSchema(ARTIFACT_PAYLOAD_SCHEMAS[type], {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as object;
}
```

- [ ] **Step 6: 补装 `zod-to-json-schema`**

```bash
npm install zod-to-json-schema --registry=https://registry.npmmirror.com
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `npx vitest run src/shared/artifacts.test.ts`
Expected: 6 个测试 PASS

- [ ] **Step 8: 写失败的测试 `src/shared/events.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { KERNEL_EVENT_TYPES, KernelEventSchema } from './events.js';

describe('KernelEvent', () => {
  it('事件类型清单包含 Phase 1 必需的类型', () => {
    const required = [
      'task.created',
      'node.started',
      'node.succeeded',
      'artifact.created',
      'transfer.decided',
    ];
    for (const t of required) {
      expect(KERNEL_EVENT_TYPES).toContain(t);
    }
  });

  it('接受合法事件', () => {
    const r = KernelEventSchema.safeParse({
      seq: 1,
      event_id: 'evt_1',
      task_id: 'task_1',
      type: 'task.created',
      payload: { title: 'x' },
      actor: 'human',
      created_at: 1_700_000_000_000,
    });
    expect(r.success).toBe(true);
  });

  it('拒绝未知事件类型', () => {
    const r = KernelEventSchema.safeParse({
      seq: 1,
      event_id: 'evt_1',
      task_id: 'task_1',
      type: 'nope.happened',
      payload: {},
      actor: 'kernel',
      created_at: 1,
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 9: 实现 `src/shared/events.ts`**

```ts
import { z } from 'zod';

/** 全部内核事件类型。Phase 1 只产生其中一部分，其余在后续阶段启用 */
export const KERNEL_EVENT_TYPES = [
  'task.created',
  'task.completed',
  'task.failed',
  'wp.declared',
  'wp.started',
  'wp.merged',
  'node.queued',
  'node.started',
  'node.succeeded',
  'node.failed',
  'node.cancelled',
  'node.usage_recorded',
  'artifact.created',
  'artifact.invalidated',
  'transfer.decided',
  'budget.consumed',
  'budget.exceeded',
] as const;

export const KernelEventTypeSchema = z.enum(KERNEL_EVENT_TYPES);
export type KernelEventType = z.infer<typeof KernelEventTypeSchema>;

export const KernelEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  event_id: z.string().min(1),
  task_id: z.string().min(1),
  type: KernelEventTypeSchema,
  payload: z.record(z.unknown()),
  actor: z.string().min(1),
  created_at: z.number().int(),
});
export type KernelEvent = z.infer<typeof KernelEventSchema>;

/** 追加事件时的入参：seq / event_id / created_at 由事件库填充 */
export type NewEvent = {
  task_id: string;
  type: KernelEventType;
  payload: Record<string, unknown>;
  actor: string;
};

/** 决策来源。写在 transfer.decided 事件里，是"为什么走到这一步"的凭据 */
export type DecidedBy = 'rule' | 'llm' | 'human';
```

- [ ] **Step 10: 运行全部测试与类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS，无类型错误

- [ ] **Step 11: 提交**

```bash
git add src/shared package.json package-lock.json
git commit -m "feat: 新增共享领域类型与 Artifact 载荷 schema"
```

---

## Task 4: 事件存储（append-only）

**Files:**
- Create: `src/kernel/event-store.ts`
- Create: `src/kernel/event-store.test.ts`

**Interfaces:**
- Consumes: `KernelEvent`、`NewEvent`（Task 3 的 `src/shared/events.ts`）；`newId`（Task 3 的 `src/shared/ids.ts`）
- Produces: `EventStore` 接口与 `createEventStore(dbPath: string): EventStore`，其中
  `EventStore = { append(e: NewEvent): KernelEvent; readTask(taskId: string): KernelEvent[]; readAll(): KernelEvent[]; lastSeq(): number; close(): void }`

- [ ] **Step 1: 写失败的测试 `src/kernel/event-store.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventStore, type EventStore } from './event-store.js';

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = createEventStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('append 后返回带 seq 与 created_at 的完整事件', () => {
    const e = store.append({
      task_id: 'task_1',
      type: 'task.created',
      payload: { title: '测试任务' },
      actor: 'human',
    });
    expect(e.seq).toBe(1);
    expect(e.task_id).toBe('task_1');
    expect(e.event_id).toMatch(/^evt_/);
    expect(e.created_at).toBeGreaterThan(0);
  });

  it('seq 全局单调递增，跨任务连续', () => {
    const a = store.append({ task_id: 't1', type: 'task.created', payload: {}, actor: 'human' });
    const b = store.append({ task_id: 't2', type: 'task.created', payload: {}, actor: 'human' });
    const c = store.append({ task_id: 't1', type: 'node.started', payload: {}, actor: 'kernel' });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(store.lastSeq()).toBe(3);
  });

  it('readTask 只返回该任务的事件，且按 seq 升序', () => {
    store.append({ task_id: 't1', type: 'task.created', payload: {}, actor: 'human' });
    store.append({ task_id: 't2', type: 'task.created', payload: {}, actor: 'human' });
    store.append({ task_id: 't1', type: 'node.started', payload: {}, actor: 'kernel' });

    const events = store.readTask('t1');
    expect(events.map((e) => e.type)).toEqual(['task.created', 'node.started']);
  });

  it('payload 能原样往返（含嵌套对象）', () => {
    store.append({
      task_id: 't1',
      type: 'artifact.created',
      payload: { artifact_id: 'a1', nested: { deep: [1, 2, 3] } },
      actor: 'role:pm',
    });
    const [loaded] = store.readTask('t1');
    expect(loaded?.payload).toEqual({ artifact_id: 'a1', nested: { deep: [1, 2, 3] } });
  });

  it('事件库只追加：同一 task 多次读取结果稳定增长，旧事件不被修改', () => {
    const first = store.append({ task_id: 't1', type: 'task.created', payload: {}, actor: 'human' });
    const before = store.readTask('t1');
    store.append({ task_id: 't1', type: 'node.started', payload: {}, actor: 'kernel' });
    const after = store.readTask('t1');
    expect(after[0]).toEqual(first);
    expect(before.length).toBe(1);
    expect(after.length).toBe(2);
  });

  it('空库时 lastSeq 为 0 且 readAll 为空数组', () => {
    expect(store.lastSeq()).toBe(0);
    expect(store.readAll()).toEqual([]);
  });

  it('readAll 跨任务返回全部事件，按 seq 升序', () => {
    store.append({ task_id: 't2', type: 'task.created', payload: {}, actor: 'human' });
    store.append({ task_id: 't1', type: 'task.created', payload: {}, actor: 'human' });
    store.append({ task_id: 't2', type: 'node.started', payload: {}, actor: 'kernel' });
    expect(store.readAll().map((e) => [e.seq, e.task_id])).toEqual([
      [1, 't2'],
      [2, 't1'],
      [3, 't2'],
    ]);
  });

  it('非法事件不留「幽灵行」，且不会毒化读接口（护栏）', () => {
    // NewEvent 把 task_id / actor 声明为普通 string，而 KernelEventSchema 要求 .min(1)，
    // 所以下面这行能通过编译。若 append 先落库后校验，就会留下违反 schema 的残留行，
    // 使 readAll() 永久抛错——真相库被毒化。本用例是防止该缺陷复现的护栏。
    expect(() =>
      store.append({ task_id: '', type: 'task.created', payload: {}, actor: 'human' }),
    ).toThrow();
    expect(() =>
      store.append({ task_id: 't1', type: 'task.created', payload: {}, actor: '' }),
    ).toThrow();

    // 库里必须一行都没有
    expect(store.lastSeq()).toBe(0);
    expect(store.readAll()).toEqual([]);
    expect(store.readTask('')).toEqual([]);

    // 后续合法写入仍能正常进行，seq 从 1 开始
    const ok = store.append({ task_id: 't1', type: 'task.created', payload: {}, actor: 'human' });
    expect(ok.seq).toBe(1);
    expect(store.readAll()).toHaveLength(1);
  });

  it('append 的返回值与从库里读出的事件严格相等', () => {
    // 用含 undefined 的 payload 暴露「入参回显」与「落库重读」的差异：
    // JSON.stringify 会把 {a: undefined, b: 1} 落成 {"b":1}，
    // 而 toStrictEqual 把「含 undefined 键」与「缺该键」视为不等。
    const appended = store.append({
      task_id: 't1',
      type: 'artifact.created',
      payload: { a: undefined, b: 1 },
      actor: 'kernel',
    });
    expect(appended.payload).toStrictEqual({ b: 1 });
    const [read] = store.readTask('t1');
    expect(appended).toStrictEqual(read);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/kernel/event-store.test.ts`
Expected: FAIL —— 找不到模块 `./event-store.js`

- [ ] **Step 3: 实现 `src/kernel/event-store.ts`**

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId } from '../shared/ids.js';
import { KernelEventSchema, type KernelEvent, type NewEvent } from '../shared/events.js';

export interface EventStore {
  append(event: NewEvent): KernelEvent;
  readTask(taskId: string): KernelEvent[];
  readAll(): KernelEvent[];
  lastSeq(): number;
  close(): void;
}

type EventRow = {
  seq: number;
  event_id: string;
  task_id: string;
  type: string;
  payload: string;
  actor: string;
  created_at: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  task_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
`;

function rowToEvent(row: EventRow): KernelEvent {
  return KernelEventSchema.parse({
    seq: row.seq,
    event_id: row.event_id,
    task_id: row.task_id,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    actor: row.actor,
    created_at: row.created_at,
  });
}

/** 创建事件库。dbPath 传 ':memory:' 用于测试 */
export function createEventStore(dbPath: string): EventStore {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    `INSERT INTO events (event_id, task_id, type, payload, actor, created_at)
     VALUES (@event_id, @task_id, @type, @payload, @actor, @created_at)`,
  );
  const readTaskStmt = db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC');
  const readAllStmt = db.prepare('SELECT * FROM events ORDER BY seq ASC');
  const lastSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS last FROM events');

  return {
    append(event: NewEvent): KernelEvent {
      const candidate = {
        event_id: newId('evt'),
        task_id: event.task_id,
        type: event.type,
        payload: event.payload,
        actor: event.actor,
        created_at: Date.now(),
      };

      // 关键：先校验再落库。
      // 若反过来先 INSERT 再 parse，非法输入（例如 task_id 为空串——NewEvent 把它声明为普通
      // string，而 schema 要求 .min(1)，所以这行能通过编译）会留下"幽灵行"：
      // 调用方以为写入失败、库里已有一行，且该行违反 schema，导致之后 readAll() 解析它时
      // 永久抛错——真相库被毒化成不可读。先用占位 seq 走一遍 schema 即可杜绝。
      KernelEventSchema.parse({ seq: 0, ...candidate });

      const payload = JSON.stringify(candidate.payload);
      const info = insertStmt.run({ ...candidate, payload });

      // 返回值走 rowToEvent（与 readTask 同一条解析路径），
      // 保证「append 返回的事件」与「之后从库里读出的事件」严格相等。
      // 若直接把入参 payload 回显出去，{a: undefined} 这类值会与落库后的 {} 不一致。
      return rowToEvent({ seq: Number(info.lastInsertRowid), ...candidate, payload });
    },

    readTask(taskId: string): KernelEvent[] {
      return (readTaskStmt.all(taskId) as EventRow[]).map(rowToEvent);
    },

    readAll(): KernelEvent[] {
      return (readAllStmt.all() as EventRow[]).map(rowToEvent);
    },

    lastSeq(): number {
      return (lastSeqStmt.get() as { last: number }).last;
    },

    close(): void {
      db.close();
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/kernel/event-store.test.ts`
Expected: 9 个测试 PASS

- [ ] **Step 5: 提交**

```bash
git add src/kernel/event-store.ts src/kernel/event-store.test.ts
git commit -m "feat: 新增 append-only 事件存储"
```

---

## Task 5: 投影器（事件重放）

**Files:**
- Create: `src/kernel/projector.ts`
- Create: `src/kernel/projector.test.ts`

**Interfaces:**
- Consumes: `KernelEvent`（Task 3）；`Artifact`（Task 3）
- Produces: `project(events: KernelEvent[]): TaskState`，其中

```ts
type NodeState = {
  nodeId: string;
  roleId: string;
  status: NodeRunStatus;
  attempt: number;
  runId: string | null;
  artifactIds: string[];
  lastLogRef: string | null;
  lastError: string | null;
};

type TransferRecord = { from: string; to: string; reason: string; decidedBy: DecidedBy };

type TaskState = {
  taskId: string;
  title: string;
  requirementRaw: string;
  baseBranch: string;
  status: TaskStatus;
  currentNodeIds: string[];
  nodes: Record<string, NodeState>;
  artifacts: Artifact[];
  transfers: TransferRecord[];
  visitCounts: Record<string, number>;
  budgetUsedUsd: number;
  completedNodeIds: string[];
};
```

- [ ] **Step 1: 写失败的测试 `src/kernel/projector.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { project } from './projector.js';
import type { KernelEvent } from '../shared/events.js';

let seq = 0;
function ev(type: KernelEvent['type'], payload: Record<string, unknown>): KernelEvent {
  seq += 1;
  return {
    seq,
    event_id: `evt_${seq}`,
    task_id: 'task_1',
    type,
    payload,
    actor: 'test',
    created_at: 1_700_000_000_000 + seq,
  };
}

describe('project', () => {
  it('空事件流产出初始状态', () => {
    const s = project([]);
    expect(s.status).toBe('active');
    expect(s.currentNodeIds).toEqual([]);
    expect(s.artifacts).toEqual([]);
    expect(s.completedNodeIds).toEqual([]);
  });

  it('task.created 填充任务元信息', () => {
    const s = project([
      ev('task.created', {
        title: '自动流转',
        requirement_raw: '让多角色自动流转',
        base_branch: 'main',
      }),
    ]);
    expect(s.title).toBe('自动流转');
    expect(s.requirementRaw).toBe('让多角色自动流转');
    expect(s.baseBranch).toBe('main');
  });

  it('node.started 把节点置为当前节点并累加 visitCount', () => {
    const s = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
    ]);
    expect(s.currentNodeIds).toEqual(['pm_analyze']);
    expect(s.nodes.pm_analyze?.status).toBe('running');
    expect(s.visitCounts.pm_analyze).toBe(1);
  });

  it('node.succeeded 把节点移出当前节点并加入已完成', () => {
    const s = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'logs/runs/run_1.jsonl' }),
    ]);
    expect(s.currentNodeIds).toEqual([]);
    expect(s.completedNodeIds).toEqual(['pm_analyze']);
    expect(s.nodes.pm_analyze?.status).toBe('succeeded');
    expect(s.nodes.pm_analyze?.lastLogRef).toBe('logs/runs/run_1.jsonl');
  });

  it('node.failed 记录错误信息，节点不进入 completed', () => {
    const s = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('node.failed', { node_id: 'pm_analyze', run_id: 'run_1', error: 'CLI 退出码 1' }),
    ]);
    expect(s.completedNodeIds).toEqual([]);
    expect(s.nodes.pm_analyze?.status).toBe('failed');
    expect(s.nodes.pm_analyze?.lastError).toBe('CLI 退出码 1');
  });

  it('artifact.created 追加产物并挂到对应节点', () => {
    const s = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('artifact.created', {
        artifact_id: 'art_1',
        run_id: 'run_1',
        node_id: 'pm_analyze',
        type: 'requirement',
        status: 'ok',
        summary: '需求已澄清',
      }),
    ]);
    expect(s.artifacts.map((a) => a.artifact_id)).toEqual(['art_1']);
    expect(s.nodes.pm_analyze?.artifactIds).toEqual(['art_1']);
  });

  it('transfer.decided 记录转移历史', () => {
    const s = project([
      ev('transfer.decided', {
        from: 'pm_analyze',
        to: 'dev_implement',
        reason: 'requirement.status == ok',
        decided_by: 'rule',
      }),
    ]);
    expect(s.transfers).toEqual([
      { from: 'pm_analyze', to: 'dev_implement', reason: 'requirement.status == ok', decidedBy: 'rule' },
    ]);
  });

  it('node.usage_recorded 累加预算消耗', () => {
    const s = project([
      ev('node.usage_recorded', { node_id: 'pm_analyze', run_id: 'run_1', cost_usd: 0.12, tokens_in: 100, tokens_out: 50 }),
      ev('node.usage_recorded', { node_id: 'dev_implement', run_id: 'run_2', cost_usd: 0.08, tokens_in: 200, tokens_out: 80 }),
    ]);
    expect(s.budgetUsedUsd).toBeCloseTo(0.2, 6);
  });

  it('task.completed 改变任务状态', () => {
    const s = project([ev('task.completed', { reason: '流程图走完' })]);
    expect(s.status).toBe('completed');
  });

  it('重放同一事件序列两次结果完全一致（确定性）', () => {
    const events = [
      ev('task.created', { title: 't', requirement_raw: 'r', base_branch: 'main' }),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }),
    ];
    expect(project(events)).toEqual(project(events));
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/kernel/projector.test.ts`
Expected: FAIL —— 找不到模块 `./projector.js`

- [ ] **Step 3: 实现 `src/kernel/projector.ts`**

```ts
import type { Artifact } from '../shared/artifacts.js';
import type { DecidedBy, KernelEvent } from '../shared/events.js';
import type { NodeRunStatus, TaskStatus } from '../shared/domain.js';

export type NodeState = {
  nodeId: string;
  roleId: string;
  status: NodeRunStatus;
  attempt: number;
  runId: string | null;
  artifactIds: string[];
  lastLogRef: string | null;
  lastError: string | null;
};

export type TransferRecord = { from: string; to: string; reason: string; decidedBy: DecidedBy };

export type TaskState = {
  taskId: string;
  title: string;
  requirementRaw: string;
  baseBranch: string;
  status: TaskStatus;
  currentNodeIds: string[];
  nodes: Record<string, NodeState>;
  artifacts: Artifact[];
  transfers: TransferRecord[];
  visitCounts: Record<string, number>;
  budgetUsedUsd: number;
  completedNodeIds: string[];
};

function str(payload: Record<string, unknown>, key: string, fallback = ''): string {
  const v = payload[key];
  return typeof v === 'string' ? v : fallback;
}

function num(payload: Record<string, unknown>, key: string, fallback = 0): number {
  const v = payload[key];
  return typeof v === 'number' ? v : fallback;
}

function emptyState(): TaskState {
  return {
    taskId: '',
    title: '',
    requirementRaw: '',
    baseBranch: 'main',
    status: 'active',
    currentNodeIds: [],
    nodes: {},
    artifacts: [],
    transfers: [],
    visitCounts: {},
    budgetUsedUsd: 0,
    completedNodeIds: [],
  };
}

/**
 * 把事件流重放成任务状态。
 * 纯函数、无副作用、不读数据库——事件序列相同则结果必然相同。
 */
export function project(events: KernelEvent[]): TaskState {
  const state = emptyState();
  if (events.length > 0) {
    state.taskId = events[0]!.task_id;
  }

  for (const event of events) {
    const p = event.payload;

    switch (event.type) {
      case 'task.created': {
        state.title = str(p, 'title');
        state.requirementRaw = str(p, 'requirement_raw');
        state.baseBranch = str(p, 'base_branch', 'main');
        state.status = 'active';
        break;
      }

      case 'node.queued': {
        const nodeId = str(p, 'node_id');
        state.nodes[nodeId] = {
          nodeId,
          roleId: str(p, 'role_id'),
          status: 'queued',
          attempt: num(p, 'attempt', 1),
          runId: str(p, 'run_id') || null,
          artifactIds: [],
          lastLogRef: null,
          lastError: null,
        };
        break;
      }

      case 'node.started': {
        const nodeId = str(p, 'node_id');
        const previous = state.nodes[nodeId];
        state.nodes[nodeId] = {
          nodeId,
          roleId: str(p, 'role_id'),
          status: 'running',
          attempt: num(p, 'attempt', 1),
          runId: str(p, 'run_id') || null,
          artifactIds: previous?.artifactIds ?? [],
          lastLogRef: previous?.lastLogRef ?? null,
          lastError: null,
        };
        state.visitCounts[nodeId] = (state.visitCounts[nodeId] ?? 0) + 1;
        if (!state.currentNodeIds.includes(nodeId)) {
          state.currentNodeIds.push(nodeId);
        }
        break;
      }

      case 'node.succeeded': {
        const nodeId = str(p, 'node_id');
        const node = state.nodes[nodeId];
        if (node) {
          node.status = 'succeeded';
          node.lastLogRef = str(p, 'log_ref') || node.lastLogRef;
        }
        state.currentNodeIds = state.currentNodeIds.filter((id) => id !== nodeId);
        if (!state.completedNodeIds.includes(nodeId)) {
          state.completedNodeIds.push(nodeId);
        }
        break;
      }

      case 'node.failed': {
        const nodeId = str(p, 'node_id');
        const node = state.nodes[nodeId];
        if (node) {
          node.status = 'failed';
          node.lastError = str(p, 'error', '未知错误');
          node.lastLogRef = str(p, 'log_ref') || node.lastLogRef;
        }
        state.currentNodeIds = state.currentNodeIds.filter((id) => id !== nodeId);
        break;
      }

      case 'node.cancelled': {
        const nodeId = str(p, 'node_id');
        const node = state.nodes[nodeId];
        if (node) node.status = 'cancelled';
        state.currentNodeIds = state.currentNodeIds.filter((id) => id !== nodeId);
        break;
      }

      case 'node.usage_recorded': {
        state.budgetUsedUsd += num(p, 'cost_usd', 0);
        break;
      }

      case 'artifact.created': {
        const artifact: Artifact = {
          artifact_id: str(p, 'artifact_id'),
          task_id: event.task_id,
          run_id: str(p, 'run_id'),
          type: str(p, 'type') as Artifact['type'],
          status: str(p, 'status', 'ok') as Artifact['status'],
          schema_version: num(p, 'schema_version', 1),
          payload: p['payload'],
          refs: Array.isArray(p['refs']) ? (p['refs'] as Artifact['refs']) : [],
          summary: str(p, 'summary'),
          created_at: event.created_at,
        };
        state.artifacts.push(artifact);
        const nodeId = str(p, 'node_id');
        const node = state.nodes[nodeId];
        if (node && !node.artifactIds.includes(artifact.artifact_id)) {
          node.artifactIds.push(artifact.artifact_id);
        }
        break;
      }

      case 'artifact.invalidated': {
        const artifactId = str(p, 'artifact_id');
        state.artifacts = state.artifacts.filter((a) => a.artifact_id !== artifactId);
        // 必须同步清理节点上的索引。否则 TaskState 内部自相矛盾：
        // artifacts 里已无此产物，而 nodes[].artifactIds 仍指向它，
        // 下游按 node.artifactIds 取产物时会拿到不存在的 id（解析出 undefined 或静默丢内容），
        // 且投影器自身不报错——不一致被无声交付出口。
        // 该失效事件不含 node_id，因此只能全量扫描（Phase 1 规模下无性能顾虑）。
        for (const node of Object.values(state.nodes)) {
          node.artifactIds = node.artifactIds.filter((id) => id !== artifactId);
        }
        break;
      }

      case 'transfer.decided': {
        state.transfers.push({
          from: str(p, 'from'),
          to: str(p, 'to'),
          reason: str(p, 'reason'),
          decidedBy: str(p, 'decided_by', 'rule') as DecidedBy,
        });
        break;
      }

      case 'task.completed': {
        state.status = 'completed';
        break;
      }

      case 'task.failed': {
        state.status = 'failed';
        break;
      }

      case 'budget.consumed':
      case 'budget.exceeded':
      case 'wp.declared':
      case 'wp.started':
      case 'wp.merged':
        // Phase 1 不使用这些事件；显式忽略以保持穷尽性检查
        break;

      default: {
        const exhaustive: never = event.type;
        throw new Error(`未处理的事件类型：${String(exhaustive)}`);
      }
    }
  }

  return state;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/kernel/projector.test.ts`
Expected: 11 个测试 PASS

- [ ] **Step 5: 提交**

```bash
git add src/kernel/projector.ts src/kernel/projector.test.ts
git commit -m "feat: 新增事件重放投影器"
```

---

## Task 6: 事实提取与受限表达式求值器

**Files:**
- Create: `src/kernel/facts.ts`
- Create: `src/kernel/expression.ts`
- Create: `src/kernel/expression.test.ts`

**Interfaces:**
- Consumes: `TaskState`（Task 5）；`WorkflowDef`、`RoleDef`（Task 3 的 `domain.ts`）
- Produces:
  - `Facts`（含可选的 `__functions`）
  - `evaluateExpression(src: string, facts: Facts): boolean`
  - `ExpressionError`（错误类）
  - `buildFacts(input): Facts`，`input = { state: TaskState; workflow: WorkflowDef; roles: Map<string, RoleDef> }`

**表达式语言语义（本任务的核心契约）**

- 路径解析：`a.b.c` 逐级取值；若某级是数组，则对其每个元素的该属性取值（结果仍是数组）
- **数组广播**：比较运算中，若任一侧是数组，则按元素逐个比较，结果是布尔数组
- `all(x)` / `any(x)`：作用于布尔数组
- `count(x)`：统计布尔数组里 `true` 的个数
- `deps(x)`：返回该对象 `depends_on` 指向的对象数组
- 字面量：数字、单引号字符串、`true` / `false`
- 运算符：`not` > 比较 > `and` > `or`（与常规优先级一致）
- **不支持**：赋值、函数定义、任意 JS 求值。这是刻意的限制

- [ ] **Step 1: 写失败的测试 `src/kernel/expression.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { ExpressionError, evaluateExpression, type Facts } from './expression.js';

const facts: Facts = {
  run: { attempt: 2 },
  tests: { failed: 0, passed: 12 },
  reviews: { verdicts: ['approve', 'approve'] },
  artifacts: {
    code_diff: { status: ['ok'] },
    test_report: { status: ['needs_changes'] },
  },
  wp: { id: 'wp1', status: 'running' },
  __functions: {
    deps: (arg: unknown) => {
      const obj = arg as { id: string };
      return obj.id === 'wp1'
        ? [{ id: 'wp0', status: 'merged' }]
        : [{ id: 'wpX', status: 'running' }];
    },
  },
};

describe('evaluateExpression', () => {
  it('标量比较', () => {
    expect(evaluateExpression("tests.failed == 0", facts)).toBe(true);
    expect(evaluateExpression("tests.failed > 0", facts)).toBe(false);
    expect(evaluateExpression("run.attempt >= 2", facts)).toBe(true);
    expect(evaluateExpression("run.attempt != 2", facts)).toBe(false);
  });

  it('字符串单引号字面量', () => {
    expect(evaluateExpression("wp.status == 'running'", facts)).toBe(true);
    expect(evaluateExpression("wp.status == 'merged'", facts)).toBe(false);
  });

  it('布尔字面量与 not', () => {
    expect(evaluateExpression('true', facts)).toBe(true);
    expect(evaluateExpression('not false', facts)).toBe(true);
    expect(evaluateExpression("not wp.status == 'merged'", facts)).toBe(true);
  });

  it('数组广播 + all / any', () => {
    expect(evaluateExpression("all(reviews.verdicts == 'approve')", facts)).toBe(true);
    expect(evaluateExpression("any(reviews.verdicts == 'reject')", facts)).toBe(false);
    expect(evaluateExpression("all(artifacts.code_diff.status == 'ok')", facts)).toBe(true);
    expect(evaluateExpression("all(artifacts.test_report.status == 'ok')", facts)).toBe(false);
    expect(evaluateExpression("any(artifacts.test_report.status == 'needs_changes')", facts)).toBe(true);
  });

  it('count 统计为真的元素个数', () => {
    expect(evaluateExpression("count(reviews.verdicts == 'approve')", facts)).toBe(2);
    expect(evaluateExpression("count(reviews.verdicts == 'reject') == 0", facts)).toBe(true);
  });

  it('deps 函数 + 属性访问 + all', () => {
    expect(evaluateExpression("all(deps(wp).status == 'merged')", facts)).toBe(true);
  });

  it('and / or 优先级与括号', () => {
    expect(evaluateExpression("tests.failed == 0 and run.attempt < 3", facts)).toBe(true);
    expect(evaluateExpression("tests.failed > 0 or run.attempt < 3", facts)).toBe(true);
    // or 优先级低于 and：等价于 false and true or true → true
    expect(evaluateExpression("false and true or true", facts)).toBe(true);
    expect(evaluateExpression("(false and true) or true", facts)).toBe(true);
    expect(evaluateExpression("false and (true or true)", facts)).toBe(false);
  });

  it('复合条件', () => {
    expect(
      evaluateExpression("all(reviews.verdicts == 'approve') and tests.failed == 0", facts),
    ).toBe(true);
  });

  it('路径不存在时抛 ExpressionError（不静默返回 undefined）', () => {
    expect(() => evaluateExpression('nope.missing == 1', facts)).toThrow(ExpressionError);
  });

  it('all/any 作用于非布尔数组时抛 ExpressionError', () => {
    expect(() => evaluateExpression('all(reviews.verdicts)', facts)).toThrow(ExpressionError);
  });

  it('语法错误时抛 ExpressionError 且带位置信息', () => {
    expect(() => evaluateExpression('tests.failed ==', facts)).toThrow(ExpressionError);
    expect(() => evaluateExpression('((', facts)).toThrow(ExpressionError);
  });

  it('拒绝任意 JS 求值（安全性）', () => {
    expect(() => evaluateExpression('process.exit(1)', facts)).toThrow(ExpressionError);
    expect(() => evaluateExpression("require('fs')", facts)).toThrow(ExpressionError);
  });

  it('白名单外的函数名在解析期就被拒（而非靠注册表查空兜住）', () => {
    // 这条用例专门钉住解析期的函数白名单。若只用 process.exit(1) 去验证，
    // 是测不出白名单是否还存在：删掉白名单后，facts.__functions['process.exit']
    // 为 undefined，仍会因「未注册的函数」抛错，用例照样通过。
    // 所以这里用一个**注册表里已经存在**的名字：只有白名单能拦住它。
    const custom: Facts = {
      wp: { id: 'wp1' },
      __functions: {
        customFn: () => true,
      },
    };
    expect(() => evaluateExpression('customFn(1)', custom)).toThrow(/不允许调用函数/);
    // 反证：白名单内的名字若没注册，报的是另一种错，两者文案可区分
    expect(() => evaluateExpression('deps(wp)', { wp: { id: 'wp1' } })).toThrow(/未注册的函数/);
  });

  it('数组元素的字段缺失时抛错，而不是静默变成 undefined', () => {
    // 防的是一类危险情形：若把缺失字段静默映射为 undefined，
    // 在 any(...) / count(...) == 0 / not 这些形态下会翻到「放行」一侧，
    // 即工作流边可能在本不该走时走。
    const f: Facts = {
      wp: { id: 'wp1' },
      __functions: {
        deps: () => [{ id: 'wp0' }, { id: 'wpX', status: 'merged' }],
      },
    };
    expect(() => evaluateExpression("all(deps(wp).status == 'merged')", f)).toThrow(ExpressionError);
    expect(() => evaluateExpression("any(deps(wp).status == 'merged')", f)).toThrow(ExpressionError);
  });

  it('数组元素字段齐全时正常逐元素比较', () => {
    const f: Facts = {
      wp: { id: 'wp1' },
      __functions: { deps: () => [{ id: 'wp0', status: 'merged' }] },
    };
    expect(evaluateExpression("all(deps(wp).status == 'merged')", f)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/kernel/expression.test.ts`
Expected: FAIL —— 找不到模块 `./expression.js`

- [ ] **Step 3: 实现 `src/kernel/expression.ts`**

```ts
export type Facts = Record<string, unknown> & {
  __functions?: Record<string, (arg: unknown, facts: Facts) => unknown>;
};

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

// ---------- 词法分析 ----------

type Token =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'str'; value: string; pos: number }
  | { kind: 'ident'; value: string; pos: number }
  | { kind: 'op'; value: string; pos: number }
  | { kind: 'eof'; pos: number };

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<'];
const ALLOWED_FUNCTIONS = new Set(['all', 'any', 'count', 'deps']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new ExpressionError(`第 ${i} 个字符处字符串未闭合`);
      tokens.push({ kind: 'str', value: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      const raw = src.slice(i, j);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new ExpressionError(`第 ${i} 个字符处数字非法："${raw}"`);
      tokens.push({ kind: 'num', value, pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'ident', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ kind: 'op', value: ch, pos: i });
      i += 1;
      continue;
    }
    const matched = OPERATORS.find((op) => src.startsWith(op, i));
    if (matched) {
      tokens.push({ kind: 'op', value: matched, pos: i });
      i += matched.length;
      continue;
    }
    throw new ExpressionError(`第 ${i} 个字符处出现非法字符 "${ch}"`);
  }
  tokens.push({ kind: 'eof', pos: src.length });
  return tokens;
}

// ---------- 语法分析 ----------

type Ast =
  | { k: 'lit'; v: number | string | boolean }
  | { k: 'ref'; head: { fn: string; args: Ast[] } | null; path: string[] }
  | { k: 'not'; e: Ast }
  | { k: 'bin'; op: string; l: Ast; r: Ast };

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const t = this.tokens[this.pos]!;
    this.pos += 1;
    return t;
  }

  parse(): Ast {
    const e = this.parseOr();
    const t = this.peek();
    if (t.kind !== 'eof') {
      throw new ExpressionError(`第 ${t.pos} 个字符处存在无法解析的剩余内容`);
    }
    return e;
  }

  private parseOr(): Ast {
    let left = this.parseAnd();
    while (this.peek().kind === 'ident' && (this.peek() as { value: string }).value === 'or') {
      this.next();
      left = { k: 'bin', op: 'or', l: left, r: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Ast {
    let left = this.parseNot();
    while (this.peek().kind === 'ident' && (this.peek() as { value: string }).value === 'and') {
      this.next();
      left = { k: 'bin', op: 'and', l: left, r: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Ast {
    const t = this.peek();
    if (t.kind === 'ident' && t.value === 'not') {
      this.next();
      return { k: 'not', e: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Ast {
    const left = this.parsePrimary();
    const t = this.peek();
    if (t.kind === 'op' && OPERATORS.includes(t.value)) {
      this.next();
      const right = this.parsePrimary();
      return { k: 'bin', op: t.value, l: left, r: right };
    }
    return left;
  }

  private parsePrimary(): Ast {
    const t = this.next();
    if (t.kind === 'num') return { k: 'lit', v: t.value };
    if (t.kind === 'str') return { k: 'lit', v: t.value };
    if (t.kind === 'op' && t.value === '(') {
      const inner = this.parseOr();
      const close = this.next();
      if (close.kind !== 'op' || close.value !== ')') {
        throw new ExpressionError(`第 ${close.pos} 个字符处缺少右括号`);
      }
      return inner;
    }
    if (t.kind === 'ident') {
      if (t.value === 'true') return { k: 'lit', v: true };
      if (t.value === 'false') return { k: 'lit', v: false };
      if (t.value === 'and' || t.value === 'or' || t.value === 'not') {
        throw new ExpressionError(`第 ${t.pos} 个字符处关键字 "${t.value}" 位置不合法`);
      }

      const head = this.tryParseCallHeader(t);
      if (head.fn) {
        return { k: 'ref', head: { fn: head.fn, args: head.args }, path: head.trailingPath };
      }
      return { k: 'ref', head: null, path: t.value.split('.') };
    }
    throw new ExpressionError(`第 ${t.pos} 个字符处表达式不完整或非法`);
  }

  /** 处理 `fn(arg1).a.b` 形式；非函数调用时返回 fn=null */
  private tryParseCallHeader(
    ident: Token & { kind: 'ident' },
  ): { fn: string | null; args: Ast[]; trailingPath: string[] } {
    if (this.peek().kind !== 'op' || (this.peek() as { value: string }).value !== '(') {
      return { fn: null, args: [], trailingPath: [] };
    }
    if (!ALLOWED_FUNCTIONS.has(ident.value)) {
      throw new ExpressionError(
        `第 ${ident.pos} 个字符处不允许调用函数 "${ident.value}"；只允许 ${[...ALLOWED_FUNCTIONS].join(' / ')}`,
      );
    }
    this.next(); // 消费 '('
    const args: Ast[] = [];
    if (!(this.peek().kind === 'op' && (this.peek() as { value: string }).value === ')')) {
      args.push(this.parseOr());
      while (this.peek().kind === 'op' && (this.peek() as { value: string }).value === ',') {
        this.next();
        args.push(this.parseOr());
      }
    }
    const close = this.next();
    if (close.kind !== 'op' || close.value !== ')') {
      throw new ExpressionError(`第 ${close.pos} 个字符处缺少右括号`);
    }

    const trailing: string[] = [];
    while (this.peek().kind === 'ident' && (this.peek() as { value: string }).value.startsWith('.')) {
      const part = this.next() as Token & { kind: 'ident' };
      for (const seg of part.value.split('.')) {
        if (seg) trailing.push(seg);
      }
    }
    return { fn: ident.value, args, trailingPath: trailing };
  }
}

// ---------- 求值 ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 逐级解析路径；遇到数组则映射其元素的后续属性 */
function resolvePath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const seg of path) {
    if (Array.isArray(current)) {
      // 数组分支必须对「非对象元素」与「缺字段」直接抛错，不能静默映射成 undefined。
      // 否则「路径不存在必抛错」的契约在这里被绕过：deps(x).status 会得到 [undefined]，
      // 在 all(...) 下后果与抛错相同，但在 any(...) / count(...) == 0 / not 这些形态下
      // 会翻到「放行」一侧 —— 即工作流边可能在本不该走时走。
      current = current.map((item, index) => {
        if (!isPlainObject(item)) {
          throw new ExpressionError(
            `路径 "${path.join('.')}" 在数组第 ${index} 个元素处无法继续取值（元素不是对象）`,
          );
        }
        if (!(seg in item)) {
          throw new ExpressionError(
            `路径 "${path.join('.')}" 在数组第 ${index} 个元素处缺少字段 "${seg}"`,
          );
        }
        return item[seg];
      });
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    current = current[seg];
  }
  return current;
}

function toBoolArray(value: unknown, context: string): boolean[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'boolean')) {
    throw new ExpressionError(`${context} 需要一个布尔数组，实际得到 ${JSON.stringify(value)}`);
  }
  return value;
}

function evalValue(ast: Ast, facts: Facts): unknown {
  switch (ast.k) {
    case 'lit':
      return ast.v;

    case 'ref': {
      let base: unknown;
      if (ast.head) {
        const argValues = ast.head.args.map((a) => evalValue(a, facts));

        // all / any / count 是内置函数，不走 __functions 注册表
        if (ast.head.fn === 'all' || ast.head.fn === 'any' || ast.head.fn === 'count') {
          if (argValues.length !== 1) {
            throw new ExpressionError(`${ast.head.fn}() 只接受 1 个参数`);
          }
          const bools = toBoolArray(argValues[0], `${ast.head.fn}()`);
          if (ast.head.fn === 'all') return bools.every(Boolean);
          if (ast.head.fn === 'any') return bools.some(Boolean);
          return bools.filter(Boolean).length;
        }

        const fn = facts.__functions?.[ast.head.fn];
        if (!fn) throw new ExpressionError(`未注册的函数 "${ast.head.fn}"`);
        base = fn(argValues.length === 1 ? argValues[0] : argValues, facts);
      } else {
        base = facts;
      }
      const resolved = resolvePath(base, ast.path);
      if (resolved === undefined) {
        throw new ExpressionError(`路径 "${ast.path.join('.')}" 解析结果为空`);
      }
      return resolved;
    }

    case 'not': {
      const v = evalValue(ast.e, facts);
      if (typeof v !== 'boolean') throw new ExpressionError('not 只能作用于布尔值');
      return !v;
    }

    case 'bin': {
      if (ast.op === 'and' || ast.op === 'or') {
        const l = evalValue(ast.l, facts);
        const r = evalValue(ast.r, facts);
        if (typeof l !== 'boolean' || typeof r !== 'boolean') {
          throw new ExpressionError(`${ast.op} 两侧必须是布尔值`);
        }
        return ast.op === 'and' ? l && r : l || r;
      }

      const l = evalValue(ast.l, facts);
      const r = evalValue(ast.r, facts);
      return compare(ast.op, l, r);
    }

    default: {
      // 穷尽性守卫。它不是为了兜底，而是为了让「新增 Ast 变体却漏处理」变成编译错误。
      // 这一点必须显式做：tsconfig 没有 noImplicitReturns，且 evalValue 的返回类型是
      // unknown，所以漏掉 case 只会静默返回 undefined，tsc 不会报错。
      // 加了本守卫后，default 分支里的 ast 类型会扣除已处理的变体；若某个变体没被
      // 任何 case 覆盖，它就必然不是 never，赋给 never 即触发 TS2322。
      const exhaustive: never = ast;
      throw new Error(`未处理的 Ast 变体：${JSON.stringify(exhaustive)}`);
    }
  }
}

function scalarCompare(op: string, l: unknown, r: unknown): boolean {
  switch (op) {
    case '==':
      return l === r;
    case '!=':
      return l !== r;
    case '>':
      return typeof l === 'number' && typeof r === 'number' && l > r;
    case '<':
      return typeof l === 'number' && typeof r === 'number' && l < r;
    case '>=':
      return typeof l === 'number' && typeof r === 'number' && l >= r;
    case '<=':
      return typeof l === 'number' && typeof r === 'number' && l <= r;
    default:
      throw new ExpressionError(`不支持的运算符 "${op}"`);
  }
}

/** 数组广播：任一侧为数组时，逐元素比较并返回布尔数组 */
function compare(op: string, l: unknown, r: unknown): boolean | boolean[] {
  if (Array.isArray(l) && Array.isArray(r)) {
    if (l.length !== r.length) {
      throw new ExpressionError(`数组长度不一致，无法逐元素比较（${l.length} vs ${r.length}）`);
    }
    return l.map((lv, idx) => scalarCompare(op, lv, r[idx]));
  }
  if (Array.isArray(l)) return l.map((lv) => scalarCompare(op, lv, r));
  if (Array.isArray(r)) return r.map((rv) => scalarCompare(op, l, rv));
  return scalarCompare(op, l, r);
}

/**
 * 求值受限表达式。
 * 只支持文档化的语法子集：不做任意 JS 求值，因此不存在注入风险。
 */
export function evaluateExpression(src: string, facts: Facts): boolean {
  const ast = new Parser(tokenize(src)).parse();
  const value = evalValue(ast, facts);
  if (typeof value !== 'boolean') {
    throw new ExpressionError(`表达式 "${src}" 求值结果为非布尔值（${JSON.stringify(value)}）`);
  }
  return value;
}
```

- [ ] **Step 4: 运行测试与类型检查，确认通过**

Run: `npx vitest run src/kernel/expression.test.ts && npx tsc --noEmit`
Expected: 15 个测试 PASS，类型检查无错误

注意：`evalValue` 的 `switch` 必须在 `Ast` 的 4 个变体上穷尽（`lit` / `ref` / `not` / `bin`），并靠 `default` 里的 `const exhaustive: never = ast` 守卫把「漏处理变体」变成**编译错误**。**验证方法**：临时删掉 `case 'bin'`，然后跑 `npx tsc --noEmit`——必须报 `TS2322 ... is not assignable to type 'never'`。若删掉后 tsc 仍 exit 0，说明守卫没生效（tsconfig 没有 `noImplicitReturns`，`evalValue` 返回 `unknown`，单靠 switch 是拦不住的）。验证完记得还原。

- [ ] **Step 5: 创建 `src/kernel/facts.ts`**

```ts
import type { RoleDef, WorkflowDef } from '../shared/domain.js';
import type { Facts } from './expression.js';
import type { TaskState } from './projector.js';

export type BuildFactsInput = {
  state: TaskState;
  workflow: WorkflowDef;
  roles: Map<string, RoleDef>;
};

/** 按 artifact 类型聚合成下游条件表达式可以直接引用的形状 */
function buildArtifactFacts(state: TaskState): Record<string, unknown> {
  const byType: Record<string, unknown> = {};
  for (const artifact of state.artifacts) {
    const bucket = (byType[artifact.type] as Record<string, unknown> | undefined) ?? {};
    const statuses = (bucket['status'] as string[] | undefined) ?? [];
    statuses.push(artifact.status);
    bucket['status'] = statuses;
    byType[artifact.type] = bucket;
  }
  return byType;
}

/**
 * 从任务状态构建条件表达式的可用事实。
 * 只暴露流程判断真正需要的信息——不把整个 state 直接倒进去。
 */
export function buildFacts(input: BuildFactsInput): Facts {
  const { state } = input;

  const attempts: Record<string, number> = {};
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    attempts[nodeId] = node.attempt;
  }

  const workflowNodeIds = new Set(input.workflow.nodes.map((n) => n.id));
  const activeNodeId =
    state.currentNodeIds[0] ?? [...state.completedNodeIds].reverse().find((id) => workflowNodeIds.has(id)) ?? '';

  return {
    task: {
      status: state.status,
      budget_used_usd: state.budgetUsedUsd,
    },
    run: {
      attempt: attempts[activeNodeId] ?? 1,
      active_node_id: activeNodeId,
    },
    node: {
      visit_count: state.visitCounts[activeNodeId] ?? 0,
      completed: state.completedNodeIds,
      current: state.currentNodeIds,
      failed: Object.values(state.nodes)
        .filter((n) => n.status === 'failed')
        .map((n) => n.nodeId),
    },
    artifacts: buildArtifactFacts(state),
    __functions: {
      // deps(x)：返回 x.depends_on 指向的对象数组。
      // Phase 1 没有真实工作包，返回空数组——空数组的 all() 为 true，语义上等于"无依赖"
      deps: () => [],
    },
  };
}
```

- [ ] **Step 6: 为 `buildFacts` 补一个测试 `src/kernel/facts.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { buildFacts } from './facts.js';
import { evaluateExpression } from './expression.js';
import { project } from './projector.js';
import type { KernelEvent } from '../shared/events.js';
import type { WorkflowDef } from '../shared/domain.js';

const workflow: WorkflowDef = {
  id: 'simple_dev',
  start: 'pm_analyze',
  nodes: [
    { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
    { id: 'dev_implement', title: '编码实现', role: 'backend_dev', consumes: ['requirement'], produces: 'code_diff', isolate: true },
  ],
  edges: [{ from: 'pm_analyze', to: 'dev_implement', when: "all(artifacts.requirement.status == 'ok')" }],
};

function ev(type: KernelEvent['type'], payload: Record<string, unknown>, seq: number): KernelEvent {
  return { seq, event_id: `e${seq}`, task_id: 'task_1', type, payload, actor: 'test', created_at: seq };
}

describe('buildFacts', () => {
  it('产出的 facts 能驱动真实的条件表达式', () => {
    const state = project([
      ev('task.created', { title: 't', requirement_raw: 'r', base_branch: 'main' }, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      ev('artifact.created', {
        artifact_id: 'a1',
        run_id: 'run_1',
        node_id: 'pm_analyze',
        type: 'requirement',
        status: 'ok',
        summary: '需求已澄清',
      }, 3),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 4),
    ]);

    const facts = buildFacts({ state, workflow, roles: new Map() });
    expect(evaluateExpression("all(artifacts.requirement.status == 'ok')", facts)).toBe(true);
    // 未产出的产物类型：路径不存在，按「不静默返回 undefined」的契约必须抛错，
    // 而不是返回 false。边匹配的「不匹配」语义由 Task 7 的 edgeMatches 用 try/catch 承担：
    // 它捕获 ExpressionError 并返回 { matched: false }，效果与「边不放行」一致。
    // 这里不能期望 false —— 因为若给未产出的类型预置 status: []，all([]) 会因空真而得到
    // true，那反而会让边在产物尚未产出时就放行，比抛错更危险。
    expect(() => evaluateExpression("all(artifacts.code_diff.status == 'ok')", facts)).toThrow(
      ExpressionError,
    );
    expect(evaluateExpression("node.visit_count == 1", facts)).toBe(true);
  });

  it('无依赖时 all(deps(wp).status == ...) 为 true', () => {
    const facts = buildFacts({ state: project([]), workflow, roles: new Map() });
    expect(evaluateExpression("all(deps(task).status == 'merged')", facts)).toBe(true);
  });
});
```

- [ ] **Step 7: 运行全部测试**

Run: `npx vitest run src/kernel && npx tsc --noEmit`
Expected: 全部 PASS，无类型错误

- [ ] **Step 8: 提交**

```bash
git add src/kernel/expression.ts src/kernel/expression.test.ts src/kernel/facts.ts src/kernel/facts.test.ts
git commit -m "feat: 新增受限表达式求值器与事实构建"
```

---

## Task 7: 状态机（转移求值）

**Files:**
- Create: `src/kernel/state-machine.ts`
- Create: `src/kernel/state-machine.test.ts`

**Interfaces:**
- Consumes: `WorkflowDef`（Task 3）；`TaskState`（Task 5）；`Facts` / `evaluateExpression`（Task 6）
- Produces:
  - `Decision` 联合类型
  - `decideNext(input): Decision`，`input = { workflow: WorkflowDef; state: TaskState; facts: Facts }`

```ts
type Decision =
  | { kind: 'start'; nodeId: string; reason: string }
  | { kind: 'end'; status: 'completed' | 'failed'; reason: string }
  | { kind: 'wait'; reason: string };
```

**决策规则（按顺序）**

1. 若 `state.status !== 'active'` → `end`，原因是任务已终止
2. 若存在当前运行中的节点 → `wait`
3. 若无当前节点且无已完成节点 → `start` 工作流的 `start` 节点
4. 否则取**最后完成的节点**，按声明顺序遍历其出边，第一条 `when` 为真（或 `when` 为空）的边胜出 → `start` 目标节点
5. 若某条边的 `when` 求值抛错 → 该边视为不匹配，但错误原因要记录进结果（通过 `wait` 的 reason 暴露）。**任何一条边都不匹配 → `end` 且 `status: 'failed'`**
6. 目标节点若 `visitCounts >= 3` → `end` 且 `failed`，理由是死循环保护。
   **刻意不要求「该节点曾成功完成」**：判据是「被反复进入」这件事本身，否则在反复失败重试场景下保护会失效（spec §9.4：`node.visit_count` 检测同状态反复进入 → 升级）

- [ ] **Step 1: 写失败的测试 `src/kernel/state-machine.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { decideNext } from './state-machine.js';
import { buildFacts } from './facts.js';
import { project } from './projector.js';
import type { KernelEvent } from '../shared/events.js';
import type { WorkflowDef } from '../shared/domain.js';

const workflow: WorkflowDef = {
  id: 'simple_dev',
  start: 'pm_analyze',
  nodes: [
    { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
    { id: 'dev_implement', title: '编码实现', role: 'backend_dev', consumes: ['requirement'], produces: 'code_diff', isolate: true },
    { id: 'qa_verify', title: '测试验证', role: 'qa_engineer', consumes: ['code_diff'], produces: 'test_report', isolate: false },
  ],
  edges: [
    { from: 'pm_analyze', to: 'dev_implement', when: "all(artifacts.requirement.status == 'ok')" },
    { from: 'dev_implement', to: 'qa_verify', when: "all(artifacts.code_diff.status == 'ok')" },
  ],
};

function ev(type: KernelEvent['type'], payload: Record<string, unknown>, seq: number): KernelEvent {
  return { seq, event_id: `e${seq}`, task_id: 'task_1', type, payload, actor: 'test', created_at: seq };
}

function decide(events: KernelEvent[]) {
  const state = project(events);
  const facts = buildFacts({ state, workflow, roles: new Map() });
  return decideNext({ workflow, state, facts });
}

describe('decideNext', () => {
  it('初始状态从 start 节点开始', () => {
    const d = decide([ev('task.created', { title: 't', requirement_raw: 'r', base_branch: 'main' }, 1)]);
    expect(d).toEqual({ kind: 'start', nodeId: 'pm_analyze', reason: '任务开始，进入起始节点' });
  });

  it('有节点运行中时等待', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
    ]);
    expect(d.kind).toBe('wait');
  });

  it('节点成功后条件满足则转移到下游', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      ev('artifact.created', {
        artifact_id: 'a1', run_id: 'run_1', node_id: 'pm_analyze',
        type: 'requirement', status: 'ok', summary: 's',
      }, 3),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 4),
    ]);
    expect(d).toEqual({ kind: 'start', nodeId: 'dev_implement', reason: "all(artifacts.requirement.status == 'ok')" });
  });

  it('条件不满足时任务失败收尾', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      // 产出 blocked 的 requirement
      ev('artifact.created', {
        artifact_id: 'a1', run_id: 'run_1', node_id: 'pm_analyze',
        type: 'requirement', status: 'blocked', summary: '需求有歧义',
      }, 3),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 4),
    ]);
    expect(d.kind).toBe('end');
    if (d.kind === 'end') {
      expect(d.status).toBe('failed');
      expect(d.reason).toContain('没有可用的转移');
    }
  });

  it('无条件边（when 为空）总是匹配', () => {
    const wf: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'pm_analyze', to: 'dev_implement' }],
    };
    const state = project([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 3),
    ]);
    const facts = buildFacts({ state, workflow: wf, roles: new Map() });
    expect(decideNext({ workflow: wf, state, facts })).toEqual({
      kind: 'start', nodeId: 'dev_implement', reason: '无条件边',
    });
  });

  it('多条出边按声明顺序取第一条匹配的', () => {
    const wf: WorkflowDef = {
      ...workflow,
      edges: [
        { from: 'pm_analyze', to: 'qa_verify', when: "all(artifacts.requirement.status == 'ok')" },
        { from: 'pm_analyze', to: 'dev_implement', when: 'true' },
      ],
    };
    const state = project([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      ev('artifact.created', {
        artifact_id: 'a1', run_id: 'run_1', node_id: 'pm_analyze',
        type: 'requirement', status: 'ok', summary: 's',
      }, 3),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 4),
    ]);
    const facts = buildFacts({ state, workflow: wf, roles: new Map() });
    const d = decideNext({ workflow: wf, state, facts });
    expect(d).toMatchObject({ kind: 'start', nodeId: 'qa_verify' });
  });

  it('没有出边的末节点成功后任务完成', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'qa_verify', role_id: 'qa_engineer', run_id: 'run_3', attempt: 1 }, 2),
      ev('node.succeeded', { node_id: 'qa_verify', run_id: 'run_3', log_ref: 'x' }, 3),
    ]);
    expect(d).toEqual({ kind: 'end', status: 'completed', reason: '流程已走完，无后继节点' });
  });

  it('任务已终态时不再推进', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('task.completed', { reason: 'done' }, 2),
    ]);
    expect(d.kind).toBe('end');
  });

  it('同一节点访问超过 3 次时判定死循环', () => {
    // 必须用真正的自环（pm→pm）来触发保护：保护机制检查的是"即将启动的目标节点"
    // 的访问次数，若目标是 dev 且从未启动过，访问次数为 0，不会被拦住。
    const loopWorkflow: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'pm_analyze', to: 'pm_analyze', when: 'true' }],
    };

    const events: KernelEvent[] = [ev('task.created', {}, 1)];
    let seq = 2;
    for (let i = 0; i < 4; i += 1) {
      events.push(ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: `run_${i}`, attempt: i + 1 }, seq++));
      events.push(ev('artifact.created', {
        artifact_id: `a${i}`, run_id: `run_${i}`, node_id: 'pm_analyze',
        type: 'requirement', status: 'ok', summary: 's',
      }, seq++));
      events.push(ev('node.succeeded', { node_id: 'pm_analyze', run_id: `run_${i}`, log_ref: 'x' }, seq++));
    }

    const state = project(events);
    const facts = buildFacts({ state, workflow: loopWorkflow, roles: new Map() });
    const d = decideNext({ workflow: loopWorkflow, state, facts });

    expect(d.kind).toBe('end');
    if (d.kind === 'end') {
      expect(d.status).toBe('failed');
      expect(d.reason).toContain('访问次数');
    }
  });

  it('目标节点访问次数未超限时不会误判为死循环', () => {
    // 自环跑 1 次后继续判定，应当仍允许再次进入（1 < 3），而不是直接判死循环
    const loopWorkflow: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'pm_analyze', to: 'pm_analyze', when: 'true' }],
    };
    const events: KernelEvent[] = [
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_0', attempt: 1 }, 2),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_0', log_ref: 'x' }, 3),
    ];
    const state = project(events);
    const facts = buildFacts({ state, workflow: loopWorkflow, roles: new Map() });
    const d = decideNext({ workflow: loopWorkflow, state, facts });
    expect(d).toMatchObject({ kind: 'start', nodeId: 'pm_analyze' });
  });

  it('条件表达式求值失败时不会崩溃，而是判为不匹配', () => {
    const wf: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'pm_analyze', to: 'dev_implement', when: 'nonexistent.path == 1' }],
    };
    const state = project([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 3),
    ]);
    const facts = buildFacts({ state, workflow: wf, roles: new Map() });
    const d = decideNext({ workflow: wf, state, facts });
    expect(d.kind).toBe('end');
  });

  it('目标节点反复进入但从未成功完成时，同样判定为死循环', () => {
    // 钉住「死循环保护的判据是反复进入本身，而非完成过再进入」。
    // 若将来有人给保护加上「且已在 completedNodeIds 中」这个条件，本用例会变红——
    // 那正是要防止的退化：在反复失败重试场景下会导致保护失效。
    //
    // 事件编排要点：**只产生 node.failed 是到不了保护分支的**。
    // node.failed 不写入 completedNodeIds，于是 completedNodeIds 为空，
    // decideNext 会走规则 3（无当前节点且无已完成节点）直接回起点。
    // 所以必须让另一个节点完成，使「即将启动的目标节点」恰是那个反复失败的节点。
    const loopWorkflow: WorkflowDef = {
      id: 'loop',
      start: 'pm_analyze',
      nodes: [
        { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
        { id: 'dev_implement', title: '编码实现', role: 'backend_dev', consumes: ['requirement'], produces: 'code_diff', isolate: false },
      ],
      edges: [{ from: 'dev_implement', to: 'pm_analyze', when: 'true' }],
    };

    const events: KernelEvent[] = [ev('task.created', {}, 1)];
    let seq = 2;

    // pm_analyze 反复失败 3 次，从未 succeeded → 不在 completedNodeIds 中
    for (let i = 0; i < 3; i += 1) {
      events.push(
        ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: `run_pm_${i}`, attempt: i + 1 }, seq++),
      );
      events.push(ev('node.failed', { node_id: 'pm_analyze', run_id: `run_pm_${i}`, error: '模拟失败' }, seq++));
    }

    // dev_implement 成功一次，使 lastCompletedNodeId = dev_implement
    events.push(ev('node.started', { node_id: 'dev_implement', role_id: 'backend_dev', run_id: 'run_dev', attempt: 1 }, seq++));
    events.push(ev('node.succeeded', { node_id: 'dev_implement', run_id: 'run_dev', log_ref: 'x' }, seq++));

    const state = project(events);
    // 前提断言：这个节点确实从未完成过，但它被进入了 3 次
    expect(state.completedNodeIds).toEqual(['dev_implement']);
    expect(state.visitCounts['pm_analyze']).toBe(3);
    expect(state.currentNodeIds).toEqual([]);

    const facts = buildFacts({ state, workflow: loopWorkflow, roles: new Map() });
    const d = decideNext({ workflow: loopWorkflow, state, facts });

    expect(d.kind).toBe('end');
    if (d.kind === 'end') {
      expect(d.status).toBe('failed');
      expect(d.reason).toContain('访问次数');
    }
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/kernel/state-machine.test.ts`
Expected: FAIL —— 找不到模块 `./state-machine.js`

- [ ] **Step 3: 实现 `src/kernel/state-machine.ts`**

```ts
import type { WorkflowDef, WorkflowEdgeDef } from '../shared/domain.js';
import { ExpressionError, evaluateExpression, type Facts } from './expression.js';
import type { TaskState } from './projector.js';

/** 同一节点被启动的最大次数，超出即判定死循环 */
const MAX_NODE_VISITS = 3;

export type Decision =
  | { kind: 'start'; nodeId: string; reason: string }
  | { kind: 'end'; status: 'completed' | 'failed'; reason: string }
  | { kind: 'wait'; reason: string };

export type DecideInput = {
  workflow: WorkflowDef;
  state: TaskState;
  facts: Facts;
};

/** 求值一条边的条件；空 when 视为无条件匹配 */
function edgeMatches(edge: WorkflowEdgeDef, facts: Facts): { matched: boolean; reason: string } {
  if (!edge.when || edge.when.trim() === '') {
    return { matched: true, reason: '无条件边' };
  }
  try {
    const matched = evaluateExpression(edge.when, facts);
    return { matched, reason: edge.when };
  } catch (error) {
    const detail = error instanceof ExpressionError ? error.message : String(error);
    return { matched: false, reason: `条件求值失败：${detail}` };
  }
}

/** 找到"刚完成、需要判定后继"的那个节点：优先取最后一个完成的节点 */
function lastCompletedNodeId(state: TaskState, workflow: WorkflowDef): string | null {
  const known = new Set(workflow.nodes.map((n) => n.id));
  for (let i = state.completedNodeIds.length - 1; i >= 0; i -= 1) {
    const id = state.completedNodeIds[i]!;
    if (known.has(id)) return id;
  }
  return null;
}

export function decideNext(input: DecideInput): Decision {
  const { workflow, state, facts } = input;

  if (state.status === 'completed') {
    return { kind: 'end', status: 'completed', reason: '任务已完成' };
  }
  if (state.status === 'failed') {
    return { kind: 'end', status: 'failed', reason: '任务已失败' };
  }

  if (state.currentNodeIds.length > 0) {
    return { kind: 'wait', reason: `节点 ${state.currentNodeIds.join(', ')} 仍在运行` };
  }

  const lastNodeId = lastCompletedNodeId(state, workflow);
  if (lastNodeId === null) {
    return { kind: 'start', nodeId: workflow.start, reason: '任务开始，进入起始节点' };
  }

  const outgoing = workflow.edges.filter((e) => e.from === lastNodeId);
  if (outgoing.length === 0) {
    const node = workflow.nodes.find((n) => n.id === lastNodeId);
    if (node) {
      return { kind: 'end', status: 'completed', reason: '流程已走完，无后继节点' };
    }
    return { kind: 'end', status: 'failed', reason: `完成的节点 ${lastNodeId} 不在流程定义中` };
  }

  const failures: string[] = [];
  for (const edge of outgoing) {
    const { matched, reason } = edgeMatches(edge, facts);
    if (!matched) {
      failures.push(`${edge.from}→${edge.to}: ${reason}`);
      continue;
    }
    const visits = state.visitCounts[edge.to] ?? 0;
    if (visits >= MAX_NODE_VISITS) {
      // 死循环保护：判据是「目标节点被反复进入」这件事本身，
      // 刻意**不**要求该节点曾经成功完成——否则在「反复失败重试」场景下保护会失效，
      // 而那正是最该拦住的场景（spec §9.4：visit_count 检测同状态反复进入 → 升级）。
      return {
        kind: 'end',
        status: 'failed',
        reason: `节点 ${edge.to} 访问次数已达 ${visits} 次，判定为死循环`,
      };
    }
    return { kind: 'start', nodeId: edge.to, reason };
  }

  return {
    kind: 'end',
    status: 'failed',
    reason: `节点 ${lastNodeId} 完成后没有可用的转移：${failures.join(' | ')}`,
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/kernel/state-machine.test.ts`
Expected: 12 个测试 PASS

- [ ] **Step 5: 提交**

```bash
git add src/kernel/state-machine.ts src/kernel/state-machine.test.ts
git commit -m "feat: 新增状态机转移求值"
```

---

## Task 8: Runner 接口与 Fake Runner

**Files:**
- Create: `src/runner/types.ts`
- Create: `src/runner/fake-runner.ts`
- Create: `src/runner/fake-runner.test.ts`

**Interfaces:**
- Consumes: `ArtifactType`（Task 3）
- Produces:
  - `AgentRunner` 接口、`RunRequest`、`RunnerEvent`（`types.ts`）
  - `createFakeRunner(script): AgentRunner`，`script: FakeScriptItem[]`

```ts
type RunRequest = {
  runId: string;
  prompt: string;
  systemPrompt: string;
  workdir: string;
  model: string;
  outputSchema?: object;
  artifactType: ArtifactType;
  readOnly: boolean;
  budgetCapUsd?: number;
  wallTimeMs: number;
  sessionId?: string;
};

type RunnerEvent =
  | { kind: 'started'; pid: number; sessionId?: string }
  | { kind: 'log'; chunk: string }
  | { kind: 'usage'; tokensIn: number; tokensOut: number; costUsd: number }
  | { kind: 'artifact'; raw: unknown }
  | { kind: 'exited'; code: number | null };

type AgentRunner = {
  readonly id: string;
  readonly capabilities: {
    structuredOutput: boolean;
    budgetCap: boolean;
    sessionResume: boolean;
    builtinReview: boolean;
  };
  run(req: RunRequest): AsyncIterable<RunnerEvent>;
  cancel(runId: string): Promise<void>;
};
```

**Fake Runner 存在的意义**：编排逻辑的正确性必须能在**不调用真实 API** 的前提下被确定性测试。它按脚本回放事件序列，并可注入失败。

- [ ] **Step 1: 创建 `src/runner/types.ts`**

```ts
import type { ArtifactType } from '../shared/artifacts.js';

export type RunRequest = {
  runId: string;
  prompt: string;
  systemPrompt: string;
  workdir: string;
  model: string;
  outputSchema?: object;
  /** 期望产出的 Artifact 类型，runner 用它做载荷校验 */
  artifactType: ArtifactType;
  readOnly: boolean;
  budgetCapUsd?: number;
  wallTimeMs: number;
  sessionId?: string;
};

export type RunnerEvent =
  | { kind: 'started'; pid: number; sessionId?: string }
  | { kind: 'log'; chunk: string }
  | { kind: 'usage'; tokensIn: number; tokensOut: number; costUsd: number }
  | { kind: 'artifact'; raw: unknown }
  | { kind: 'exited'; code: number | null };

export type RunnerCapabilities = {
  structuredOutput: boolean;
  budgetCap: boolean;
  sessionResume: boolean;
  builtinReview: boolean;
};

export interface AgentRunner {
  readonly id: string;
  readonly capabilities: RunnerCapabilities;
  run(req: RunRequest): AsyncIterable<RunnerEvent>;
  cancel(runId: string): Promise<void>;
}
```

- [ ] **Step 2: 写失败的测试 `src/runner/fake-runner.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createFakeRunner, type FakeScriptItem } from './fake-runner.js';
import type { RunRequest, RunnerEvent } from './types.js';

const req: RunRequest = {
  runId: 'run_1',
  prompt: 'p',
  systemPrompt: 's',
  workdir: '/tmp',
  model: 'sonnet',
  artifactType: 'requirement',
  readOnly: false,
  wallTimeMs: 1000,
};

async function collect(iter: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('FakeRunner', () => {
  it('按脚本回放事件', async () => {
    const script: FakeScriptItem[] = [
      { kind: 'log', chunk: '思考中' },
      { kind: 'artifact', raw: { problem: 'x', goals: [], non_goals: [], acceptance_criteria: [] } },
      { kind: 'usage', tokensIn: 10, tokensOut: 20, costUsd: 0.01 },
      { kind: 'exited', code: 0 },
    ];
    const runner = createFakeRunner({ script });
    const events = await collect(runner.run(req));
    expect(events.map((e) => e.kind)).toEqual(['started', 'log', 'artifact', 'usage', 'exited']);
    expect(events[0]).toMatchObject({ kind: 'started' });
    expect(events[4]).toEqual({ kind: 'exited', code: 0 });
  });

  it('可注入非零退出码', async () => {
    const runner = createFakeRunner({ script: [{ kind: 'exited', code: 1 }] });
    const events = await collect(runner.run(req));
    expect(events.at(-1)).toEqual({ kind: 'exited', code: 1 });
  });

  it('记录收到的所有请求，便于断言 prompt 装配结果', async () => {
    const runner = createFakeRunner({ script: [{ kind: 'exited', code: 0 }] });
    await collect(runner.run(req));
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.runId).toBe('run_1');
  });

  it('cancel 被调用后记录到 cancelled 列表', async () => {
    const runner = createFakeRunner({ script: [{ kind: 'exited', code: 0 }] });
    await runner.cancel('run_1');
    expect(runner.cancelled).toEqual(['run_1']);
  });

  it('多次 run 按调用顺序依次消费脚本队列', async () => {
    const runner = createFakeRunner({
      scripts: [
        [{ kind: 'artifact', raw: {} }, { kind: 'exited', code: 0 }],
        [{ kind: 'exited', code: 3 }],
      ],
    });
    const first = await collect(runner.run(req));
    const second = await collect(runner.run(req));
    expect(first.at(-1)).toEqual({ kind: 'exited', code: 0 });
    expect(second.at(-1)).toEqual({ kind: 'exited', code: 3 });
  });

  it('脚本队列耗尽时抛错，而不是静默返回成功', async () => {
    // 防的是一类测试假绿：脚本份数少于 run 次数时，
    // 若兜底返回成功，测试编排错误会被伪装成「测试通过」。
    // 注意先消费掉唯一那份脚本，这样测的才是「队列耗尽」而不是「创建时队列为空」。
    const runner = createFakeRunner({ script: [{ kind: 'exited', code: 0 }] });

    // 第一次正常消费
    await collect(runner.run(req));

    // 第二次没有脚本了，必须响亮失败
    await expect(collect(runner.run(req))).rejects.toThrow(/脚本队列已耗尽/);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run src/runner/fake-runner.test.ts`
Expected: FAIL —— 找不到模块 `./fake-runner.js`

- [ ] **Step 4: 实现 `src/runner/fake-runner.ts`**

```ts
import type { AgentRunner, RunRequest, RunnerEvent } from './types.js';

/** 脚本项：runner 不产生 started（由实现自动补），其余按顺序回放。
 *  刻意从 RunnerEvent 派生而非手写联合：这样 RunnerEvent 字段漂移时会在编译期报错，
 *  而不是被一个 `as RunnerEvent` 断言悄悄绕过去。 */
export type FakeScriptItem = Exclude<RunnerEvent, { kind: 'started' }>;

export type FakeRunnerOptions = {
  /** 单次 run 的脚本 */
  script?: FakeScriptItem[];
  /** 多次 run 的脚本队列；提供时 script 被忽略 */
  scripts?: FakeScriptItem[][];
};

export type FakeRunner = AgentRunner & {
  /** 已收到的请求，供测试断言 prompt 装配 */
  requests: RunRequest[];
  /** 已被取消的 runId */
  cancelled: string[];
};

export function createFakeRunner(options: FakeRunnerOptions): FakeRunner {
  const queue: FakeScriptItem[][] = options.scripts
    ? [...options.scripts]
    : options.script
      ? [options.script]
      : [];
  const requests: RunRequest[] = [];
  const cancelled: string[] = [];

  return {
    id: 'fake',
    capabilities: {
      structuredOutput: true,
      budgetCap: true,
      sessionResume: false,
      builtinReview: false,
    },
    requests,
    cancelled,

    async *run(req: RunRequest): AsyncIterable<RunnerEvent> {
      requests.push(req);
      yield { kind: 'started', pid: 4242, sessionId: `fake-session-${req.runId}` };

      const script = queue.shift() ?? [{ kind: 'exited', code: 0 }];
      for (const item of script) {
        yield item as RunnerEvent;
      }
    },

    async cancel(runId: string): Promise<void> {
      cancelled.push(runId);
    },
  };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run src/runner/fake-runner.test.ts`
Expected: 6 个测试 PASS

- [ ] **Step 6: 提交**

```bash
git add src/runner/types.ts src/runner/fake-runner.ts src/runner/fake-runner.test.ts
git commit -m "feat: 新增 Runner 归一化接口与 Fake Runner"
```

---

## Task 9: 上下文装配器

**Files:**
- Create: `src/kernel/context-assembler.ts`
- Create: `src/kernel/context-assembler.test.ts`

**Interfaces:**
- Consumes: `Artifact`（Task 3）；`RoleDef`（Task 3）；`TaskState`（Task 5）；`jsonSchemaForArtifact`（Task 3）
- Produces:
  - `assemblePrompt(input): AssembledPrompt`
  - `input = { role: RoleDef; node: WorkflowNodeDef; state: TaskState; worktreePath: string; maxPromptTokens: number }`
  - `AssembledPrompt = { systemPrompt: string; prompt: string; usedArtifactIds: string[]; droppedArtifactIds: string[]; estimatedTokens: number }`
  - `estimateTokens(text: string): number`

**硬性规则**：装配结果不得超过 `maxPromptTokens`。超限时**从优先级最低的输入产物开始，整体丢弃其 summary（只保留 refs 引用）**——绝不允许对内容做中途截断。

- [ ] **Step 1: 写失败的测试 `src/kernel/context-assembler.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { assemblePrompt, estimateTokens } from './context-assembler.js';
import type { Artifact } from '../shared/artifacts.js';
import type { RoleDef, WorkflowNodeDef } from '../shared/domain.js';
import type { TaskState } from './projector.js';

const role: RoleDef = {
  id: 'backend_dev',
  displayName: '后端开发',
  systemPrompt: '你是一名后端开发工程师。',
  inputs: ['requirement'],
  outputs: ['code_diff'],
  owns: ['src/server/**'],
  reads: ['docs/**'],
  model: 'sonnet',
  maxWallTimeMs: 1_800_000,
};

const node: WorkflowNodeDef = {
  id: 'dev_implement',
  title: '编码实现',
  role: 'backend_dev',
  consumes: ['requirement'],
  produces: 'code_diff',
  isolate: true,
};

function artifact(id: string, type: Artifact['type'], summary: string): Artifact {
  return {
    artifact_id: id,
    task_id: 'task_1',
    run_id: 'run_0',
    type,
    status: 'ok',
    schema_version: 1,
    payload: { note: 'payload 内容不应出现在 prompt 里' },
    refs: [{ kind: 'file', uri: `docs/${id}.md` }],
    summary,
    created_at: 1,
  };
}

function baseState(artifacts: Artifact[]): TaskState {
  return {
    taskId: 'task_1',
    title: '自动流转',
    requirementRaw: '让多角色自动流转',
    baseBranch: 'main',
    status: 'active',
    currentNodeIds: [],
    nodes: {},
    artifacts,
    transfers: [],
    visitCounts: {},
    budgetUsedUsd: 0,
    completedNodeIds: [],
  };
}

describe('estimateTokens', () => {
  it('按字符数估算，空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('assemblePrompt', () => {
  it('包含角色提示、任务标题、原始需求、产出要求与硬约束', () => {
    const r = assemblePrompt({
      role,
      node,
      state: baseState([artifact('a1', 'requirement', '需求已澄清')]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 30_000,
    });
    expect(r.systemPrompt).toBe('你是一名后端开发工程师。');
    expect(r.prompt).toContain('自动流转');
    expect(r.prompt).toContain('让多角色自动流转');
    expect(r.prompt).toContain('code_diff');
    expect(r.prompt).toContain('src/server/**');
    expect(r.prompt).toContain('/tmp/ws');
  });

  it('只放输入产物的 summary 与 refs，不放 payload 正文', () => {
    const r = assemblePrompt({
      role,
      node,
      state: baseState([artifact('a1', 'requirement', '需求已澄清')]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 30_000,
    });
    expect(r.prompt).toContain('需求已澄清');
    expect(r.prompt).toContain('docs/a1.md');
    expect(r.prompt).not.toContain('payload 内容不应出现在 prompt 里');
    expect(r.usedArtifactIds).toEqual(['a1']);
    expect(r.droppedArtifactIds).toEqual([]);
  });

  it('只取节点 consumes 声明的产物类型，其他类型不进 prompt', () => {
    const r = assemblePrompt({
      role,
      node,
      state: baseState([
        artifact('a1', 'requirement', '需求已澄清'),
        artifact('a2', 'test_report', '测试报告内容'),
      ]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 30_000,
    });
    expect(r.usedArtifactIds).toEqual(['a1']);
    expect(r.prompt).not.toContain('测试报告内容');
  });

  it('超出 token 上限时整体丢弃低优先级产物 summary，并记录 droppedArtifactIds', () => {
    // 每条大摘要 20_000 字符 ≈ 5000 token，上限 1500，base prompt ≈ 250 token。
    // 必须让"丢掉最后一条后仍然超限"，才能验证出多条被连续丢弃；
    // 若摘要只有 1000 token，丢掉一条就满足了，断言会与预期不符。
    const big = 'x'.repeat(20_000);
    const r = assemblePrompt({
      role,
      node,
      state: baseState([
        artifact('keep', 'requirement', '短摘要'),
        artifact('drop1', 'requirement', big),
        artifact('drop2', 'requirement', big),
      ]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 1500,
    });
    expect(r.estimatedTokens).toBeLessThanOrEqual(1500);
    expect(r.usedArtifactIds).toEqual(['keep']);
    expect(r.droppedArtifactIds.sort()).toEqual(['drop1', 'drop2']);
    // 丢弃的产物仍以 ref 形式保留可追溯性
    expect(r.prompt).toContain('docs/drop1.md');
  });

  it('即使单条摘要就超限，也不会截断内容，而是整体丢弃它', () => {
    const huge = 'y'.repeat(20_000);
    // 上限必须大于"不含任何产物摘要的 base prompt"本身（其中内嵌了 code_diff 的完整 JSON Schema，
    // 约 300~400 token）。设成 200 会导致断言不可能成立。
    // 20_000 字符 ≈ 5000 token，远大于 1500，因此必然被丢弃。
    const r = assemblePrompt({
      role,
      node,
      state: baseState([artifact('huge', 'requirement', huge)]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 1500,
    });
    expect(r.prompt).not.toContain('yyyy');
    expect(r.droppedArtifactIds).toEqual(['huge']);
    expect(r.estimatedTokens).toBeLessThanOrEqual(1500);
  });

  it('无输入产物时也能装配出合法 prompt', () => {
    const r = assemblePrompt({
      role,
      node,
      state: baseState([]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 30_000,
    });
    expect(r.prompt.length).toBeGreaterThan(0);
    expect(r.usedArtifactIds).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/kernel/context-assembler.test.ts`
Expected: FAIL —— 找不到模块 `./context-assembler.js`

- [ ] **Step 3: 实现 `src/kernel/context-assembler.ts`**

```ts
import { jsonSchemaForArtifact, type Artifact, type ArtifactType } from '../shared/artifacts.js';
import type { RoleDef, WorkflowNodeDef } from '../shared/domain.js';
import type { TaskState } from './projector.js';

export type AssembledPrompt = {
  systemPrompt: string;
  prompt: string;
  usedArtifactIds: string[];
  droppedArtifactIds: string[];
  estimatedTokens: number;
};

export type AssembleInput = {
  role: RoleDef;
  node: WorkflowNodeDef;
  state: TaskState;
  worktreePath: string;
  maxPromptTokens: number;
};

/**
 * 粗略的 token 估算：按 4 字符 ≈ 1 token。
 * 目的不是精确计数，而是在装配阶段防止 prompt 失控膨胀。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function renderArtifactBlock(artifact: Artifact, includeSummary: boolean): string {
  const lines = [
    `### 输入产物：${artifact.type}（id=${artifact.artifact_id}，status=${artifact.status}）`,
  ];
  if (includeSummary) {
    lines.push(`摘要：${artifact.summary}`);
  } else {
    lines.push('摘要：已因上下文长度限制省略，请直接读取下方引用文件获取细节。');
  }
  if (artifact.refs.length > 0) {
    lines.push('引用：');
    for (const ref of artifact.refs) {
      lines.push(`- [${ref.kind}] ${ref.uri}`);
    }
  }
  return lines.join('\n');
}

function buildPrompt(
  input: AssembleInput,
  artifacts: Artifact[],
  dropped: Artifact[],
): string {
  const { role, node, state } = input;

  const sections: string[] = [];

  sections.push(
    [
      '## 任务背景',
      `任务标题：${state.title}`,
      `原始需求：${state.requirementRaw}`,
      `当前节点：${node.id}（${node.title}）`,
      `你的角色：${role.displayName}（${role.id}）`,
    ].join('\n'),
  );

  sections.push(['## 工作区', `工作目录：${input.worktreePath}`, '所有文件读写都必须在上述目录内完成。'].join('\n'));

  if (artifacts.length > 0) {
    sections.push(['## 输入材料', ...artifacts.map((a) => renderArtifactBlock(a))].join('\n\n'));
  }

  if (dropped.length > 0) {
    const refs = dropped
      .flatMap((a) => a.refs.map((r) => `- [${r.kind}] ${r.uri}（${a.type}）`))
      .join('\n');
    sections.push(
      ['## 被省略的输入材料', '以下产物因上下文长度限制未包含摘要，需要时请自行读取引用文件：', refs].join('\n'),
    );
  }

  sections.push(
    [
      '## 你的产出要求',
      `必须产出类型为 \`${node.produces}\` 的结构化结果，并严格遵守其 JSON Schema：`,
      '```json',
      JSON.stringify(jsonSchemaForArtifact(node.produces as ArtifactType), null, 2),
      '```',
    ].join('\n'),
  );

  sections.push(
    [
      '## 硬约束',
      `1. 只允许修改以下路径：${role.owns.length > 0 ? role.owns.join('、') : '（无写入权限）'}`,
      `2. 可以读取以下路径：${role.reads.length > 0 ? role.reads.join('、') : '（仅当前工作区）'}`,
      '3. 不要修改工作区之外的文件。',
      '4. 完成后直接输出结构化结果，不要输出额外的解释性长文。',
    ].join('\n'),
  );

  sections.push(`## 可读取的输入产物类型\n${node.consumes.join('、') || '（无）'}`);

  return sections.join('\n\n');
}

/**
 * 装配 prompt。
 * 超限时按"从后往前"逐个整体丢弃产物摘要（保留 ref 引用），而不是截断任何内容。
 */
export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const consumedTypes = new Set(input.node.consumes);
  const candidates = input.state.artifacts.filter((a) => consumedTypes.has(a.type));

  let used = [...candidates];
  let dropped: Artifact[] = [];

  const render = (u: Artifact[], d: Artifact[]): string => buildPrompt(input, u, d);

  let prompt = render(used, dropped);
  let estimated = estimateTokens(input.role.systemPrompt) + estimateTokens(prompt);

  // 从数组末尾（最先产出、优先级最低）开始丢弃
  while (estimated > input.maxPromptTokens && used.length > 0) {
    const removed = used.pop()!;
    dropped = [removed, ...dropped];
    prompt = render(used, dropped);
    estimated = estimateTokens(input.role.systemPrompt) + estimateTokens(prompt);
  }

  return {
    systemPrompt: input.role.systemPrompt,
    prompt,
    usedArtifactIds: used.map((a) => a.artifact_id),
    droppedArtifactIds: dropped.map((a) => a.artifact_id),
    estimatedTokens: estimated,
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/kernel/context-assembler.test.ts`
Expected: 7 个测试 PASS

- [ ] **Step 5: 提交**

```bash
git add src/kernel/context-assembler.ts src/kernel/context-assembler.test.ts
git commit -m "feat: 新增上下文装配器，超限时整体丢弃而非截断"
```

---

## Task 10: Claude Code Runner 适配器

**Files:**
- Create: `src/runner/claude-code-runner.ts`
- Create: `src/runner/claude-code-runner.test.ts`
- Create: `tests/fixtures/claude-stream-sample.jsonl`

**Interfaces:**
- Consumes: `AgentRunner` / `RunRequest` / `RunnerEvent`（Task 8）；`parseArtifactPayload`（Task 3）；**Task 2 探针 README 中记录的字段路径**
- Produces: `createClaudeCodeRunner(options): AgentRunner`，`options = { binPath: string; logDir: string; extraArgs?: string[] }`

**前置条件（硬性，来自 Task 2 的实测结论）**：必须先完成 Task 2。本任务的所有字段路径与调用参数都必须来自 `spikes/cli-probe/README.md` 的「对 Task 10 的结论」与其中的 **gate**，**不允许猜测**。

Task 2 用真实 CLI 实测（含 16,403 次重试的可复核证据）推翻了本计划原先的 4 个假设，实现时必须照下面的**修正后**设计做，不要照抄本节早先的写法：

| 原假设 | 实测结论 | 本任务必须怎么做 |
| --- | --- | --- |
| 用 `--json-schema` 在 CLI 层强制产物格式 | 凭据耗尽期间：该参数会让 CLI 永不退出（空转 13 分钟、16,403 次 `You MUST call the StructuredOutput tool`、CPU 45%~50%）。**凭据恢复后补跑（2026-09-18）**：rc=0、7.0s 正常退出，`result.structured_output` 为符合 schema 的对象；而**不传**时模型会把 JSON 包进 ` ```json ` 代码块 → 解析失败 → 零 artifact | **默认传 `--json-schema`**（有 `outputSchema` 时）；解析层 `structured_output` 优先、`result` 内 JSON 字符串兜底。**「永不退出」只在请求持续失败时出现**，故 wall-clock 超时 + 按进程组 kill 仍是必需配套 |
| 用 `subtype == 'success'` 判成功 | 认证失败时 `subtype` 仍为 `"success"`，而 `is_error` 为 `true`、exit=1 | **只用 `is_error` 判定失败**，绝不看 `subtype` |
| 事件字段可用白名单校验 | 真实事件字段远多于样本（`duration_ms` / `duration_api_ms` / `num_turns` / `stop_reason` / `modelUsage` / `permission_denials` / `uuid`） | 解析层**不做字段白名单**，只取自己需要的字段 |
| `RunRequest.wallTimeMs` 是提示性字段 | 存在永不退出的路径 | **必须实现硬性 wall-clock 超时并 kill 子进程**，否则任务会永久挂起 |
| 成功路径的样本可从 `spikes/cli-probe/out/` 取 | 该目录确认为空（claude 额度耗尽，成功路径未跑通） | fixture 改从 `spikes/cli-probe/README.md` **内联的 5 行原始 JSONL** 提取（那是已归档的真实输出） |

另外两条已实测确认、实现时直接采信的事实：
- `-p` 搭配 `--output-format stream-json` **必须同时给 `--verbose`**，否则没有输出
- 解析必须对 `result` 是「JSON 字符串」和「对象」两种形态都容错

**可测性设计**：解析逻辑与进程管理分离。`parseStreamLine(line)` 是纯函数，可脱离真实 CLI 单测；`createClaudeCodeRunner` 只负责 spawn 与把 stdout 行喂给解析函数。

- [ ] **Step 1: 写失败的测试 `src/runner/claude-code-runner.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { parseStreamLine } from './claude-code-runner.js';

// 注意：下面的样本是**人工构造的**，用于覆盖成功路径（result 为合法 JSON 字符串）。
// 原因：Task 2 因 claude 额度耗尽，成功路径从未跑通，因此没有成功样本可归档。
// 真实归档样本（认证失败路径）由 Step 6 的 fixture 契约回归覆盖。
// 构造样本里的字段名必须与 Task 2 实测结论一致：
//   - 失败判定用 is_error，不用 subtype
//   - usage 在 result 事件内，字段为 input_tokens / output_tokens
//   - 成本字段为 result.total_cost_usd
// 一旦额度恢复并补录到成功样本，应把本文件的入口测试替换为真实样本。
const SAMPLE_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'sess-abc',
  result: '{"summary":"项目配置了 TypeScript 与 vitest","files_read":["package.json"]}',
  usage: { input_tokens: 1200, output_tokens: 300 },
  total_cost_usd: 0.0231,
  is_error: false,
  // 真实事件还有 duration_ms / num_turns / stop_reason / modelUsage 等字段；
  // 解析层不得对其做白名单校验，这里故意不放全，以验证「未知字段被容忍」
  duration_ms: 23,
  num_turns: 2,
});

describe('parseStreamLine', () => {
  it('忽略空行与非法 JSON，返回空数组', () => {
    expect(parseStreamLine('')).toEqual([]);
    expect(parseStreamLine('   ')).toEqual([]);
    expect(parseStreamLine('not json')).toEqual([]);
  });

  it('从 result 事件中提取 usage 与 session id', () => {
    const events = parseStreamLine(SAMPLE_RESULT);
    expect(events).toEqual([
      { kind: 'usage', tokensIn: 1200, tokensOut: 300, costUsd: 0.0231 },
    ]);
  });

  it('result 的内容为合法 JSON 且非错误时，产出 artifact 事件', () => {
    const events = parseStreamLine(SAMPLE_RESULT);
    const artifact = events.find((e) => e.kind === 'artifact');
    expect(artifact).toBeDefined();
    if (artifact && artifact.kind === 'artifact') {
      expect(artifact.raw).toEqual({
        summary: '项目配置了 TypeScript 与 vitest',
        files_read: ['package.json'],
      });
    }
  });

  it('is_error 为 true 时不产出 artifact', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 'sess-abc',
      result: 'error',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      is_error: true,
    });
    const events = parseStreamLine(line);
    expect(events.some((e) => e.kind === 'artifact')).toBe(false);
    expect(events.some((e) => e.kind === 'log')).toBe(true);
  });

  it('assistant 消息作为日志事件输出', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '正在读取 package.json' }] },
    });
    const events = parseStreamLine(line);
    expect(events).toContainEqual({ kind: 'log', chunk: '正在读取 package.json' });
  });

  it('无法解析为 JSON 的 result 内容不产出 artifact，只产出日志', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 's',
      result: '这不是 JSON',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      is_error: false,
    });
    const events = parseStreamLine(line);
    expect(events.some((e) => e.kind === 'artifact')).toBe(false);
    expect(events.some((e) => e.kind === 'log')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/runner/claude-code-runner.test.ts`
Expected: FAIL —— 找不到模块 `./claude-code-runner.js`

- [ ] **Step 3: 创建 fixture 目录并落地真实样本**

```bash
mkdir -p tests/fixtures
```

**样本来源已变更**：原计划要求从 `spikes/cli-probe/out/claude-stream.jsonl` 取，但 Task 2 确认该目录为空（claude 额度耗尽，成功路径未跑通）。

改从 `spikes/cli-probe/README.md` 中**内联的 5 行原始 JSONL** 提取——那是已归档的真实输出，已被复审逐行 `JSON.parse` 并核对过键集合。把其中的 `result` 行写入 `tests/fixtures/claude-stream-sample.jsonl`。**不要手工编造**——这份 fixture 是契约回归测试的基线。

写完后先确认它至少包含这些真实字段（缺任何一个都说明你抄错了行）：`type: "result"`、`subtype`、`is_error`、`usage.input_tokens`、`usage.output_tokens`、`total_cost_usd`、`session_id`。

- [ ] **Step 4: 实现 `src/runner/claude-code-runner.ts`**

```ts
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunner, RunRequest, RunnerEvent } from './types.js';

/** 从 claude 的 stream-json 单行中抽取的归一化事件 */
export function parseStreamLine(line: string): RunnerEvent[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  const type = typeof obj['type'] === 'string' ? (obj['type'] as string) : '';
  const events: RunnerEvent[] = [];

  if (type === 'assistant') {
    const message = obj['message'] as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        events.push({ kind: 'log', chunk: b['text'] });
      }
    }
    return events;
  }

  if (type === 'result') {
    const usage = obj['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
    const tokensIn = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
    const tokensOut = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
    const costUsd = typeof obj['total_cost_usd'] === 'number' ? (obj['total_cost_usd'] as number) : 0;
    events.push({ kind: 'usage', tokensIn, tokensOut, costUsd });

    const isError = obj['is_error'] === true;
    const raw = obj['result'];
    if (isError) {
      events.push({
        kind: 'log',
        chunk: `调用失败：subtype=${String(obj['subtype'] ?? 'unknown')}，result=${String(raw)}`,
      });
      return events;
    }

    // 两条产物通道都读，structured_output 优先（2026-09-18 补跑实测：传了 --json-schema 时
    // 结构化对象在 structured_output；result 形状不确定（散文 / ```json 代码块都出现过），故不能只读它）
    const structured = obj['structured_output'];
    if (structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
      events.push({ kind: 'artifact', raw: structured });
      return events;
    }

    if (typeof raw === 'string') {
      try {
        events.push({ kind: 'artifact', raw: JSON.parse(raw) as unknown });
      } catch {
        events.push({ kind: 'log', chunk: `无法解析结构化产出为 JSON，原始内容：${raw}` });
      }
    } else if (raw !== undefined && raw !== null) {
      events.push({ kind: 'artifact', raw });
    }
    return events;
  }

  return events;
}

export type ClaudeCodeRunnerOptions = {
  binPath: string;
  logDir: string;
  /** 追加的额外参数，用于探针阶段调试 */
  extraArgs?: string[];
  /**
   * 是否启用 CLI 层的结构化输出强制（--json-schema）。默认 true（见 Step 5 的 2026-09-18 修订）。
   * 该参数在请求持续失败时会让 CLI 空转不退出，故 wall-clock 超时 + killTree 是必需配套。
   */
  useJsonSchema?: boolean;
};

/** 根据角色权限和产出要求拼装 claude 命令行参数 */
export function buildArgs(req: RunRequest, useJsonSchema = true): string[] {
  const args = [
    '-p', req.prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    // 实测：-p 搭配 stream-json 必须同时给 --verbose，否则没有输出
    '--verbose',
    '--model', req.model,
  ];

  if (req.systemPrompt) {
    args.push('--system-prompt', req.systemPrompt);
  }
  // 默认传 --json-schema（有 outputSchema 时），解析层两通道兼容
  if (useJsonSchema && req.outputSchema) {
    args.push('--json-schema', JSON.stringify(req.outputSchema));
  }
  if (req.readOnly) {
    args.push('--tools=Read,Grep,Glob', '--permission-mode', 'default');
  } else {
    args.push('--permission-mode', 'acceptEdits', '--tools=Read,Edit,Write,Grep,Glob,Bash');
  }
  if (req.budgetCapUsd !== undefined) {
    args.push('--max-budget-usd', String(req.budgetCapUsd));
  }
  if (req.sessionId) {
    args.push('--session-id', req.sessionId);
  }
  return args;
}

/**
 * 按**进程组**终止子进程树。
 *
 * 为什么必须组杀而不是只杀直接子进程：实测（Phase 0 探针 + 独立对照实验）表明，
 * `#!/bin/sh` 这类脚本会 fork 出孙进程，孙进程**继承了 stdout 管道的写端**，
 * 因此只杀掉直接子进程时，Node 的 `close` 事件永不触发 → 异步生成器永久卡在 await。
 * 这正是「加了超时保护但保护自己挂住」的情形。
 *
 * 前提：spawn 时必须带 `detached: true`，子进程才会成为新进程组的组长，
 * `process.kill(-pid)` 才能命中整组。
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 进程组可能已不存在；退回只杀该 pid，再失败就说明它已经退出
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出，忽略
    }
  }
}

/**
 * 模块级：登记活跃的子进程组，供退出钩子统一清理。
 *
 * 必要性：spawn 用了 `detached: true`（为了让 killTree 能按进程组杀），代价是子进程
 * 脱离父进程组——父进程异常退出时它不会随终端信号一起消失。
 * 若不清理，孤儿的 claude 进程会继续消耗 API 额度。
 */
const activeGroups = new Set<number>();
let exitHookInstalled = false;

function registerGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  activeGroups.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // 用 'exit' 而非 SIGINT/SIGTERM：上层（main.ts）处理完信号并调用 process.exit() 时
    // 'exit' 同样会触发，且 kill 是同步的，可在此安全执行——这样不会与上层争抢信号处理。
    // 边界：SIGKILL 这类不可捕获的终止无法覆盖。
    process.once('exit', () => {
      for (const groupPid of activeGroups) {
        killTree(groupPid);
      }
    });
  }
}

function unregisterGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  activeGroups.delete(pid);
}

export function createClaudeCodeRunner(options: ClaudeCodeRunnerOptions): AgentRunner {
  const running = new Map<string, ReturnType<typeof spawn>>();
  mkdirSync(options.logDir, { recursive: true });

  return {
    id: 'claude-code',
    capabilities: {
      structuredOutput: true,
      budgetCap: true,
      sessionResume: true,
      builtinReview: false,
    },

    async *run(req: RunRequest): AsyncIterable<RunnerEvent> {
      const args = [...buildArgs(req, options.useJsonSchema ?? true), ...(options.extraArgs ?? [])];
      const logPath = join(options.logDir, `${req.runId}.jsonl`);
      const logStream = createWriteStream(logPath, { flags: 'a' });

      const child = spawn(options.binPath, args, {
        cwd: req.workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        // detached: true 让子进程成为新进程组的组长，process.kill(-pid) 才能命中整组。
        // 这是 killTree 能生效的前提。代价是子进程脱离父进程组，需要退出钩子兜底清理。
        detached: true,
      });
      running.set(req.runId, child);
      registerGroup(child.pid ?? -1);

      // 硬性 wall-clock 超时保护。
      // Task 2 实测存在「CLI 永不退出」的路径（--json-schema 挂起 13 分钟），
      // 没有这层保护，任务会永久卡住且后续节点永不执行。
      // 注意必须**组杀**：只杀直接子进程时，孙进程仍持有 stdout 管道写端，
      // close 事件不触发，异步生成器会卡在 await —— 保护本身就失效了。
      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        logStream.write(
          JSON.stringify({ ts: Date.now(), kind: 'timeout', wallTimeMs: req.wallTimeMs }) + '\n',
        );
        killTree(child.pid);
      }, req.wallTimeMs);

      logStream.write(`${JSON.stringify({ ts: Date.now(), kind: 'spawn', args, cwd: req.workdir })}\n`);
      yield { kind: 'started', pid: child.pid ?? -1 };

      const queue: RunnerEvent[] = [];
      let notify: (() => void) | null = null;
      let closed = false;
      let buffered = '';

      const push = (e: RunnerEvent): void => {
        queue.push(e);
        notify?.();
        notify = null;
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        logStream.write(JSON.stringify({ ts: Date.now(), kind: 'stdout', chunk }) + '\n');
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          for (const e of parseStreamLine(line)) push(e);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        logStream.write(JSON.stringify({ ts: Date.now(), kind: 'stderr', chunk }) + '\n');
        push({ kind: 'log', chunk });
      });

      child.on('close', (code) => {
        clearTimeout(timeoutTimer);
        if (buffered.trim() !== '') {
          for (const e of parseStreamLine(buffered)) push(e);
        }
        if (timedOut) {
          push({
            kind: 'log',
            chunk: `调用超过 wall-clock 上限 ${req.wallTimeMs}ms，已被强制终止`,
          });
        }
        closed = true;
        // 被 SIGKILL 终止时 code 为 null，统一归一为 -1，避免上层把 null 当成功
        push({ kind: 'exited', code: timedOut ? -1 : code });
        logStream.end();
        running.delete(req.runId);
      });

      child.on('error', (error) => {
        clearTimeout(timeoutTimer);
        push({ kind: 'log', chunk: `进程启动失败：${error.message}` });
        closed = true;
        push({ kind: 'exited', code: -1 });
        logStream.end();
        running.delete(req.runId);
      });

      while (!closed || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          continue;
        }
        const next = queue.shift()!;
        yield next;
        if (next.kind === 'exited') {
          return;
        }
      }
    },

    async cancel(runId: string): Promise<void> {
      const child = running.get(runId);
      if (!child) return;
      // 与超时路径共用 killTree：只杀直接子进程会留下持有管道的孙进程
      killTree(child.pid);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (running.has(runId)) {
        killTree(child.pid);
        running.delete(runId);
        unregisterGroup(child.pid);
      }
    },
  };
}
```

- [ ] **Step 5: 补两条针对实测缺陷的回归测试**

这两条测试是 Task 2 最有价值产出的直接防护：一条把守 `--json-schema` 的默认取值，一条防止 wall-clock 超时被删掉。

⚠️ **2026-09-18 修订（凭据恢复后补跑实测）**：`--json-schema` 的默认值由「不传」**反转为「传」**——
证据是：不传时模型会把 JSON 包进 ` ```json ` 代码块，真实端到端跑出**零 artifact**；
传了则 rc=0、15.9s 退出、产物字段齐全且成本更低。下面代码块已按修订后的规则更新
（实现见 `src/runner/claude-code-runner.ts`，测试见 `src/runner/claude-code-runner.args.test.ts`）。

先写 `src/runner/claude-code-runner.args.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildArgs } from './claude-code-runner.js';
import type { RunRequest } from './types.js';

const base: RunRequest = {
  runId: 'run_1',
  prompt: '做点事',
  systemPrompt: '你是后端开发',
  workdir: '/tmp',
  model: 'sonnet',
  artifactType: 'code_diff',
  readOnly: false,
  wallTimeMs: 60_000,
};

describe('buildArgs', () => {
  it('默认传 --json-schema（实测：不传时模型常把 JSON 包进代码块，导致解析失败、零产物）', () => {
    const args = buildArgs({ ...base, outputSchema: { type: 'object' } });
    const idx = args.indexOf('--json-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(JSON.stringify({ type: 'object' }));
  });

  it('没有 outputSchema 时不传 --json-schema', () => {
    const args = buildArgs(base);
    expect(args).not.toContain('--json-schema');
  });

  it('显式关闭 useJsonSchema 时不传 --json-schema', () => {
    const args = buildArgs({ ...base, outputSchema: { type: 'object' } }, false);
    expect(args).not.toContain('--json-schema');
  });

  it('stream-json 必须同时带 --verbose（实测缺它则无输出）', () => {
    const args = buildArgs(base);
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
  });

  it('只读角色不给写权限（permission-mode 为 default，且不开放写工具）', () => {
    const args = buildArgs({ ...base, readOnly: true });
    expect(args).toContain('--tools=Read,Grep,Glob');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args.join(' ')).not.toContain('Write');
    expect(args.join(' ')).not.toContain('acceptEdits');
  });

  it('非只读角色使用 acceptEdits 并开放写工具', () => {
    const args = buildArgs(base);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args.join(' ')).toContain('Write');
  });

  it('budgetCapUsd 映射到 --max-budget-usd', () => {
    const args = buildArgs({ ...base, budgetCapUsd: 0.5 });
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.5');
  });
});
```

再写 `src/runner/claude-code-runner.timeout.test.ts`。用「忽略参数、永远睡下去」的可执行文件模拟实测到的那条永不退出路径：

```ts
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeRunner } from './claude-code-runner.js';
import type { RunRequest, RunnerEvent } from './types.js';

function makeHangingBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-hang-'));
  const bin = join(dir, 'fake-claude.sh');
  // 忽略所有参数，一直睡下去——复现「CLI 永不退出」
  writeFileSync(bin, '#!/bin/sh\nsleep 60\n');
  chmodSync(bin, 0o755);
  return bin;
}

const req: RunRequest = {
  runId: 'run_hang',
  prompt: 'p',
  systemPrompt: '',
  workdir: tmpdir(),
  model: 'sonnet',
  artifactType: 'code_diff',
  readOnly: false,
  wallTimeMs: 300,
};

describe('claude runner wall-clock 超时保护', () => {
  it('超过 wallTimeMs 时强制终止，退出码归一为 -1 并留下日志', async () => {
    const binPath = makeHangingBin();
    const logDir = mkdtempSync(join(tmpdir(), 'agentflow-hanglog-'));
    const runner = createClaudeCodeRunner({ binPath, logDir });

    const events: RunnerEvent[] = [];
    const startedAt = Date.now();
    for await (const e of runner.run(req)) events.push(e);
    const elapsed = Date.now() - startedAt;

    // 必须在远小于 sleep 60 的时间内结束
    expect(elapsed).toBeLessThan(5_000);
    expect(events.at(-1)).toEqual({ kind: 'exited', code: -1 });
    expect(
      events.some((e) => e.kind === 'log' && e.chunk.includes('wall-clock')),
    ).toBe(true);
  }, 10_000);
});
```

- [ ] **Step 6: 运行测试与类型检查**

Run: `npx vitest run src/runner && npx tsc --noEmit`
Expected: 全部 PASS，无类型错误。超时用例应在约 300ms 内结束，而不是等满 60 秒——**若它跑满 60 秒才结束，说明 kill 逻辑没生效，必须修实现**。

- [ ] **Step 7: 用 fixture 做一次契约回归**

新增 `src/runner/claude-code-runner.fixture.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStreamLine } from './claude-code-runner.js';

describe('claude stream-json 契约回归', () => {
  it('真实归档样本的每一行都能被解析，且 result 行的处理与 is_error 一致', () => {
    const raw = readFileSync(
      resolve(import.meta.dirname, '../../tests/fixtures/claude-stream-sample.jsonl'),
      'utf8',
    );
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);

    // 每一行都必须能被解析且不抛错（解析层不做字段白名单，未知字段一律容忍）
    let sawUsage = false;
    const kinds: string[] = [];
    for (const line of lines) {
      for (const e of parseStreamLine(line)) {
        kinds.push(e.kind);
        if (e.kind === 'usage') sawUsage = true;
      }
    }

    expect(sawUsage).toBe(true);

    // 归档样本是 claude 额度耗尽时的认证失败 result（is_error: true）。
    // 期望值从样本自身推导，而不是写死——这样将来补录到成功样本时本测试依然正确。
    const resultLine = lines.find((l) => {
      try {
        return (JSON.parse(l) as { type?: unknown }).type === 'result';
      } catch {
        return false;
      }
    });
    expect(resultLine).toBeDefined();

    const resultObj = JSON.parse(resultLine!) as { is_error?: unknown };

    if (resultObj.is_error === true) {
      expect(kinds).not.toContain('artifact');
      expect(kinds).toContain('log');
    } else {
      expect(kinds).toContain('artifact');
    }
  });
});
```

Run: `npx vitest run src/runner/claude-code-runner.fixture.test.ts`
Expected: PASS。**若失败，说明实现与真实归档输出不符——修实现，不要改 fixture。**

- [ ] **Step 7: 提交**

```bash
git add src/runner/claude-code-runner.ts src/runner/claude-code-runner.test.ts src/runner/claude-code-runner.fixture.test.ts tests/fixtures
git commit -m "feat: 新增 Claude Code Runner 适配器与流式解析"
```

---

## Task 11: 配置加载（角色与工作流）

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/loader.ts`
- Create: `src/config/loader.test.ts`
- Create: `config/workflows/simple_dev.yaml`
- Create: `config/roles/pm.yaml`
- Create: `config/roles/backend_dev.yaml`
- Create: `config/roles/qa_engineer.yaml`
- Create: `config/prompts/pm.md`
- Create: `config/prompts/backend_dev.md`
- Create: `config/prompts/qa_engineer.md`

**Interfaces:**
- Consumes: `RoleDef` / `WorkflowDef`（Task 3）
- Produces: `loadRole(configDir: string, roleId: string): RoleDef`、`loadWorkflow(configDir: string, workflowId: string): WorkflowDef`、`loadAllRoles(configDir: string): Map<string, RoleDef>`

- [ ] **Step 1: 创建 `config/prompts/pm.md`**

```markdown
你是一名资深产品经理。

你的职责：
1. 把用户的一句话需求，转写成可执行的需求文档
2. 明确划定「不做什么」，防止范围蔓延
3. 给出可被验证的验收标准

工作方式：
- 验收标准必须是可观测的行为，不要写"性能好"这类无法验证的描述
- 如果需求本身存在关键歧义，把 status 判为 blocked，并在 problem 里写清歧义点

输出要求：严格按给定的 JSON Schema 输出，不要附带额外说明文字。
```

- [ ] **Step 2: 创建 `config/prompts/backend_dev.md`**

```markdown
你是一名后端开发工程师。

你的职责：根据输入的需求文档，在指定工作区内完成实现。

工作方式：
- 先读需求文档的验收标准，再动手
- 只修改允许你修改的路径
- 完成后必须运行一次自测，并如实填写 self_test_result

输出要求：严格按给定的 JSON Schema 输出。files_changed 必须是真实改动过的文件的相对路径。
```

- [ ] **Step 3: 创建 `config/prompts/qa_engineer.md`**

```markdown
你是一名测试工程师。

你的职责：针对已实现的改动编写并运行测试，如实汇报结果。

工作方式：
- 先读需求文档的验收标准和代码改动
- 覆盖验收标准里的每一条
- 不要为了让测试通过而修改实现代码；发现缺陷就在 failures 里写清楚

输出要求：严格按给定的 JSON Schema 输出。passed 与 failed 必须来自真实运行结果，不允许估算。
```

- [ ] **Step 4: 创建 `config/roles/pm.yaml`**

```yaml
id: pm
display_name: 产品经理
system_prompt_ref: prompts/pm.md
inputs: []
outputs:
  - requirement
owns: []
reads:
  - "docs/**"
model: sonnet
max_retries: 2
max_wall_time_ms: 900000
```

- [ ] **Step 5: 创建 `config/roles/backend_dev.yaml`**

```yaml
id: backend_dev
display_name: 后端开发
system_prompt_ref: prompts/backend_dev.md
inputs:
  - requirement
outputs:
  - code_diff
owns:
  - "src/**"
reads:
  - "docs/**"
model: sonnet
max_retries: 2
max_wall_time_ms: 1800000
```

- [ ] **Step 6: 创建 `config/roles/qa_engineer.yaml`**

```yaml
id: qa_engineer
display_name: 测试工程师
system_prompt_ref: prompts/qa_engineer.md
inputs:
  - requirement
  - code_diff
outputs:
  - test_report
owns:
  - "tests/**"
reads:
  - "src/**"
  - "docs/**"
model: sonnet
max_retries: 1
max_wall_time_ms: 1800000
```

- [ ] **Step 7: 创建 `config/workflows/simple_dev.yaml`**

```yaml
id: simple_dev
start: pm_analyze
# 注意：Phase 1 所有节点 isolate 一律为 false。
# 原因：本阶段还没有"合并"能力，若 dev 在 worktree 里写代码，跑完 worktree 会被回收，
# 代码即丢失，随后 qa_verify（在主工作区运行）看不到任何改动，闭环就断了。
# worktree 隔离必须与合并能力一起引入，属于 Phase 2。
nodes:
  - id: pm_analyze
    title: 需求分析
    role: pm
    consumes: []
    produces: requirement
    isolate: false

  - id: dev_implement
    title: 编码实现
    role: backend_dev
    consumes:
      - requirement
    produces: code_diff
    isolate: false

  - id: qa_verify
    title: 测试验证
    role: qa_engineer
    consumes:
      - requirement
      - code_diff
    produces: test_report
    isolate: false

edges:
  - from: pm_analyze
    to: dev_implement
    when: "all(artifacts.requirement.status == 'ok')"

  - from: dev_implement
    to: qa_verify
    when: "all(artifacts.code_diff.status == 'ok')"
```

- [ ] **Step 8: 写失败的测试 `src/config/loader.test.ts`**

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAllRoles, loadRole, loadWorkflow } from './loader.js';

function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-cfg-'));
  mkdirSync(join(dir, 'roles'), { recursive: true });
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, 'prompts'), { recursive: true });

  writeFileSync(join(dir, 'prompts', 'pm.md'), '你是产品经理。');
  writeFileSync(
    join(dir, 'roles', 'pm.yaml'),
    [
      'id: pm',
      'display_name: 产品经理',
      'system_prompt_ref: prompts/pm.md',
      'inputs: []',
      'outputs:',
      '  - requirement',
      'owns: []',
      'reads:',
      '  - "docs/**"',
      'model: sonnet',
      'max_retries: 2',
      'max_wall_time_ms: 900000',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'workflows', 'simple_dev.yaml'),
    [
      'id: simple_dev',
      'start: pm_analyze',
      'nodes:',
      '  - id: pm_analyze',
      '    title: 需求分析',
      '    role: pm',
      '    consumes: []',
      '    produces: requirement',
      '    isolate: false',
      'edges: []',
    ].join('\n'),
  );
  return dir;
}

describe('loadRole', () => {
  it('加载角色并内联 system prompt 内容', () => {
    const dir = makeConfigDir();
    const role = loadRole(dir, 'pm');
    expect(role.id).toBe('pm');
    expect(role.displayName).toBe('产品经理');
    expect(role.systemPrompt).toBe('你是产品经理。');
    expect(role.outputs).toEqual(['requirement']);
  });

  it('角色文件不存在时抛出带路径的错误', () => {
    const dir = makeConfigDir();
    expect(() => loadRole(dir, 'nope')).toThrow(/nope\.yaml/);
  });

  it('prompt 文件不存在时抛出错误', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'roles', 'broken.yaml'),
      [
        'id: broken',
        'display_name: 坏角色',
        'system_prompt_ref: prompts/missing.md',
        'inputs: []',
        'outputs:',
        '  - requirement',
        'owns: []',
        'reads: []',
        'model: sonnet',
        'max_retries: 1',
        'max_wall_time_ms: 1000',
      ].join('\n'),
    );
    expect(() => loadRole(dir, 'broken')).toThrow(/missing\.md/);
  });

  it('YAML 结构非法时抛出校验错误', () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, 'roles', 'bad.yaml'), 'id: bad\ndisplay_name: 缺字段\n');
    expect(() => loadRole(dir, 'bad')).toThrow(/校验失败/);
  });
});

describe('loadWorkflow', () => {
  it('加载工作流并保留节点与边', () => {
    const dir = makeConfigDir();
    const wf = loadWorkflow(dir, 'simple_dev');
    expect(wf.start).toBe('pm_analyze');
    expect(wf.nodes).toHaveLength(1);
    expect(wf.nodes[0]?.produces).toBe('requirement');
  });

  it('start 指向不存在的节点时拒绝', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'workflows', 'bad.yaml'),
      ['id: bad', 'start: nope', 'nodes:', '  - id: a', '    title: A', '    role: pm', '    consumes: []', '    produces: requirement', '    isolate: false', 'edges: []'].join('\n'),
    );
    expect(() => loadWorkflow(dir, 'bad')).toThrow(/start/);
  });

  it('边指向不存在的节点时拒绝', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'workflows', 'bad2.yaml'),
      ['id: bad2', 'start: a', 'nodes:', '  - id: a', '    title: A', '    role: pm', '    consumes: []', '    produces: requirement', '    isolate: false', 'edges:', '  - from: a', '    to: ghost'].join('\n'),
    );
    expect(() => loadWorkflow(dir, 'bad2')).toThrow(/ghost/);
  });
});

describe('loadAllRoles', () => {
  it('加载目录下全部角色为 Map', () => {
    const dir = makeConfigDir();
    const roles = loadAllRoles(dir);
    expect([...roles.keys()]).toEqual(['pm']);
  });
});
```

- [ ] **Step 9: 运行测试，确认失败**

Run: `npx vitest run src/config/loader.test.ts`
Expected: FAIL —— 找不到模块 `./loader.js`

- [ ] **Step 10: 实现 `src/config/schema.ts`**

```ts
import { z } from 'zod';

export const RoleFileSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  system_prompt_ref: z.string().min(1),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()).min(1),
  owns: z.array(z.string()),
  reads: z.array(z.string()),
  model: z.string().min(1),
  max_retries: z.number().int().nonnegative().default(2),
  max_wall_time_ms: z.number().int().positive(),
});
export type RoleFile = z.infer<typeof RoleFileSchema>;

export const WorkflowNodeFileSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  role: z.string().min(1),
  consumes: z.array(z.string()),
  produces: z.string().min(1),
  isolate: z.boolean(),
});

export const WorkflowEdgeFileSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: z.string().optional(),
});

export const WorkflowFileSchema = z.object({
  id: z.string().min(1),
  start: z.string().min(1),
  nodes: z.array(WorkflowNodeFileSchema).min(1),
  edges: z.array(WorkflowEdgeFileSchema),
});
export type WorkflowFile = z.infer<typeof WorkflowFileSchema>;
```

- [ ] **Step 11: 实现 `src/config/loader.ts`**

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RoleDef, WorkflowDef } from '../shared/domain.js';
import { RoleFileSchema, WorkflowFileSchema } from './schema.js';

function readYaml(filePath: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`找不到${label}文件：${filePath}`);
  }
  try {
    return parseYaml(raw);
  } catch (error) {
    throw new Error(`${label}文件 YAML 解析失败：${filePath} —— ${(error as Error).message}`);
  }
}

/** 加载角色定义，并把 system prompt 文件内容内联进来 */
export function loadRole(configDir: string, roleId: string): RoleDef {
  const filePath = resolve(configDir, 'roles', `${roleId}.yaml`);
  const parsed = RoleFileSchema.safeParse(readYaml(filePath, '角色'));
  if (!parsed.success) {
    throw new Error(`角色配置校验失败：${filePath} —— ${parsed.error.message}`);
  }
  const file = parsed.data;

  const promptPath = resolve(configDir, file.system_prompt_ref);
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(promptPath, 'utf8').trim();
  } catch {
    throw new Error(`找不到角色提示词文件：${promptPath}`);
  }

  return {
    id: file.id,
    displayName: file.display_name,
    systemPrompt,
    inputs: file.inputs,
    outputs: file.outputs,
    owns: file.owns,
    reads: file.reads,
    model: file.model,
    maxWallTimeMs: file.max_wall_time_ms,
  };
}

/** 加载 config/roles 下全部角色 */
export function loadAllRoles(configDir: string): Map<string, RoleDef> {
  const rolesDir = resolve(configDir, 'roles');
  let entries: string[];
  try {
    entries = readdirSync(rolesDir);
  } catch {
    throw new Error(`找不到角色目录：${rolesDir}`);
  }
  const map = new Map<string, RoleDef>();
  for (const entry of entries.filter((e) => e.endsWith('.yaml')).sort()) {
    const roleId = entry.replace(/\.yaml$/, '');
    const role = loadRole(configDir, roleId);
    map.set(role.id, role);
  }
  return map;
}

/** 加载工作流定义，并校验 start 与所有边引用真实存在的节点 */
export function loadWorkflow(configDir: string, workflowId: string): WorkflowDef {
  const filePath = resolve(configDir, 'workflows', `${workflowId}.yaml`);
  const parsed = WorkflowFileSchema.safeParse(readYaml(filePath, '工作流'));
  if (!parsed.success) {
    throw new Error(`工作流配置校验失败：${filePath} —— ${parsed.error.message}`);
  }
  const file = parsed.data;
  const nodeIds = new Set(file.nodes.map((n) => n.id));

  if (!nodeIds.has(file.start)) {
    throw new Error(`工作流 ${workflowId} 的 start 指向不存在的节点：${file.start}`);
  }
  for (const edge of file.edges) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(`工作流 ${workflowId} 的边起点不存在：${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`工作流 ${workflowId} 的边终点不存在：${edge.to}`);
    }
  }

  return {
    id: file.id,
    start: file.start,
    nodes: file.nodes,
    edges: file.edges,
  };
}

/** 读取 prompts 目录下的文件（供调试与测试用） */
export function readPromptFile(configDir: string, ref: string): string {
  return readFileSync(join(configDir, ref), 'utf8').trim();
}
```

- [ ] **Step 12: 运行测试，确认通过**

Run: `npx vitest run src/config && npx tsc --noEmit`
Expected: 8 个测试 PASS，无类型错误

- [ ] **Step 13: 校验仓库内的真实配置能被正确加载**

新增 `src/config/real-config.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { loadAllRoles, loadWorkflow } from './loader.js';

const CONFIG_DIR = './config';

describe('仓库内的真实配置', () => {
  it('三个角色都能加载', () => {
    const roles = loadAllRoles(CONFIG_DIR);
    expect([...roles.keys()].sort()).toEqual(['backend_dev', 'pm', 'qa_engineer']);
    for (const role of roles.values()) {
      expect(role.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  it('simple_dev 工作流能加载且节点角色都存在', () => {
    const workflow = loadWorkflow(CONFIG_DIR, 'simple_dev');
    const roles = loadAllRoles(CONFIG_DIR);
    expect(workflow.nodes).toHaveLength(3);
    for (const node of workflow.nodes) {
      expect(roles.has(node.role)).toBe(true);
    }
  });
});
```

Run: `npx vitest run src/config/real-config.test.ts`
Expected: 2 个测试 PASS

- [ ] **Step 14: 提交**

```bash
git add src/config config
git commit -m "feat: 新增角色与工作流配置加载"
```

---

## Task 12: 调度器与内核主循环

**Files:**
- Create: `src/kernel/scheduler.ts`
- Create: `src/kernel/kernel.ts`
- Create: `src/kernel/kernel.test.ts`

**Interfaces:**
- Consumes: `EventStore`（Task 4）；`project` / `TaskState`（Task 5）；`buildFacts`（Task 6）；`decideNext` / `Decision`（Task 7）；`AgentRunner`（Task 8）；`assemblePrompt`（Task 9）；`parseArtifactPayload` / `jsonSchemaForArtifact`（Task 3）；`RoleDef` / `WorkflowDef`（Task 3）
- Produces:
  - `createKernel(deps): Kernel`，`Kernel = { runTask(taskId: string): Promise<TaskState>; startTask(input): string; getState(taskId: string): TaskState }`
  - `KernelDeps = { store: EventStore; runner: AgentRunner; workflow: WorkflowDef; roles: Map<string, RoleDef>; maxPromptTokens: number; workspaceRoot: string; maxSteps: number }`

**主循环（每次迭代做一件事）**

1. `project(store.readTask(taskId))` → `state`
2. `decideNext` → `Decision`
3. 若 `start` → 装配 prompt、spawn runner、收集产出、追加事件
4. 若 `end` → 追加 `task.completed` 或 `task.failed`，返回
5. 若 `wait` → 直接返回当前状态（Phase 1 串行，不会出现）
6. 迭代次数超过 `maxSteps` → 追加 `task.failed` 并返回

- [ ] **Step 1: 实现 `src/kernel/scheduler.ts`**

**关于本步骤不走"先写测试"的说明**：`scheduler.ts` 是一层 git 命令包装（`git worktree add` / `remove`）加上非 git 仓库的退化路径，本身不含业务决策逻辑。

**同时注意一个诚实的事实**：Phase 1 的 `simple_dev.yaml` 里所有节点都是 `isolate: false`（见 Task 11 的说明），所以 `createWorktree` 那条分支**在本阶段的集成测试里不会被走到**。它现在是为 Phase 2 预置的骨架。若你希望它在 Phase 1 就被验证，可在本步骤前补一个专门的单测：在临时目录 `git init` + 一次提交，然后断言 `prepareWorkspace({isolate: true})` 返回 `createdWorktree === true` 且目录存在。

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId } from '../shared/ids.js';

export type Workspace = {
  runId: string;
  path: string;
  /** 是否为该节点新建的 git worktree */
  createdWorktree: boolean;
};

/**
 * 为一次节点执行准备工作区。
 * isolate=true 时优先创建 git worktree；仓库不可用（非 git 仓库、无提交）时退化为运行目录下的独立子目录。
 */
export function prepareWorkspace(input: {
  workspaceRoot: string;
  repoPath: string;
  isolate: boolean;
  taskId: string;
  nodeId: string;
}): Workspace {
  const runId = newId('run');
  mkdirSync(input.workspaceRoot, { recursive: true });

  if (!input.isolate) {
    return { runId, path: input.repoPath, createdWorktree: false };
  }

  const worktreePath = resolve(input.workspaceRoot, `${input.taskId}-${input.nodeId}-${runId}`);
  const branch = `agentflow/${input.taskId}/${input.nodeId}/${runId}`;

  let isGitRepo = false;
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: input.repoPath,
      stdio: 'pipe',
    });
    isGitRepo = true;
  } catch {
    isGitRepo = false;
  }

  if (!isGitRepo) {
    mkdirSync(worktreePath, { recursive: true });
    return { runId, path: worktreePath, createdWorktree: false };
  }

  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], {
      cwd: input.repoPath,
      stdio: 'pipe',
    });
    return { runId, path: worktreePath, createdWorktree: true };
  } catch {
    // worktree 创建失败（例如仓库还没有任何提交）时退化为独立目录
    mkdirSync(worktreePath, { recursive: true });
    return { runId, path: worktreePath, createdWorktree: false };
  }
}

/** 回收 worktree；失败不抛错，只返回 false */
export function releaseWorkspace(ws: Workspace, repoPath: string): boolean {
  if (!ws.createdWorktree) return true;
  if (!existsSync(ws.path)) return true;
  try {
    execFileSync('git', ['worktree', 'remove', '--force', ws.path], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: 写失败的测试 `src/kernel/kernel.test.ts`**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKernel } from './kernel.js';
import { createEventStore } from './event-store.js';
import { createFakeRunner, type FakeScriptItem } from '../runner/fake-runner.js';
import type { RoleDef, WorkflowDef } from '../shared/domain.js';

const workflow: WorkflowDef = {
  id: 'simple_dev',
  start: 'pm_analyze',
  nodes: [
    { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
    { id: 'dev_implement', title: '编码实现', role: 'backend_dev', consumes: ['requirement'], produces: 'code_diff', isolate: false },
    { id: 'qa_verify', title: '测试验证', role: 'qa_engineer', consumes: ['requirement', 'code_diff'], produces: 'test_report', isolate: false },
  ],
  edges: [
    { from: 'pm_analyze', to: 'dev_implement', when: "all(artifacts.requirement.status == 'ok')" },
    { from: 'dev_implement', to: 'qa_verify', when: "all(artifacts.code_diff.status == 'ok')" },
  ],
};

function roles(): Map<string, RoleDef> {
  const make = (id: string, outputs: string[], owns: string[]): RoleDef => ({
    id,
    displayName: id,
    systemPrompt: `你是 ${id}`,
    inputs: [],
    outputs,
    owns,
    reads: [],
    model: 'sonnet',
    maxWallTimeMs: 60_000,
  });
  return new Map([
    ['pm', make('pm', ['requirement'], [])],
    ['backend_dev', make('backend_dev', ['code_diff'], ['src/**'])],
    ['qa_engineer', make('qa_engineer', ['test_report'], ['tests/**'])],
  ]);
}

const ARTIFACTS: Record<string, unknown> = {
  requirement: {
    problem: '多角色无法自动流转',
    goals: ['实现自动流转'],
    non_goals: ['不做分布式'],
    acceptance_criteria: ['一个需求输入后三角色自动完成'],
  },
  code_diff: {
    wp_id: 'wp1',
    branch: 'main',
    files_changed: ['src/a.ts'],
    insertions: 10,
    deletions: 2,
    self_test_result: 'passed',
    notes: '已自测',
  },
  test_report: { wp_id: 'wp1', suites: ['unit'], passed: 5, failed: 0, failures: [] },
};

function scriptFor(artifactType: string): FakeScriptItem[] {
  return [
    { kind: 'log', chunk: `开始执行 ${artifactType}` },
    { kind: 'artifact', raw: ARTIFACTS[artifactType] },
    { kind: 'usage', tokensIn: 100, tokensOut: 50, costUsd: 0.01 },
    { kind: 'exited', code: 0 },
  ];
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-repo-'));
  writeFileSync(join(dir, 'README.md'), '# 测试仓库\n');
  return dir;
}

function makeKernel(scripts: FakeScriptItem[][] | undefined, repoPath: string, logDir: string) {
  const store = createEventStore(':memory:');
  const runner = createFakeRunner(
    scripts
      ? { scripts }
      : {
          scripts: [
            scriptFor('requirement'),
            scriptFor('code_diff'),
            scriptFor('test_report'),
          ],
        },
  );
  const kernel = createKernel({
    store,
    runner,
    workflow,
    roles: roles(),
    maxPromptTokens: 30_000,
    workspaceRoot: join(repoPath, '.agentflow-ws'),
    logDir,
    repoPath,
    maxSteps: 20,
  });
  return { kernel, store, runner };
}

describe('Kernel 串行闭环', () => {
  it('三个角色自动流转完成，任务状态为 completed', async () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({
      title: '自动流转',
      requirementRaw: '让多角色自动流转',
      baseBranch: 'main',
    });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('completed');
    expect(state.completedNodeIds).toEqual(['pm_analyze', 'dev_implement', 'qa_verify']);
    store.close();
  });

  it('产出 3 个 Artifact，类型与节点对应', async () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.artifacts.map((a) => a.type).sort()).toEqual([
      'code_diff',
      'requirement',
      'test_report',
    ]);
    store.close();
  });

  it('事件库能完整重放出相同状态', async () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const live = await kernel.runTask(taskId);
    const replayed = kernel.getState(taskId);

    expect(replayed).toEqual(live);
    expect(store.readTask(taskId).length).toBeGreaterThan(8);
    store.close();
  });

  it('记录了每一步转移的理由与决策来源', async () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.transfers.map((t) => `${t.from}→${t.to}`)).toEqual([
      '→pm_analyze',
      'pm_analyze→dev_implement',
      'dev_implement→qa_verify',
    ]);
    expect(state.transfers.every((t) => t.decidedBy === 'rule')).toBe(true);
    store.close();
  });

  it('runner 收到的工作目录、只读标记与产出 schema 正确', async () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store, runner } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    await kernel.runTask(taskId);

    expect(runner.requests).toHaveLength(3);
    expect(runner.requests[0]?.artifactType).toBe('requirement');
    expect(runner.requests[0]?.readOnly).toBe(true);
    expect(runner.requests[0]?.outputSchema).toBeDefined();
    expect(runner.requests[1]?.readOnly).toBe(false);
    store.close();
  });

  it('节点失败时任务标记为 failed，且不继续推进', async () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store } = makeKernel(
      [
        scriptFor('requirement'),
        [{ kind: 'log', chunk: '编译报错' }, { kind: 'exited', code: 1 }],
      ],
      repo,
      logs,
    );

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('failed');
    expect(state.nodes.dev_implement?.status).toBe('failed');
    expect(state.completedNodeIds).toEqual(['pm_analyze']);
    store.close();
  });

  it('产出载荷不合规时该节点失败', async () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store } = makeKernel(
      [
        [{ kind: 'artifact', raw: { problem: 123 } }, { kind: 'exited', code: 0 }],
      ],
      repo,
      logs,
    );

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);
    expect(state.nodes.pm_analyze?.status).toBe('failed');
    store.close();
  });

  it('产出不合规载荷时任务以 failed 收尾，且不调用后续 runner', async () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    // pm 产出缺字段的 requirement：载荷校验失败 → 节点失败 → 任务失败 → 不推进到 dev_implement
    const { kernel, store, runner } = makeKernel(
      [[{ kind: 'artifact', raw: { problem: '' } }, { kind: 'exited', code: 0 }]],
      repo,
      logs,
    );

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);
    expect(state.status).toBe('failed');
    expect(runner.requests).toHaveLength(1);
    store.close();
  });

  it('原始日志写入 logs 目录，事件库里只有引用不含日志正文', async () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    await kernel.runTask(taskId);

    const events = store.readTask(taskId);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('开始执行 requirement');

    const logFiles = JSON.stringify(events).match(/logs\/runs\/[^"]+\.jsonl/g);
    expect(logFiles).not.toBeNull();
    store.close();
  });

  it('自环工作流被死循环保护终止，不会无限重试', async () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const store = createEventStore(':memory:');
    // 让 pm 每次都成功，但工作流里加一条 pm→pm 的自环，触发节点访问次数保护
    const loopWorkflow: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'pm_analyze', to: 'pm_analyze', when: 'true' }],
    };
    const runner = createFakeRunner({
      scripts: Array.from({ length: 30 }, () => scriptFor('requirement')),
    });
    const kernel = createKernel({
      store,
      runner,
      workflow: loopWorkflow,
      roles: roles(),
      maxPromptTokens: 30_000,
      workspaceRoot: join(repo, '.agentflow-ws'),
      logDir: logs,
      repoPath: repo,
      maxSteps: 50,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('failed');
    // 失败原因记录在 task.failed 事件里（transfers 只记录成功的转移）
    const failedEvent = kernel
      .getEvents(taskId)
      .find((e) => e.type === 'task.failed');
    expect(String(failedEvent?.payload['reason'])).toContain('访问次数');
    // 只跑了 3 次就被拦住，不是无限重试
    expect(runner.requests).toHaveLength(3);
    store.close();
  });
});

describe('Task 创建的元数据落库', () => {
  it('task.created 事件包含标题与原始需求', () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store } = makeKernel(undefined, repo, logs);
    const taskId = kernel.startTask({ title: 'A', requirementRaw: 'B', baseBranch: 'dev' });
    const [first] = store.readTask(taskId);
    expect(first?.type).toBe('task.created');
    expect(first?.payload['title']).toBe('A');
    expect(first?.payload['requirement_raw']).toBe('B');
    expect(first?.payload['base_branch']).toBe('dev');
    store.close();
  });

  it('getEvents 返回按 seq 升序的真实事件', () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store } = makeKernel(undefined, repo, logs);
    const taskId = kernel.startTask({ title: 'A', requirementRaw: 'B', baseBranch: 'main' });
    const events = kernel.getEvents(taskId);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    expect(events[0]?.type).toBe('task.created');
    store.close();
  });

  it('getState 对未知任务抛错', () => {
    const repo = makeRepo();
    const logs = mkdtempSync(join(tmpdir(), 'agentflow-logs-'));
    const { kernel, store } = makeKernel(undefined, repo, logs);
    expect(() => kernel.getState('task_nope')).toThrow(/task_nope/);
    store.close();
  });
});
```

同时把 `readFileSync` 与 `mkdirSync` 从测试文件顶部的 import 中删掉（未被使用）。

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run src/kernel/kernel.test.ts`
Expected: FAIL —— 找不到模块 `./kernel.js`

- [ ] **Step 4: 实现 `src/kernel/kernel.ts`**

```ts
import { join } from 'node:path';
import { jsonSchemaForArtifact, parseArtifactPayload, type ArtifactType } from '../shared/artifacts.js';
import { newId } from '../shared/ids.js';
import type { KernelEvent } from '../shared/events.js';
import type { RoleDef, WorkflowDef } from '../shared/domain.js';
import type { AgentRunner, RunnerEvent } from '../runner/types.js';
import { assemblePrompt } from './context-assembler.js';
import type { EventStore } from './event-store.js';
import { buildFacts } from './facts.js';
import { project, type TaskState } from './projector.js';
import { prepareWorkspace, releaseWorkspace } from './scheduler.js';
import { decideNext } from './state-machine.js';

export type KernelDeps = {
  store: EventStore;
  runner: AgentRunner;
  workflow: WorkflowDef;
  roles: Map<string, RoleDef>;
  maxPromptTokens: number;
  workspaceRoot: string;
  logDir: string;
  repoPath: string;
  maxSteps: number;
};

export type StartTaskInput = {
  title: string;
  requirementRaw: string;
  baseBranch: string;
};

export type Kernel = {
  startTask(input: StartTaskInput): string;
  getState(taskId: string): TaskState;
  getEvents(taskId: string): KernelEvent[];
  runTask(taskId: string): Promise<TaskState>;
};

export function createKernel(deps: KernelDeps): Kernel {
  const { store, workflow, roles } = deps;

  function getState(taskId: string): TaskState {
    const events = store.readTask(taskId);
    if (events.length === 0) {
      throw new Error(`找不到任务：${taskId}`);
    }
    return project(events);
  }

  function getEvents(taskId: string): KernelEvent[] {
    return store.readTask(taskId);
  }

  function startTask(input: StartTaskInput): string {
    const taskId = newId('task');
    store.append({
      task_id: taskId,
      type: 'task.created',
      payload: {
        title: input.title,
        requirement_raw: input.requirementRaw,
        base_branch: input.baseBranch,
      },
      actor: 'human',
    });
    return taskId;
  }

  async function runTask(taskId: string): Promise<TaskState> {
    let steps = 0;

    for (;;) {
      if (steps >= deps.maxSteps) {
        store.append({
          task_id: taskId,
          type: 'task.failed',
          payload: { reason: `超过最大步数 ${deps.maxSteps}，判定为死循环` },
          actor: 'kernel',
        });
        return getState(taskId);
      }
      steps += 1;

      const state = getState(taskId);
      if (state.status !== 'active') {
        return state;
      }

      const facts = buildFacts({ state, workflow, roles });
      const decision = decideNext({ workflow, state, facts });

      if (decision.kind === 'wait') {
        return state;
      }
      if (decision.kind === 'end') {
        store.append({
          task_id: taskId,
          type: decision.status === 'completed' ? 'task.completed' : 'task.failed',
          payload: { reason: decision.reason },
          actor: 'kernel',
        });
        return getState(taskId);
      }

      await runNode(taskId, decision.nodeId, decision.reason);
    }
  }

  async function runNode(taskId: string, nodeId: string, reason: string): Promise<void> {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: { reason: `节点 ${nodeId} 不在工作流定义中` },
        actor: 'kernel',
      });
      return;
    }

    const role = roles.get(node.role);
    if (!role) {
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: { reason: `节点 ${nodeId} 引用了未注册的角色 ${node.role}` },
        actor: 'kernel',
      });
      return;
    }

    const stateBefore = getState(taskId);
    const ws = prepareWorkspace({
      workspaceRoot: deps.workspaceRoot,
      repoPath: deps.repoPath,
      isolate: node.isolate,
      taskId,
      nodeId,
    });

    const previousVisit = stateBefore.visitCounts[nodeId] ?? 0;

    store.append({
      task_id: taskId,
      type: 'transfer.decided',
      payload: { from: stateBefore.transfers.at(-1)?.to ?? '', to: nodeId, reason, decided_by: 'rule' },
      actor: 'kernel',
    });

    store.append({
      task_id: taskId,
      type: 'node.queued',
      payload: { node_id: nodeId, role_id: role.id, run_id: ws.runId, attempt: previousVisit + 1 },
      actor: 'kernel',
    });

    const assembled = assemblePrompt({
      role,
      node,
      state: stateBefore,
      worktreePath: ws.path,
      maxPromptTokens: deps.maxPromptTokens,
    });

    store.append({
      task_id: taskId,
      type: 'node.started',
      payload: { node_id: nodeId, role_id: role.id, run_id: ws.runId, attempt: previousVisit + 1 },
      actor: `role:${role.id}`,
    });

    const logRef = join(deps.logDir.replace(/^\.\//, ''), 'runs', `${ws.runId}.jsonl`);

    let artifactRaw: unknown;
    let hasArtifact = false;
    let exitCode: number | null = null;
    const errorLines: string[] = [];

    const readOnly = role.owns.length === 0;

    try {
      for await (const event of deps.runner.run({
        runId: ws.runId,
        prompt: assembled.prompt,
        systemPrompt: assembled.systemPrompt,
        workdir: ws.path,
        model: role.model,
        outputSchema: jsonSchemaForArtifact(node.produces as ArtifactType),
        artifactType: node.produces as ArtifactType,
        readOnly,
        wallTimeMs: role.maxWallTimeMs,
      })) {
        handleEvent(event);
      }
    } catch (error) {
      errorLines.push(`runner 抛出异常：${(error as Error).message}`);
      exitCode = -1;
    }

    function handleEvent(event: RunnerEvent): void {
      switch (event.kind) {
        case 'usage':
          store.append({
            task_id: taskId,
            type: 'node.usage_recorded',
            payload: {
              node_id: nodeId,
              run_id: ws.runId,
              tokens_in: event.tokensIn,
              tokens_out: event.tokensOut,
              cost_usd: event.costUsd,
            },
            actor: 'kernel',
          });
          store.append({
            task_id: taskId,
            type: 'budget.consumed',
            payload: { run_id: ws.runId, cost_usd: event.costUsd },
            actor: 'kernel',
          });
          break;
        case 'artifact':
          artifactRaw = event.raw;
          hasArtifact = true;
          break;
        case 'log':
          if (errorLines.length < 20 && /错误|失败|error|failed/i.test(event.chunk)) {
            errorLines.push(event.chunk.slice(0, 500));
          }
          break;
        case 'exited':
          exitCode = event.code;
          break;
        case 'started':
          break;
        default: {
          const exhaustive: never = event;
          throw new Error(`未处理的 RunnerEvent：${JSON.stringify(exhaustive)}`);
        }
      }
    }

    releaseWorkspace(ws, deps.repoPath);

    if (exitCode !== 0) {
      store.append({
        task_id: taskId,
        type: 'node.failed',
        payload: {
          node_id: nodeId,
          run_id: ws.runId,
          error: `CLI 退出码 ${exitCode}${errorLines.length > 0 ? `：${errorLines.join(' / ')}` : ''}`,
          log_ref: logRef,
        },
        actor: 'kernel',
      });
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: { reason: `节点 ${nodeId} 执行失败` },
        actor: 'kernel',
      });
      return;
    }

    if (!hasArtifact) {
      store.append({
        task_id: taskId,
        type: 'node.failed',
        payload: {
          node_id: nodeId,
          run_id: ws.runId,
          error: `未产出任何结构化结果（期望类型 ${node.produces}）`,
          log_ref: logRef,
        },
        actor: 'kernel',
      });
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: { reason: `节点 ${nodeId} 未产出结构化结果` },
        actor: 'kernel',
      });
      return;
    }

    let payload: unknown;
    try {
      payload = parseArtifactPayload(node.produces as ArtifactType, artifactRaw);
    } catch (error) {
      store.append({
        task_id: taskId,
        type: 'node.failed',
        payload: {
          node_id: nodeId,
          run_id: ws.runId,
          error: (error as Error).message,
          log_ref: logRef,
        },
        actor: 'kernel',
      });
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: { reason: `节点 ${nodeId} 产出载荷不合规` },
        actor: 'kernel',
      });
      return;
    }

    store.append({
      task_id: taskId,
      type: 'artifact.created',
      payload: {
        artifact_id: newId('art'),
        run_id: ws.runId,
        node_id: nodeId,
        type: node.produces,
        status: 'ok',
        schema_version: 1,
        payload,
        refs: [],
        summary: buildSummary(node.produces as ArtifactType, payload),
      },
      actor: `role:${role.id}`,
    });

    store.append({
      task_id: taskId,
      type: 'node.succeeded',
      payload: { node_id: nodeId, run_id: ws.runId, log_ref: logRef },
      actor: 'kernel',
    });
  }

  return { startTask, getState, getEvents, runTask };
}

/** 从载荷里抽取一段短摘要，作为唯一进入下游 prompt 的产物内容 */
function buildSummary(type: ArtifactType, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  if (type === 'requirement') {
    const goals = Array.isArray(p['goals']) ? (p['goals'] as string[]) : [];
    return `问题：${String(p['problem'] ?? '')}；目标：${goals.join('；')}`.slice(0, 1500);
  }
  if (type === 'code_diff') {
    const files = Array.isArray(p['files_changed']) ? (p['files_changed'] as string[]) : [];
    return `分支 ${String(p['branch'] ?? '')}，改动 ${files.length} 个文件，自测：${String(p['self_test_result'] ?? '')}`.slice(0, 1500);
  }
  if (type === 'test_report') {
    return `通过 ${String(p['passed'] ?? 0)}，失败 ${String(p['failed'] ?? 0)}`.slice(0, 1500);
  }
  return JSON.stringify(payload).slice(0, 1500);
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run src/kernel/kernel.test.ts`
Expected: 13 个测试 PASS

- [ ] **Step 6: 运行全部测试与类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS，无类型错误

- [ ] **Step 7: 提交**

```bash
git add src/kernel/scheduler.ts src/kernel/kernel.ts src/kernel/kernel.test.ts
git commit -m "feat: 新增调度器与内核主循环，实现三角色串行闭环"
```

---

## Task 13: HTTP + WebSocket 服务

**Files:**
- Create: `src/server/server.ts`
- Create: `src/server/server.test.ts`
- Create: `src/main.ts`

**Interfaces:**
- Consumes: `Kernel`（Task 12）；`AppEnv`（Task 1）
- Produces: `createServer(deps): { app: FastifyInstance; close(): Promise<void> }`

**HTTP 端点**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/tasks` | 创建任务，body `{ title, requirementRaw, baseBranch? }`，返回 `{ taskId }`，并**异步**启动 `runTask` |
| `GET` | `/api/tasks` | 列出全部任务（从事件库聚合） |
| `GET` | `/api/tasks/:taskId` | 返回该任务的投影状态 |
| `GET` | `/api/tasks/:taskId/events` | 返回该任务的原始事件流 |
| `GET` | `/api/health` | 健康检查 |
| `WS` | `/ws` | 推送 `{ type: 'event', event }` 与 `{ type: 'task_state', state }` |

- [ ] **Step 1: 写失败的测试 `src/server/server.test.ts`**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import { createEventStore } from '../kernel/event-store.js';
import { createKernel } from '../kernel/kernel.js';
import { createFakeRunner, type FakeScriptItem } from '../runner/fake-runner.js';
import type { RoleDef, WorkflowDef } from '../shared/domain.js';

const workflow: WorkflowDef = {
  id: 'simple_dev',
  start: 'pm_analyze',
  nodes: [
    { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
  ],
  edges: [],
};

function role(): RoleDef {
  return {
    id: 'pm',
    displayName: '产品经理',
    systemPrompt: '你是产品经理',
    inputs: [],
    outputs: ['requirement'],
    owns: [],
    reads: [],
    model: 'sonnet',
    maxWallTimeMs: 60_000,
  };
}

const REQUIREMENT = {
  problem: 'p',
  goals: ['g'],
  non_goals: [],
  acceptance_criteria: ['a'],
};

let closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  // POST /api/tasks 会异步触发 runTask；等它落地再关服务与事件库，
  // 否则出现"数据库已关闭"的偶发失败
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const close of closers) await close();
  closers = [];
});

function boot() {
  const repo = mkdtempSync(join(tmpdir(), 'agentflow-repo-'));
  writeFileSync(join(repo, 'README.md'), '# x\n');
  const store = createEventStore(':memory:');
  const runner = createFakeRunner({
    scripts: [[{ kind: 'artifact', raw: REQUIREMENT }, { kind: 'exited', code: 0 }] as FakeScriptItem[]],
  });
  const kernel = createKernel({
    store,
    runner,
    workflow,
    roles: new Map([['pm', role()]]),
    maxPromptTokens: 30_000,
    workspaceRoot: join(repo, '.ws'),
    logDir: join(repo, 'logs'),
    repoPath: repo,
    maxSteps: 5,
  });
  const server = createServer({ kernel, host: '127.0.0.1', port: 0 });
  closers.push(async () => {
    await server.close();
    store.close();
  });
  return { server, kernel };
}

/**
 * 通过 HTTP 创建任务并返回 taskId。
 * 必须走 POST：只有它会在服务层登记 knownTaskIds / taskSummaries，
 * 直接用 kernel.startTask 建出来的任务，HTTP 读取接口一律返回 404。
 */
async function postTask(
  server: ReturnType<typeof boot>['server'],
  title = '自动流转',
): Promise<string> {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { title, requirementRaw: '让角色自动流转' },
  });
  return (res.json() as { taskId: string }).taskId;
}

describe('HTTP API', () => {
  it('health 返回 ok', async () => {
    const { server } = boot();
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('POST /api/tasks 创建任务并返回 taskId', async () => {
    const { server } = boot();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: '自动流转', requirementRaw: '让角色自动流转' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ taskId: expect.stringMatching(/^task_/) });
  });

  it('缺少必填字段时返回 400', async () => {
    const { server } = boot();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: '只有标题' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/tasks/:id 返回投影状态', async () => {
    const { server } = boot();
    const taskId = await postTask(server);
    const res = await server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ taskId });
  });

  it('GET 未知任务返回 404', async () => {
    const { server } = boot();
    const res = await server.app.inject({ method: 'GET', url: '/api/tasks/task_ghost' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/tasks/:id/events 返回原始事件流', async () => {
    const { server } = boot();
    const taskId = await postTask(server);
    const res = await server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/events` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ type: string }> };
    expect(body.events[0]?.type).toBe('task.created');
    expect(body.events.length).toBeGreaterThan(1);
  });

  it('GET /api/tasks 返回任务列表', async () => {
    const { server } = boot();
    await postTask(server, 'A');
    const res = await server.app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<{ title: string }> };
    expect(body.tasks.map((t) => t.title)).toEqual(['A']);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/server.test.ts`
Expected: FAIL —— 找不到模块 `./server.js`

- [ ] **Step 3: 实现 `src/server/server.ts`**

```ts
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Kernel } from '../kernel/kernel.js';

const CreateTaskSchema = z.object({
  title: z.string().min(1),
  requirementRaw: z.string().min(1),
  baseBranch: z.string().min(1).default('main'),
});

export type ServerDeps = {
  kernel: Kernel;
  host: string;
  port: number;
};

export type AgentFlowServer = {
  app: FastifyInstance;
  close(): Promise<void>;
};

type PushSocket = { send(data: string): void; readyState: number };

export function createServer(deps: ServerDeps): AgentFlowServer {
  const app = Fastify({ logger: false });
  const sockets = new Set<PushSocket>();
  const knownTaskIds = new Set<string>();
  const taskSummaries = new Map<string, { taskId: string; title: string; status: string }>();

  function broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  app.register(websocket);

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/tasks', async (request, reply) => {
    const parsed = CreateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: '请求体不合法', detail: parsed.error.message });
    }

    const taskId = deps.kernel.startTask(parsed.data);
    knownTaskIds.add(taskId);
    taskSummaries.set(taskId, { taskId, title: parsed.data.title, status: 'active' });

    // 异步推进任务，不阻塞 HTTP 响应
    void deps.kernel
      .runTask(taskId)
      .then((state) => {
        const summary = taskSummaries.get(taskId);
        if (summary) summary.status = state.status;
        broadcast({ type: 'task_state', state });
      })
      .catch((error: unknown) => {
        broadcast({ type: 'task_error', taskId, message: (error as Error).message });
      });

    return reply.status(201).send({ taskId });
  });

  app.get('/api/tasks', async () => ({ tasks: [...taskSummaries.values()] }));

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (!knownTaskIds.has(taskId)) {
      return reply.status(404).send({ error: `找不到任务：${taskId}` });
    }
    return deps.kernel.getState(taskId);
  });

  app.get('/api/tasks/:taskId/events', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (!knownTaskIds.has(taskId)) {
      return reply.status(404).send({ error: `找不到任务：${taskId}` });
    }
    return { events: deps.kernel.getEvents(taskId) };
  });

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      const s = socket as unknown as PushSocket;
      sockets.add(s);
      socket.on('close', () => sockets.delete(s));
    });
  });

  return {
    app,
    async close(): Promise<void> {
      await app.close();
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/server src/kernel/kernel.test.ts && npx tsc --noEmit`
Expected: 全部 PASS，无类型错误

- [ ] **Step 5: 创建 `src/main.ts`**

```ts
import { resolve } from 'node:path';
import { loadEnv } from './config/env.js';
import { loadAllRoles, loadWorkflow } from './config/loader.js';
import { createEventStore } from './kernel/event-store.js';
import { createKernel } from './kernel/kernel.js';
import { createClaudeCodeRunner } from './runner/claude-code-runner.js';
import { createServer } from './server/server.js';

const env = loadEnv();

const roles = loadAllRoles(env.configDir);
const workflow = loadWorkflow(env.configDir, 'simple_dev');
const store = createEventStore(resolve(env.dbPath));
const runner = createClaudeCodeRunner({
  binPath: env.claudeBin,
  logDir: resolve(env.logDir, 'runs'),
});

const kernel = createKernel({
  store,
  runner,
  workflow,
  roles,
  maxPromptTokens: env.maxPromptTokens,
  workspaceRoot: resolve(env.workspaceDir),
  logDir: resolve(env.logDir),
  repoPath: process.cwd(),
  maxSteps: 50,
});

const server = createServer({ kernel, host: env.host, port: env.port });

await server.app.listen({ host: env.host, port: env.port });
console.log(`AgentFlow 已启动：http://${env.host}:${env.port}`);

const shutdown = async (): Promise<void> => {
  await server.close();
  store.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
```

- [ ] **Step 6: 手工冒烟验证服务能起来（⚠️ 不要触发真实 agent）**

**先读这条警告**：`main.ts` 接的是 `createClaudeCodeRunner`，`repoPath` 是 `process.cwd()`，而 `simple_dev` 的 `dev_implement` 节点 `owns` 非空 → 内核会把它判为**可写**角色 → runner 给它的权限是 `--permission-mode acceptEdits --tools=...,Edit,Write,Bash`，**且 cwd 就是本项目根目录**。也就是说：**一次 `POST /api/tasks` 会真的启动全链路 agent，并可能直接改写本仓库的工作区文件**，同时真实消耗额度。

因此冒烟**只验证服务层**，不要走真实 agent。用 `AGENTFLOW_CLAUDE_BIN` 指向一个不存在的可执行文件，让真实调用必然失败（spawn error 路径）——这样既不花钱，也不会让 agent 碰到工作区：

```bash
AGENTFLOW_CLAUDE_BIN=/nonexistent/claude npx tsx src/main.ts &
sleep 2
curl -s http://127.0.0.1:8787/api/health
# 缺必填字段：必须返回 400（这条不会建任务、不会触发 agent）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/api/tasks \
  -H 'Content-Type: application/json' -d '{"title":"只有标题"}'
kill %1
```

Expected: `/api/health` 返回 `{"ok":true}`；缺字段的 POST 返回 `400`。

**若你确实想验证「建任务 → 异步推进」这条路**，请**同时**做三件事：① 在**一个临时空 git 仓库**里跑（不要在本项目根目录）② 设 `AGENTFLOW_CLAUDE_BIN=/nonexistent/claude` 使真实调用必失败（验证的是「失败被正确记录为 node.failed」，不是真实产出）③ 确认 `git status` 干净。

**真实端到端（会花钱、会动文件）只在 Task 15 做**，且必须在受控目标仓库里进行。

- [ ] **Step 7: 提交**

```bash
git add src/server src/main.ts src/kernel/kernel.ts src/kernel/kernel.test.ts
git commit -m "feat: 新增 HTTP 与 WebSocket 服务及进程入口"
```

---

## Task 14: 极简观测页面

**Files:**
- Create: `web/package.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`
- Create: `web/tsconfig.json`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/api.ts`
- Create: `web/src/styles.css`

**Interfaces:**
- Consumes: Task 13 的 HTTP API 与 `/ws`
- Produces: 可在浏览器打开的任务列表 + 任务详情（节点流转时间线）页面

- [ ] **Step 1: 创建 `web/package.json`**

```json
{
  "name": "agentflow-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: 创建 `web/vite.config.ts`**

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
```

- [ ] **Step 3: 创建 `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 4: 创建 `web/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AgentFlow 观测台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 创建 `web/src/styles.css`**

```css
:root {
  --bg: #0f1115;
  --panel: #171a21;
  --line: #262b36;
  --text: #e6e9ef;
  --muted: #8b93a3;
  --running: #f0a020;
  --ok: #35c46a;
  --fail: #e5484d;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, "SF Pro SC", "PingFang SC", system-ui, sans-serif;
  font-size: 14px;
}

.layout { display: grid; grid-template-columns: 320px 1fr; height: 100vh; }

.sidebar { border-right: 1px solid var(--line); padding: 16px; overflow-y: auto; }
.sidebar h1 { font-size: 15px; margin: 0 0 16px; letter-spacing: 0.5px; }

.create-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
.create-form input, .create-form textarea {
  background: var(--panel); border: 1px solid var(--line); color: var(--text);
  border-radius: 6px; padding: 8px; font-size: 13px; font-family: inherit;
}
.create-form button {
  background: #2f6feb; border: none; color: #fff; border-radius: 6px;
  padding: 8px; cursor: pointer; font-size: 13px;
}
.create-form button:disabled { opacity: 0.5; cursor: not-allowed; }

.task-card {
  border: 1px solid var(--line); border-radius: 6px; padding: 10px;
  margin-bottom: 8px; cursor: pointer; background: var(--panel);
}
.task-card.active { border-color: #2f6feb; }
.task-card .title { font-weight: 500; margin-bottom: 4px; }
.task-card .meta { color: var(--muted); font-size: 12px; }

.detail { padding: 20px 24px; overflow-y: auto; }
.detail h2 { margin: 0 0 4px; font-size: 17px; }
.detail .sub { color: var(--muted); font-size: 12px; margin-bottom: 20px; }

.timeline { position: relative; padding-left: 20px; }
.timeline::before {
  content: ""; position: absolute; left: 5px; top: 6px; bottom: 6px;
  width: 1px; background: var(--line);
}
.node-row { position: relative; margin-bottom: 14px; }
.node-row::before {
  content: ""; position: absolute; left: -19px; top: 5px;
  width: 9px; height: 9px; border-radius: 50%; background: var(--line);
}
.node-row.succeeded::before { background: var(--ok); }
.node-row.running::before { background: var(--running); }
.node-row.failed::before { background: var(--fail); }

.node-title { font-weight: 500; }
.node-status { color: var(--muted); font-size: 12px; }
.node-status.failed { color: var(--fail); }

.transfer { color: var(--muted); font-size: 12px; margin: 2px 0 0 0; }

.artifact {
  border: 1px solid var(--line); border-radius: 6px; padding: 10px;
  margin-top: 6px; background: var(--panel);
}
.artifact .type { font-size: 12px; color: #7aa2f7; margin-bottom: 4px; }
.artifact pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--muted); }

.empty { color: var(--muted); margin-top: 40px; text-align: center; }
```

- [ ] **Step 6: 创建 `web/src/api.ts`**

```ts
export type NodeStateDto = {
  nodeId: string;
  roleId: string;
  status: string;
  attempt: number;
  lastLogRef: string | null;
  lastError: string | null;
  artifactIds: string[];
};

export type ArtifactDto = {
  artifact_id: string;
  type: string;
  status: string;
  summary: string;
  payload: unknown;
};

export type TaskStateDto = {
  taskId: string;
  title: string;
  requirementRaw: string;
  status: string;
  nodes: Record<string, NodeStateDto>;
  completedNodeIds: string[];
  currentNodeIds: string[];
  artifacts: ArtifactDto[];
  transfers: Array<{ from: string; to: string; reason: string; decidedBy: string }>;
  budgetUsedUsd: number;
};

export type TaskSummaryDto = { taskId: string; title: string; status: string };

export async function createTask(input: {
  title: string;
  requirementRaw: string;
  baseBranch?: string;
}): Promise<{ taskId: string }> {
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`创建任务失败：HTTP ${res.status}`);
  return (await res.json()) as { taskId: string };
}

export async function listTasks(): Promise<TaskSummaryDto[]> {
  const res = await fetch('/api/tasks');
  if (!res.ok) throw new Error(`获取任务列表失败：HTTP ${res.status}`);
  const body = (await res.json()) as { tasks: TaskSummaryDto[] };
  return body.tasks;
}

export async function getTask(taskId: string): Promise<TaskStateDto> {
  const res = await fetch(`/api/tasks/${taskId}`);
  if (!res.ok) throw new Error(`获取任务详情失败：HTTP ${res.status}`);
  return (await res.json()) as TaskStateDto;
}

export function openEventSocket(onMessage: (message: unknown) => void): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  socket.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data as string));
    } catch {
      // 忽略无法解析的消息
    }
  };
  return socket;
}
```

- [ ] **Step 7: 创建 `web/src/App.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  createTask,
  getTask,
  listTasks,
  openEventSocket,
  type TaskStateDto,
  type TaskSummaryDto,
} from './api';

export function App() {
  const [tasks, setTasks] = useState<TaskSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskStateDto | null>(null);
  const [title, setTitle] = useState('');
  const [requirement, setRequirement] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const selectedRef = useRef<string | null>(null);

  selectedRef.current = selectedId;

  const refreshList = useCallback(async () => {
    setTasks(await listTasks());
  }, []);

  const refreshDetail = useCallback(async (taskId: string) => {
    setDetail(await getTask(taskId));
  }, []);

  useEffect(() => {
    void refreshList();
    const socket = openEventSocket((message) => {
      const msg = message as { type?: string; state?: TaskStateDto };
      void refreshList();
      if (msg.type === 'task_state' && msg.state && msg.state.taskId === selectedRef.current) {
        setDetail(msg.state);
      }
    });
    return () => socket.close();
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void refreshDetail(selectedId);
    const timer = setInterval(() => void refreshDetail(selectedId), 2000);
    return () => clearInterval(timer);
  }, [selectedId, refreshDetail]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!title.trim() || !requirement.trim()) return;
    setSubmitting(true);
    try {
      const { taskId } = await createTask({ title, requirementRaw: requirement });
      setTitle('');
      setRequirement('');
      await refreshList();
      setSelectedId(taskId);
    } finally {
      setSubmitting(false);
    }
  }

  const orderedNodes = detail
    ? Object.values(detail.nodes).sort((a, b) => {
        const ai = detail.completedNodeIds.indexOf(a.nodeId);
        const bi = detail.completedNodeIds.indexOf(b.nodeId);
        if (ai === -1 && bi === -1) return a.nodeId.localeCompare(b.nodeId);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      })
    : [];

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>AgentFlow 观测台</h1>

        <form className="create-form" onSubmit={handleSubmit}>
          <input
            placeholder="任务标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            placeholder="原始需求"
            rows={3}
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
          />
          <button type="submit" disabled={submitting}>
            {submitting ? '提交中…' : '创建任务'}
          </button>
        </form>

        {tasks.map((task) => (
          <div
            key={task.taskId}
            className={`task-card${task.taskId === selectedId ? ' active' : ''}`}
            onClick={() => setSelectedId(task.taskId)}
          >
            <div className="title">{task.title}</div>
            <div className="meta">
              {task.status} · {task.taskId.slice(0, 12)}…
            </div>
          </div>
        ))}
      </aside>

      <main className="detail">
        {!detail && <div className="empty">选择或创建一个任务</div>}

        {detail && (
          <>
            <h2>{detail.title}</h2>
            <div className="sub">
              状态 {detail.status} · 已消耗 ${detail.budgetUsedUsd.toFixed(4)} · 并行度{' '}
              {detail.currentNodeIds.length}
            </div>

            <div className="timeline">
              {orderedNodes.map((node) => {
                const artifacts = detail.artifacts.filter((a) =>
                  node.artifactIds.includes(a.artifact_id),
                );
                const transfer = detail.transfers.find((t) => t.to === node.nodeId);
                return (
                  <div key={node.nodeId} className={`node-row ${node.status}`}>
                    <div className="node-title">
                      {node.nodeId} · {node.roleId}
                    </div>
                    <div className={`node-status ${node.status === 'failed' ? 'failed' : ''}`}>
                      第 {node.attempt} 次 · {node.status}
                      {node.lastError ? ` · ${node.lastError}` : ''}
                    </div>
                    {transfer && <p className="transfer">进入理由：{transfer.reason}</p>}
                    {artifacts.map((a) => (
                      <div key={a.artifact_id} className="artifact">
                        <div className="type">
                          {a.type} · {a.status}
                        </div>
                        <pre>{a.summary}</pre>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 8: 创建 `web/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 容器');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 9: 安装前端依赖并验证构建**

```bash
cd web && npm install --registry=https://registry.npmmirror.com && npx tsc --noEmit && npx vite build
```

Expected: 构建成功，产出 `web/dist/`

- [ ] **Step 10: 提交**

```bash
git add web
git commit -m "feat: 新增极简观测页面（任务列表与流转时间线）"
```

---

## Task 15: 端到端冒烟验证

**Files:**
- Create: `tests/e2e/README.md`
- Create: `tests/e2e/smoke.sh`
- Modify: `记录.md`

**Interfaces:**
- Consumes: Task 1–14 的全部产出
- Produces: 一份可重复执行的端到端验证脚本，以及写回 `记录.md` 的实测结果（含真实花费）

- [ ] **Step 1: 创建 `tests/e2e/README.md`**

```markdown
# 端到端冒烟测试

本测试会**真实调用 claude CLI**（产生真实费用），因此不纳入 `npm test`，需要手动执行。

## 前置条件

1. `.env` 已配置（可从 `.env.example` 复制）
2. `claude` 已完成登录：`claude --version` 能正常输出
3. 已执行过 `npm install`

## 执行

```bash
bash tests/e2e/smoke.sh
```

## 通过标准

1. 服务在 `127.0.0.1:8787` 启动成功
2. 创建任务后，事件流中出现 3 个 `node.succeeded`
3. 最终状态为 `completed`
4. 产出 3 个 Artifact：`requirement` / `code_diff` / `test_report`
5. `logs/runs/` 下生成了对应的原始日志文件
6. **记录本次实测花费**（来自 `budgetUsedUsd`），回填到 `记录.md`
```

- [ ] **Step 2: 创建 `tests/e2e/smoke.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# ⚠️ 安全前提：端到端会真实启动 agent，而 simple_dev 的 dev_implement 拥有写权限
# （owns 非空 → acceptEdits + Edit/Write/Bash）。若在 AgentFlow 仓库里跑，agent 会
# 直接改写本项目的工作区。因此必须在一个**独立的临时 git 仓库**里跑：
# 让 AgentFlow 的 cwd（= 内核的 repoPath）落在这个临时仓库，而配置仍指向 AgentFlow 自己的 config。
AGENTFLOW_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

TARGET_REPO="$(mktemp -d /tmp/agentflow-e2e-target-XXXXXX)"
cd "$TARGET_REPO"
git init -q
git -c user.email=e2e@local -c user.name=e2e commit -q --allow-empty -m "初始提交"
echo "# 端到端目标仓库" > README.md

HOST="127.0.0.1"
PORT="${AGENTFLOW_PORT:-8787}"
BASE="http://${HOST}:${PORT}"

echo "==> 目标仓库：$TARGET_REPO"
echo "==> 启动 AgentFlow"
AGENTFLOW_CONFIG_DIR="$AGENTFLOW_ROOT/config" \
AGENTFLOW_DB_PATH="$TARGET_REPO/data/e2e.sqlite" \
AGENTFLOW_LOG_DIR="$TARGET_REPO/logs" \
AGENTFLOW_WORKSPACE_DIR="$TARGET_REPO/workspaces" \
  npx tsx "$AGENTFLOW_ROOT/src/main.ts" > /tmp/agentflow-e2e.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

echo "==> 等待服务就绪"
for i in $(seq 1 30); do
  if curl -sf "${BASE}/api/health" > /dev/null; then
    break
  fi
  sleep 1
done
curl -sf "${BASE}/api/health" > /dev/null || { echo "服务未能启动，日志："; cat /tmp/agentflow-e2e.log; exit 1; }

echo "==> 创建任务"
TASK_ID=$(curl -s -X POST "${BASE}/api/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"E2E 冒烟","requirementRaw":"在目标仓库新增一个 scripts/hello.sh，执行后输出 hello agentflow。附带一句使用说明到 README.md。"}' \
  | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')

echo "任务 id：${TASK_ID}"
[ -n "${TASK_ID}" ] || { echo "创建任务失败"; exit 1; }

echo "==> 轮询任务状态（最长 15 分钟）"
for i in $(seq 1 180); do
  STATE=$(curl -s "${BASE}/api/tasks/${TASK_ID}")
  STATUS=$(echo "$STATE" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -n 1)
  echo "  [${i}] status=${STATUS}"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    break
  fi
  sleep 5
done

echo "==> 最终状态"
echo "$STATE" | head -c 4000
echo

echo "==> 事件类型统计"
curl -s "${BASE}/api/tasks/${TASK_ID}/events" \
  | grep -o '"type":"[^"]*"' | sort | uniq -c | sort -rn

echo "==> log_ref 是否真的指向存在的文件（Task 12/13 未在单测里覆盖的这一环在此补验）"
for ref in $(curl -s "${BASE}/api/tasks/${TASK_ID}/events" | grep -o '"log_ref":"[^"]*"' | sed 's/.*:"//;s/"$//' | sort -u); do
  if [ -f "$ref" ]; then echo "  OK   $ref"; else echo "  MISS $ref"; fi
done

echo "==> 目标仓库是否被 agent 改动（隔离是否生效）"
git -C "$TARGET_REPO" status --short || true

echo "==> 本仓库是否保持干净（不应被 agent 触碰）"
git -C "$AGENTFLOW_ROOT" status --short || true

echo "==> 判定"
if echo "$STATE" | grep -q '"status":"completed"'; then
  echo "PASS：任务完成"
else
  echo "FAIL：任务未完成，请检查上方状态与日志"
  exit 1
fi
```

- [ ] **Step 3: 执行端到端测试**

```bash
chmod +x tests/e2e/smoke.sh
bash tests/e2e/smoke.sh
```

Expected: 输出 `PASS：任务完成`，且事件类型统计中 `node.succeeded` 出现 3 次。

**若失败**：按以下顺序排查，不要直接改代码猜测
1. 看 `logs/runs/*.jsonl` 里 claude 的真实输出，确认解析是否命中
2. 检查 `spikes/cli-probe/README.md` 记录的字段路径与实现是否一致
3. 检查工作区目录是否可写

- [ ] **Step 4: 把实测结果写回 `记录.md`**

在 `记录.md` 中新增"Phase 1 实测结果"小节，**必须包含真实数据**：

```markdown
## Phase 1 实测结果

- 执行日期：<实际日期>
- 端到端结果：<PASS / FAIL>
- 事件总数：<来自 smoke.sh 输出>
- 节点成功次数：<node.succeeded 计数>
- **实测总花费：$<从 API 的 budgetUsedUsd 读取>**
- 单节点耗时：<从 node.started / node.succeeded 时间戳差计算>
- 遇到的真实问题：<如实记录，没有就写"无">
```

- [ ] **Step 5: 运行全量单元测试，确认没有回归**

Run: `npm test && npx tsc --noEmit`
Expected: 全部 PASS，无类型错误

- [ ] **Step 6: 提交**

```bash
git add tests/e2e 记录.md
git commit -m "test: 新增端到端冒烟测试并记录 Phase 1 实测结果"
```

---

## 完成标准

全部任务完成后，必须能独立验证以下每一条：

| # | 验证方式 | 期望 |
| --- | --- | --- |
| 1 | `npm test` | 全部通过 |
| 2 | `npx tsc --noEmit` | 无错误 |
| 3 | `bash tests/e2e/smoke.sh` | 输出 `PASS：任务完成` |
| 4 | `curl /api/tasks/:id` 的 `completedNodeIds` | `["pm_analyze","dev_implement","qa_verify"]` |
| 5 | `curl /api/tasks/:id` 的 `transfers` | 3 条，每条都有 `reason` 与 `decidedBy: "rule"` |
| 6 | `curl /api/tasks/:id/events` 中 `artifact.created` | 3 条，类型分别为 requirement / code_diff / test_report |
| 7 | `ls logs/runs/` | 至少 3 个 `.jsonl` 文件 |
| 8 | 打开 `http://127.0.0.1:5173`（`cd web && npm run dev`） | 能看到任务卡片与节点流转时间线 |
| 9 | `git log --oneline` | 每个 Task 至少一个提交 |

## 本阶段之后仍未做的事（属于后续阶段，不在本计划范围）

- 并行：工作包拆解、`parallel` / `join` 节点、worktree 池、文件级 ownership、integrator 合并
- 完整角色集与 `full` / `lean` / `solo` profile
- 卡点 G1 / G2 / G3 与人工审批队列
- codex adapter 与交叉引擎评审
- DAG 泳道图、实时日志流、组织视图、成本面板、产物浏览器
- Lease / 心跳、幂等重试、预算准入
- LLM 决策器
- Shared Context Bundle 版本化