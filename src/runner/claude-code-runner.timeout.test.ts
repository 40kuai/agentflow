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