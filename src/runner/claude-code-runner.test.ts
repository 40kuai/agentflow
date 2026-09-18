import { describe, expect, it } from 'vitest';
import { parseStreamLine } from './claude-code-runner.js';

// 注意：下面的样本是**人工构造的**，用于覆盖成功路径（result 为合法 JSON 字符串）。
// 原因：Task 2 因 claude 额度耗尽，成功路径从未跑通，因此没有成功样本可归档。
// 真实归档样本（认证失败路径）由 Step 6 的 fixture 契约回归覆盖。
// 构造样本里的字段名必须与 Task 2 实测结论一致：
//   - 失败判定用 is_error，不用 subtype
//   - usage 在 result 事件内，字段为 input_tokens / output_tokens
//   - 成本字段为 result.total_cost_usd
// 一旦额度恢复并补录到成功样本，应把本文件的入口测试替换为真实样本。
const SAMPLE_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'sess-abc',
  result: '{"summary":"项目配置了 TypeScript 与 vitest","files_read":["package.json"]}',
  usage: { input_tokens: 1200, output_tokens: 300 },
  total_cost_usd: 0.0231,
  is_error: false,
  // 真实事件还有 duration_ms / num_turns / stop_reason / modelUsage 等字段；
  // 解析层不得对其做白名单校验，这里故意不放全，以验证「未知字段被容忍」
  duration_ms: 23,
  num_turns: 2,
});

describe('parseStreamLine', () => {
  it('忽略空行与非法 JSON，返回空数组', () => {
    expect(parseStreamLine('')).toEqual([]);
    expect(parseStreamLine('   ')).toEqual([]);
    expect(parseStreamLine('not json')).toEqual([]);
  });

  it('从 result 事件中提取 usage 与 session id', () => {
    const events = parseStreamLine(SAMPLE_RESULT);
    // 注：简报原断言为 toEqual([usage])，但同一条 result 事件按实现（与下方 artifact 用例、
    // fixture 契约回归用例）必须同时产出 usage 与 artifact，故此处按意图断言 usage 事件本身。
    expect(events).toContainEqual({ kind: 'usage', tokensIn: 1200, tokensOut: 300, costUsd: 0.0231 });
  });

  it('result 的内容为合法 JSON 且非错误时，产出 artifact 事件', () => {
    const events = parseStreamLine(SAMPLE_RESULT);
    const artifact = events.find((e) => e.kind === 'artifact');
    expect(artifact).toBeDefined();
    if (artifact && artifact.kind === 'artifact') {
      expect(artifact.raw).toEqual({
        summary: '项目配置了 TypeScript 与 vitest',
        files_read: ['package.json'],
      });
    }
  });

  it('is_error 为 true 时不产出 artifact', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 'sess-abc',
      result: 'error',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      is_error: true,
    });
    const events = parseStreamLine(line);
    expect(events.some((e) => e.kind === 'artifact')).toBe(false);
    expect(events.some((e) => e.kind === 'log')).toBe(true);
  });

  it('assistant 消息作为日志事件输出', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '正在读取 package.json' }] },
    });
    const events = parseStreamLine(line);
    expect(events).toContainEqual({ kind: 'log', chunk: '正在读取 package.json' });
  });

  it('失败判定只看 is_error：subtype 为 success 但 is_error 为 true 时不产出 artifact', () => {
    // 真实归档样本正是这个形状（subtype:"success" + is_error:true，见 Task 2 探针）。
    // 这里刻意让 result 是**合法 JSON**，才能把「看 is_error」与「看 subtype」两种实现区分开：
    // 若退化回用 subtype 判定，本用例会变红（误产出 artifact）；
    // 而简报原有的两条用例因 result/错误枚举巧合一致，察觉不到该退化（已用变异验证确认）。
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-abc',
      result: '{"ok":true}',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      is_error: true,
    });
    const events = parseStreamLine(line);
    expect(events.some((e) => e.kind === 'artifact')).toBe(false);
    expect(events.some((e) => e.kind === 'log')).toBe(true);
  });

  it('无法解析为 JSON 的 result 内容不产出 artifact，只产出日志', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 's',
      result: '这不是 JSON',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      is_error: false,
    });
    const events = parseStreamLine(line);
    expect(events.some((e) => e.kind === 'artifact')).toBe(false);
    expect(events.some((e) => e.kind === 'log')).toBe(true);
  });
});