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

    // 两条产物通道都读，且 structured_output 优先：
    // 开启 --json-schema 时（2026-09-18 凭据恢复后实测），结构化对象出现在 structured_output；
    // result 的形状不固定（实测见过散文，也见过 ```json 代码块，无法保证可 JSON.parse），故不能只读它。
    // 只读 result 会让开启 --json-schema 的调用静默不产出 artifact。
    const structured = obj['structured_output'];
    // 顶层 schema 是 object，但 typeof [] === 'object' 且非 null，显式排除数组以免误当结构化对象
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

/**
 * 终止子进程的整棵进程树。
 * 必须按进程组杀：claude CLI 会派生工具子进程（如 Bash 里的命令），
 * 只杀直接子进程会留下持有 stdout/stderr 管道的孙进程，导致 Node 的 `close` 事件
 * 直到孙进程自己退出才触发——Task 2 实测的「永不退出」路径正是这类挂起，
 * 单测用 `#!/bin/sh\nsleep 60` 稳定复现（只杀 sh 时 close 迟迟不来）。
 * spawn 时的 `detached: true` 让子进程成为进程组组长，故组 id 即 child.pid。
 */
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid <= 0) return;
  try {
    // 负数 pid 表示「进程组」
    process.kill(-pid, signal);
  } catch {
    // 进程组不存在（子进程已退出或未成为组长）时退回杀直接子进程
    try {
      process.kill(pid, signal);
    } catch {
      // 进程已退出，忽略
    }
  }
}

// 模块级：登记活跃的子进程组，供退出钩子统一清理。
// 必要性：spawn 用了 detached: true（为了让 killTree 能按进程组杀），
// 代价是子进程脱离父进程组——父进程异常退出时它不会随之被终端信号带走。
// 若不清理，孤儿 claude 会继续消耗 API 额度。
const activeGroups = new Set<number>();
let exitHookInstalled = false;

function registerGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  activeGroups.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // 用 'exit' 而非 SIGINT/SIGTERM：进程正常退出、或上层（main.ts）处理完信号后
    // 调用 process.exit() 时，'exit' 都会触发，而 kill 是同步的，能在此安全执行。
    // SIGKILL 这类不可捕获的终止无法覆盖，这是设计边界。
    process.once('exit', () => {
      for (const groupPid of activeGroups) {
        killTree(groupPid, 'SIGKILL');
      }
    });
  }
}

/** 进程已结束（close / error）时从登记表移除，避免退出钩子做无用功 */
function unregisterGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  activeGroups.delete(pid);
}

