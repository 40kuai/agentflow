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
});