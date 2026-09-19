import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeRunner } from './claude-code-runner.js';
import type { RunRequest, RunnerEvent } from './types.js';

const FIXTURE_DIR = resolve(import.meta.dirname, '../../tests/fixtures');

/** 逐字归档的真实失败行（error_max_structured_output_retries） */
function maxRetriesLine(): string {
  return readFileSync(join(FIXTURE_DIR, 'claude-stream-maxretries-sample.jsonl'), 'utf8').trim();
}

/** 降级通道的成功产出：result 里是合法 JSON 字符串，没有 structured_output */
function resultChannelSuccessLine(): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify({
      problem: '降级重试后产出',
      goals: ['g'],
      non_goals: [],
      acceptance_criteria: ['a'],
    }),
    usage: { input_tokens: 30, output_tokens: 10 },
    total_cost_usd: 0.01,
  });
}

/**
 * 假 bin：第 n 次被调用时输出 lines[n-1]（越界则重复最后一条），退出码由该行是否为
 * 「结构化输出重试耗尽」决定。同时把每次的参数写进 args.jsonl，供断言「第二次关掉了 --json-schema」。
 * 本测试**不调用真实 claude**。
 */
function makeFakeBin(dir: string, lines: string[]): string {
  const argsLog = join(dir, 'args.jsonl');
  const countFile = join(dir, 'count.txt');
  const linesFile = join(dir, 'lines.json');
  writeFileSync(linesFile, JSON.stringify(lines));
  const bin = join(dir, 'fake-claude.js');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
if (process.argv[2] === '--warmup') process.exit(0);
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
let n = 0;
try { n = Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')); } catch {}
n += 1;
fs.writeFileSync(${JSON.stringify(countFile)}, String(n));
const lines = JSON.parse(fs.readFileSync(${JSON.stringify(linesFile)}, 'utf8'));
const line = lines[Math.min(n - 1, lines.length - 1)];
process.stdout.write(line + '\\n');
process.exit(line.includes('error_max_structured_output_retries') ? 1 : 0);
`,
  );
  chmodSync(bin, 0o755);
  // macOS 对新脚本首次 execve 有一次性校验成本；预热把它挪出计时窗口（同 timeout 用例）
  execFileSync(bin, ['--warmup']);
  return bin;
}

function invocations(dir: string): string[][] {
  return readFileSync(join(dir, 'args.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as string[]);
}

const req: RunRequest = {
  runId: 'run_retry',
  prompt: '做点事',
  systemPrompt: '',
  workdir: tmpdir(),
  model: 'sonnet',
  outputSchema: { type: 'object' },
  artifactType: 'requirement',
  readOnly: true,
  wallTimeMs: 30_000,
};

describe('claude runner 结构化输出重试耗尽后的降级重试', () => {
  it('重试耗尽 → 自动关闭 --json-schema 重跑一次，并从 result 通道拿到产物', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflow-retry-'));
    const binPath = makeFakeBin(dir, [maxRetriesLine(), resultChannelSuccessLine()]);
    const logDir = mkdtempSync(join(tmpdir(), 'agentflow-retrylog-'));
    const runner = createClaudeCodeRunner({ binPath, logDir });

    const events: RunnerEvent[] = [];
    for await (const e of runner.run(req)) events.push(e);

    const calls = invocations(dir);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--json-schema');
    expect(calls[1]).not.toContain('--json-schema');

    // 可观测痕迹：一条说明降级的 log
    expect(
      events.some((e) => e.kind === 'log' && e.chunk.includes('结构化输出重试耗尽，已降级为 result 通道重试一次')),
    ).toBe(true);

    // 产物来自 result 通道
    expect(events).toContainEqual({
      kind: 'artifact',
      raw: {
        problem: '降级重试后产出',
        goals: ['g'],
        non_goals: [],
        acceptance_criteria: ['a'],
      },
    });

    // 第一次失败的 exited(code 1) 不得进入事件流，否则内核会把它当最终退出码
    expect(events.filter((e) => e.kind === 'exited')).toEqual([{ kind: 'exited', code: 0 }]);

    // 「一次 run 一个 started」：降级时第一次尝试整体作废，它的 started 不得泄漏，只留重试那条。
    // 且该 started 必须出现在降级说明之后 —— 证明留下的是重试那次的，而不是第一次尝试的。
    const startedIndexes = events
      .map((e, i) => (e.kind === 'started' ? i : -1))
      .filter((i) => i >= 0);
    expect(startedIndexes).toHaveLength(1);
    const fallbackLogIndex = events.findIndex(
      (e) => e.kind === 'log' && e.chunk.includes('结构化输出重试耗尽，已降级为 result 通道重试一次'),
    );
    expect(startedIndexes[0]!).toBeGreaterThan(fallbackLogIndex);
  }, 30_000);

  it('降级重试自身再失败时正常按失败处理，且只降级一次（不再无限重试）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflow-retry2-'));
    const binPath = makeFakeBin(dir, [maxRetriesLine()]);
    const logDir = mkdtempSync(join(tmpdir(), 'agentflow-retrylog2-'));
    const runner = createClaudeCodeRunner({ binPath, logDir });

    const events: RunnerEvent[] = [];
    for await (const e of runner.run(req)) events.push(e);

    expect(invocations(dir)).toHaveLength(2);
    expect(events.some((e) => e.kind === 'artifact')).toBe(false);
    expect(events.at(-1)).toEqual({ kind: 'exited', code: 1 });
    // 降级场景（重试亦失败）同样只发一条 started：第一次尝试的 started 不泄漏
    expect(events.filter((e) => e.kind === 'started')).toHaveLength(1);
    // 只留一条降级说明，避免出现「降级再降级」的递归
    expect(
      events.filter(
        (e) => e.kind === 'log' && e.chunk.includes('已降级为 result 通道重试一次'),
      ),
    ).toHaveLength(1);
  }, 30_000);

  it('非重试耗尽的失败（如认证失败）不做降级重试', async () => {
    const authFailureLine = readFileSync(
      join(FIXTURE_DIR, 'claude-stream-sample.jsonl'),
      'utf8',
    ).trim();
    const dir = mkdtempSync(join(tmpdir(), 'agentflow-retry3-'));
    const binPath = makeFakeBin(dir, [authFailureLine]);
    const logDir = mkdtempSync(join(tmpdir(), 'agentflow-retrylog3-'));
    const runner = createClaudeCodeRunner({ binPath, logDir });

    const events: RunnerEvent[] = [];
    for await (const e of runner.run(req)) events.push(e);

    expect(invocations(dir)).toHaveLength(1);
    expect(events.some((e) => e.kind === 'log' && e.chunk.includes('已降级'))).toBe(false);
  }, 30_000);
});