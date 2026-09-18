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

export type ClaudeCodeRunnerOptions = {
  binPath: string;
  logDir: string;
  /** 追加的额外参数，用于探针阶段调试 */
  extraArgs?: string[];
  /**
   * 是否启用 CLI 层的结构化输出强制（--json-schema）。
   * 默认 false —— Task 2 实测该参数会让 CLI 永不退出（16,403 次重试空转）。
   * 仅在未来 CLI 修好该 bug、且已补跑验证后才可开启。
   */
  useJsonSchema?: boolean;
};

/** 根据角色权限和产出要求拼装 claude 命令行参数 */
export function buildArgs(req: RunRequest, useJsonSchema = false): string[] {
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
  // 默认不传 --json-schema：实测会让进程永不退出。
  // 产物格式改由 prompt 约束 + 解析层 JSON 提取 + zod 校验兜底。
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
      const args = [...buildArgs(req, options.useJsonSchema ?? false), ...(options.extraArgs ?? [])];
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

      // 硬性 wall-clock 超时保护。
      // Task 2 实测存在「CLI 永不退出」的路径（--json-schema 挂起 13 分钟），
      // 没有这层保护，任务会永久卡住且后续节点永不执行。
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
      killTree(child.pid, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (running.has(runId)) {
        killTree(child.pid, 'SIGKILL');
        running.delete(runId);
      }
    },
  };
}