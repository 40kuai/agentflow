import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeRunner } from './claude-code-runner.js';
import type { RunRequest, RunnerEvent } from './types.js';

function makeHangingBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-hang-'));
  const bin = join(dir, 'fake-claude.js');
  // 确定性复现「孙进程持有 stdout 管道写端」这一挂起成因：
  // 之前的 #!/bin/sh + sleep 是否产生孙进程取决于 sh 是 fork 还是 exec，是概率性的。
  // 这里显式 spawn 并用 stdio: 'inherit' 让孙进程继承 stdout/stderr，
  // 从而必然持有管道写端，使父进程的 close 事件在孙进程退出前不会触发。
  writeFileSync(
    bin,
    `#!/usr/bin/env node
if (process.argv[2] === '--warmup') process.exit(0);
const { spawn } = require('node:child_process');
spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] });
// 自己也不退出
setTimeout(() => {}, 60_000);
`,
  );
  chmodSync(bin, 0o755);
  // 预热：macOS 对「新建脚本文件的首次 execve」要走一遍校验，实测首次需 272~988ms，
  // 之后同一文件仅约 20ms（与解释器是 sh 还是 node 无关，`node <script>` 显式调用则不受影响）。
  // 若不为这 ~1s 的首次成本预热，300ms 的 wallTimeMs 很可能早于脚本本体启动，
  // 「孙进程持有管道」根本不成立，护栏会碰巧变绿（实测把 killTree 退回只杀直接子进程时 1/5 假绿）。
  // 这里先带 --warmup 空跑一次，把这段非确定性成本挪到计时窗口之外。
  execFileSync(bin, ['--warmup']);
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

    // 断言进程组已消失——这条不依赖「本次是否恰好挂起」，能稳定把守「组杀被删掉」的回归
    const started = events.find(
      (e): e is Extract<RunnerEvent, { kind: 'started' }> => e.kind === 'started',
    );
    expect(started).toBeDefined();
    const pid = started!.pid;
    expect(pid).toBeGreaterThan(0);
    // process.kill(-pid, 0) 是探测进程组是否存在的标准做法；组已消失时会抛 ESRCH
    expect(() => process.kill(-pid, 0)).toThrow();
  }, 10_000);
});