export type ClaudeCodeRunnerOptions = {
  binPath: string;
  logDir: string;
  /** 追加的额外参数，用于探针阶段调试 */
  extraArgs?: string[];
  /**
   * 是否启用 CLI 层的结构化输出强制（--json-schema）。默认 **true**。
   * 依据 2026-09-18 凭据恢复后的真实端到端实测：不传时常被模型包进 ```json 代码块 →
   * JSON.parse 失败 → 零 artifact；传了则 CLI 正常退出（15.9s）并把校验过的对象放进
   * result.structured_output，耗时与成本都更低。仅在需要排障时显式关掉。
   * 注意该参数在请求失败路径上仍可能空转重试，故 wall-clock 超时 + killTree 是必需配套。
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
  // 默认传 --json-schema（见 options.useJsonSchema 注释里的实测依据）；
  // 解析层同时兼容两条通道：structured_output 优先，result 里的 JSON 字符串兜底。
  if (useJsonSchema && req.outputSchema) {
    args.push('--json-schema', JSON.stringify(req.outputSchema));
  }
  if (req.readOnly) {
    // 只读角色不放宽：它只需要读，`default` + 只读工具集即可。
    // 这也是「角色权限即沙箱参数」的体现——只有真正需要执行的角色才拿到执行权限。
    args.push('--tools=Read,Grep,Glob', '--permission-mode', 'default');
  } else {
    // 可写角色需要「精准预授权」，原因（2026-09-18 探针 + Task 15 端到端实测）：
    // headless（-p）下没有人工审批通道，而 `acceptEdits` 只自动放行**文件编辑**；
    // Bash 里的非白名单命令（chmod / sh x.sh / git checkout -b）一律返回
    // `This command requires approval`（Task 15 真实日志里这类拒绝出现 461 次）。
    // 但 dev_implement 的产物 schema 要求 self_test_result、dev/qa 的 prompt 明确要求
    // 「真实运行自测/测试」——契约不可满足 → agent 陷入重试，单节点成本涨到 $1.13~$2.20。
    // 故用 --allowed-tools 预授权角色真正需要的命令前缀（六类，本轮保持不变）：
    //   sh / bash → 运行 .sh 脚本（prompt 要求「运行一次自测」；真实日志里 `bash x.sh` 也被拒过）
    //   chmod     → 让脚本可执行（真实日志里被拒过，属「运行 shell 脚本」的必要一步）
    //   git       → **全部** git 子命令（该前缀不按子命令过滤），含 push / reset --hard / clean -fdx 等破坏性操作
    //   node      → 全部 node 调用（该前缀同样不按子命令过滤）
    //   npm       → **全部** npm 子命令，含 publish 与任意 install 生命周期脚本
    //
    // ⚠️ 已知局限（2026-09-18 评审确认，方案固有，非疏漏）：
    // shell 前缀（sh / bash）等价于**任意命令执行**——`bash -c "<任意命令>"` 完全落在 `Bash(bash:*)` 内，
    // 于是 `git push --force`、`rm -rf`、`curl … | sh` 都能绕过前缀限制。
    // 也就是说这里的「精准预授权」在**能力层面已退化为「全量放行」**；前缀白名单实际只约束
    // **不包 shell 的调用**（agent 直接写 `npm test` 会被前缀约束，写成 `bash -c 'npm test'` 就不会）。
    // 这是满足 dev/qa prompt「真实运行 .sh 脚本」的必要代价，收窄属 Phase 2 决策，本轮不改。
    // 另：`Bash(git:*)` / `Bash(npm:*)` 的授权面同样过宽（含 push / publish 等），
    // Phase 1 目标仓库是临时目录尚可控，真实项目使用前需按需收窄（如 `Bash(npm test:*)` / `Bash(npm run:*)`）。
    //
    // 明确不用 --dangerously-skip-permissions：那会放弃 CLI 的全部权限强制（用户已否决）。
    // `--tools` 与 `--allowed-tools` 语义不同且实测可并用（2026-09-18 探针 D/E）：
    // 前者限定「可用工具集」必须包含 Bash，后者在该集合内「预授权具体命令」，
    // 两者同时给出时 sh/bash/chmod/git/node/npm 均实际执行成功、permission_denials 为空。
    args.push(
      '--permission-mode', 'acceptEdits',
      '--tools=Read,Edit,Write,Grep,Glob,Bash',
      '--allowed-tools',
      'Bash(sh:*),Bash(bash:*),Bash(chmod:*),Bash(git:*),Bash(node:*),Bash(npm:*)',
    );
  }
  if (req.budgetCapUsd !== undefined) {
    args.push('--max-budget-usd', String(req.budgetCapUsd));
  }
  if (req.sessionId) {
    args.push('--session-id', req.sessionId);
  }
  return args;
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
        // detached 使子进程成为独立进程组组长，超时/取消时才能按组杀掉它派生的孙进程
        detached: true,
      });
      running.set(req.runId, child);
      // 登记子进程组，父进程异常退出时由退出钩子兜底清理（见模块级 registerGroup）
      registerGroup(child.pid ?? -1);

      // 硬性 wall-clock 超时保护。
      // 已知挂起路径：请求持续失败时，--json-schema 的 stop hook 会反复注入
      // 「You MUST call the StructuredOutput tool」，CLI 不退出（Task 2 实测空转 13 分钟）。
      // 凭据正常时该路径不复现（2026-09-18 实测 15.9s 正常退出），但超时保护必须保留。
      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        logStream.write(
          JSON.stringify({ ts: Date.now(), kind: 'timeout', wallTimeMs: req.wallTimeMs }) + '\n',
        );
        killTree(child.pid, 'SIGKILL');
      }, req.wallTimeMs);

      const queue: RunnerEvent[] = [];
      let notify: (() => void) | null = null;
      let closed = false;
      let buffered = '';

      const push = (e: RunnerEvent): void => {
        queue.push(e);
        notify?.();
        notify = null;
      };

      // ⚠️ 'error' 监听**必须**在第一个 yield 之前挂上。
      // spawn 失败（binPath 不存在 → ENOENT）时 Node 经 process.nextTick 投递 'error'，
      // 而 nextTick 队列先于 await 的微任务续跑执行：若此刻还没有监听器，Node 会抛
      // `Unhandled 'error' event` 并**直接杀掉整个进程**。已实测（真实 `src/main.ts` + 一次
      // `POST /api/tasks`，binPath 为 `/nonexistent/claude`）：修复前进程 exit 1
      // （`throw er; // Unhandled 'error' event` → `spawn /nonexistent/claude ENOENT`），
      // 任务永久卡在 active；修复后任务正常落 `failed`，`lastError` 为
      // 「CLI 退出码 -1：进程启动失败：spawn /nonexistent/claude ENOENT」。
      // 即任何 AGENTFLOW_CLAUDE_BIN 配错 / PATH 变更 / CLI 被卸载都能打死平台进程。
      // 回归测试：`src/runner/claude-code-runner.spawn-error.test.ts`（把本段挪回 yield 之后即变红）。
      child.on('error', (error) => {
        clearTimeout(timeoutTimer);
        push({ kind: 'log', chunk: `进程启动失败：${error.message}` });
        closed = true;
        push({ kind: 'exited', code: -1 });
        logStream.end();
        running.delete(req.runId);
        unregisterGroup(child.pid);
      });

      logStream.write(`${JSON.stringify({ ts: Date.now(), kind: 'spawn', args, cwd: req.workdir })}\n`);
      yield { kind: 'started', pid: child.pid ?? -1 };

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
        unregisterGroup(child.pid);
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
      killTree(child.pid, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (running.has(runId)) {
        killTree(child.pid, 'SIGKILL');
        running.delete(runId);
      }
    },
  };
}