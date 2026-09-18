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
    // 开启 --json-schema 时（2026-09-18 凭据恢复后实测），结构化对象只出现在 structured_output，
    // result 退化为人类可读的散文总结；未开启时由 prompt 约束模型把 JSON 直接放进 result。
    // 只读 result 会让开启 --json-schema 的调用静默不产出 artifact。
    const structured = obj['structured_output'];
    if (structured !== null && typeof structured === 'object') {
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
        unregisterGroup(child.pid);
      });

      child.on('error', (error) => {
        clearTimeout(timeoutTimer);
        push({ kind: 'log', chunk: `进程启动失败：${error.message}` });
        closed = true;
        push({ kind: 'exited', code: -1 });
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