import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeRunner } from './claude-code-runner.js';
import type { RunRequest, RunnerEvent } from './types.js';

// 回归：spawn 失败（binPath 不存在 → ENOENT）**不得打死整个 Node 进程**。
//
// 成因：Node 对 spawn 失败经 process.nextTick 投递 'error'（`onErrorNT`），而在**宏任务的同步段**
// 里启动迭代时，nextTick 队列会在第一个 `yield` 的微任务续跑之前被排空。若
// `child.on('error', ...)` 注册在第一个 `yield { kind: 'started' }` 之后，监听器还没挂上
// 'error' 就已到达 → `Unhandled 'error' event` → Node 进程直接退出（终审已实证：
// 真实 main.ts + 一次 POST /api/tasks 即复现，日志为 `Unhandled 'error' event ... ENOENT`，exit 1）。
//
// ⚠️ 本用例**必须**把「启动迭代」放进一个全新宏任务的同步段（见下方 setImmediate）。
// 若直接在测试函数体里 `for await`，vitest 已处于微任务上下文：此时第一个 yield 的续跑微任务会
// 先于 nextTick 队列执行，`'error'` 到达时监听器**已经**挂上，缺陷被掩盖、变异不会变红
// （已实测：直接在测试体内迭代时，把监听挪回 yield 之后仍然 1 passed）。
// 生产路径正是「宏任务同步段」这个形状 —— main.ts 的 HTTP 路由处理器在请求的宏任务里同步调用 runTask。
const req: RunRequest = {
  runId: 'run_spawn_error',
  prompt: 'p',
  systemPrompt: '',
  workdir: tmpdir(),
  model: 'sonnet',
  artifactType: 'code_diff',
  readOnly: false,
  wallTimeMs: 5_000,
};

describe('claude runner spawn 失败', () => {
  it('binPath 不存在时不抛未捕获异常，而是产出「进程启动失败」日志并以 exited(-1) 收尾', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'agentflow-spawnerr-'));
    const runner = createClaudeCodeRunner({ binPath: '/nonexistent/claude', logDir });

    const events: RunnerEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        void (async () => {
          try {
            for await (const e of runner.run(req)) events.push(e);
            resolve();
          } catch (error) {
            reject(error);
          }
        })();
      });
    });

    expect(events[0]).toEqual({ kind: 'started', pid: -1 });
    expect(events.some((e) => e.kind === 'log' && e.chunk.includes('进程启动失败'))).toBe(true);
    expect(events.at(-1)).toEqual({ kind: 'exited', code: -1 });
  }, 10_000);
});