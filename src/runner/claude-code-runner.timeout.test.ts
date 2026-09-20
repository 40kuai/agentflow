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

/** 持续输出（每 200ms 一行）但总时长 1.6s 的脚本：用来证明「有输出就不会被 stall 判死」 */
function makeTickingBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-tick-'));
  const bin = join(dir, 'fake-claude.js');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
if (process.argv[2] === '--warmup') process.exit(0);
let n = 0;
const t = setInterval(() => {
  process.stdout.write('tick\\n');
  n += 1;
  if (n >= 8) { clearInterval(t); process.exit(0); }
}, 200);
`,
  );
  chmodSync(bin, 0o755);
  execFileSync(bin, ['--warmup']);
  return bin;
}

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

describe('claude runner 停滞自动停止（stall timeout）', () => {
  it('连续无输出超过 stallTimeoutMs 即强制终止，退出码 -1 且失败原因归为 timeout', async () => {
    const binPath = makeHangingBin();
    const logDir = mkdtempSync(join(tmpdir(), 'agentflow-stalllog-'));
    const runner = createClaudeCodeRunner({ binPath, logDir });

    const events: RunnerEvent[] = [];
    const startedAt = Date.now();
    // wallTimeMs 给到 30s：若最终仍在 5s 内结束，说明生效的是 stall 计时器而非总时长封顶
    for await (const e of runner.run({ ...req, runId: 'run_stall', wallTimeMs: 30_000, stallTimeoutMs: 400 })) {
      events.push(e);
    }
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(5_000);
    expect(events.at(-1)).toEqual({ kind: 'exited', code: -1 });
    expect(events.some((e) => e.kind === 'log' && e.chunk.includes('stall timeout'))).toBe(true);
    expect(events.some((e) => e.kind === 'failure' && e.reason === 'timeout')).toBe(true);

    // SIGKILL 打的是进程组：孙进程（sleep 60）必须一起死，否则平台会留下孤儿进程
    const started = events.find(
      (e): e is Extract<RunnerEvent, { kind: 'started' }> => e.kind === 'started',
    );
    expect(started).toBeDefined();
    expect(() => process.kill(-started!.pid, 0)).toThrow();
  }, 10_000);

  it('只要持续有输出就不会被误杀（stall 计的是「距最后一次输出」而非总耗时）', async () => {
    const binPath = makeTickingBin();
    const logDir = mkdtempSync(join(tmpdir(), 'agentflow-ticklog-'));
    const runner = createClaudeCodeRunner({ binPath, logDir });

    const events: RunnerEvent[] = [];
    // stallTimeoutMs(400) < 脚本总时长(~1.6s)：若计时器不在每次输出后重置，这里必然被误杀
    for await (const e of runner.run({ ...req, runId: 'run_tick', wallTimeMs: 30_000, stallTimeoutMs: 400 })) {
      events.push(e);
    }

    expect(events.at(-1)).toEqual({ kind: 'exited', code: 0 });
    expect(events.some((e) => e.kind === 'log' && e.chunk.includes('stall timeout'))).toBe(false);
    expect(events.some((e) => e.kind === 'failure')).toBe(false);
  }, 10_000);

  it('stallTimeoutMs 为 0 / 未配置时不启用该保护（保持旧行为）', async () => {
    const binPath = makeHangingBin();
    const logDir = mkdtempSync(join(tmpdir(), 'agentflow-nostalllog-'));
    const runner = createClaudeCodeRunner({ binPath, logDir });

    const events: RunnerEvent[] = [];
    const startedAt = Date.now();
    // 只给 600ms 的 wall-clock 上限：若 stall 在未配置时也生效，它不可能成为本次结束的原因
    for await (const e of runner.run({ ...req, runId: 'run_nostall', wallTimeMs: 600 })) {
      events.push(e);
    }
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(5_000);
    expect(events.at(-1)).toEqual({ kind: 'exited', code: -1 });
    expect(events.some((e) => e.kind === 'log' && e.chunk.includes('wall-clock'))).toBe(true);
    expect(events.some((e) => e.kind === 'log' && e.chunk.includes('stall timeout'))).toBe(false);
  }, 10_000);
});