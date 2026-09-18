import type { AgentRunner, RunRequest, RunnerEvent } from './types.js';

/** 脚本项：runner 不产生 started（由实现自动补），其余按顺序回放 */
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

      const script = queue.shift();
      if (!script) {
        throw new Error(
          'FakeRunner 的脚本队列已耗尽：提供的脚本份数少于实际 run 次数。' +
            '请让 scripts 的份数与预期的 run 次数一致（不要依赖兜底行为）。',
        );
      }
      for (const item of script) {
        yield item;
      }
    },

    async cancel(runId: string): Promise<void> {
      cancelled.push(runId);
    },
  };
}