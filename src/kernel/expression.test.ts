import { describe, expect, it } from 'vitest';
import { ExpressionError, evaluateExpression, type Facts } from './expression.js';

const facts: Facts = {
  run: { attempt: 2 },
  tests: { failed: 0, passed: 12 },
  reviews: { verdicts: ['approve', 'approve'] },
  artifacts: {
    code_diff: { status: ['ok'] },
    test_report: { status: ['needs_changes'] },
  },
  wp: { id: 'wp1', status: 'running' },
  __functions: {
    deps: (arg: unknown) => {
      const obj = arg as { id: string };
      return obj.id === 'wp1'
        ? [{ id: 'wp0', status: 'merged' }]
        : [{ id: 'wpX', status: 'running' }];
    },
  },
};

describe('evaluateExpression', () => {
  it('标量比较', () => {
    expect(evaluateExpression("tests.failed == 0", facts)).toBe(true);
    expect(evaluateExpression("tests.failed > 0", facts)).toBe(false);
    expect(evaluateExpression("run.attempt >= 2", facts)).toBe(true);
    expect(evaluateExpression("run.attempt != 2", facts)).toBe(false);
  });

  it('字符串单引号字面量', () => {
    expect(evaluateExpression("wp.status == 'running'", facts)).toBe(true);
    expect(evaluateExpression("wp.status == 'merged'", facts)).toBe(false);
  });

  it('布尔字面量与 not', () => {
    expect(evaluateExpression('true', facts)).toBe(true);
    expect(evaluateExpression('not false', facts)).toBe(true);
    expect(evaluateExpression("not wp.status == 'merged'", facts)).toBe(true);
  });

  it('数组广播 + all / any', () => {
    expect(evaluateExpression("all(reviews.verdicts == 'approve')", facts)).toBe(true);
    expect(evaluateExpression("any(reviews.verdicts == 'reject')", facts)).toBe(false);
    expect(evaluateExpression("all(artifacts.code_diff.status == 'ok')", facts)).toBe(true);
    expect(evaluateExpression("all(artifacts.test_report.status == 'ok')", facts)).toBe(false);
    expect(evaluateExpression("any(artifacts.test_report.status == 'needs_changes')", facts)).toBe(true);
  });

  it('count 统计为真的元素个数', () => {
    // count() 内部返回数字，但 evaluateExpression 的契约是「返回布尔值」（状态机直接拿它当条件用），
    // 因此这里通过与字面量比较来观察计数结果，而不是让求值器返回非布尔值
    expect(evaluateExpression("count(reviews.verdicts == 'approve') == 2", facts)).toBe(true);
    expect(evaluateExpression("count(reviews.verdicts == 'reject') == 0", facts)).toBe(true);
  });

  it('deps 函数 + 属性访问 + all', () => {
    expect(evaluateExpression("all(deps(wp).status == 'merged')", facts)).toBe(true);
  });

  it('数组元素的字段缺失时抛错，而不是静默变成 undefined', () => {
    // 这条护栏防的是一类危险情形：若把缺失字段静默映射为 undefined，
    // 在 any() / count(...) == 0 / not 这些形态下会翻到「放行」一侧，
    // 即工作流边可能在本不该走时走。
    const f: Facts = {
      wp: { id: 'wp1' },
      __functions: {
        deps: () => [{ id: 'wp0' /* 故意不含 status */ }, { id: 'wpX', status: 'merged' }],
      },
    };
    expect(() => evaluateExpression("all(deps(wp).status == 'merged')", f)).toThrow(ExpressionError);
    expect(() => evaluateExpression("deps(wp).status == 'merged'", f)).toThrow(ExpressionError);
  });

  it('数组元素字段齐全时正常逐元素比较', () => {
    const f: Facts = {
      wp: { id: 'wp1' },
      __functions: { deps: () => [{ id: 'wp0', status: 'merged' }] },
    };
    expect(evaluateExpression("all(deps(wp).status == 'merged')", f)).toBe(true);
  });

  it('and / or 优先级与括号', () => {
    expect(evaluateExpression("tests.failed == 0 and run.attempt < 3", facts)).toBe(true);
    expect(evaluateExpression("tests.failed > 0 or run.attempt < 3", facts)).toBe(true);
    // or 优先级低于 and：等价于 false and true or true → true
    expect(evaluateExpression("false and true or true", facts)).toBe(true);
    expect(evaluateExpression("(false and true) or true", facts)).toBe(true);
    expect(evaluateExpression("false and (true or true)", facts)).toBe(false);
  });

  it('复合条件', () => {
    expect(
      evaluateExpression("all(reviews.verdicts == 'approve') and tests.failed == 0", facts),
    ).toBe(true);
  });

  it('路径不存在时抛 ExpressionError（不静默返回 undefined）', () => {
    expect(() => evaluateExpression('nope.missing == 1', facts)).toThrow(ExpressionError);
  });

  it('all/any 作用于非布尔数组时抛 ExpressionError', () => {
    expect(() => evaluateExpression('all(reviews.verdicts)', facts)).toThrow(ExpressionError);
  });

  it('语法错误时抛 ExpressionError 且带位置信息', () => {
    expect(() => evaluateExpression('tests.failed ==', facts)).toThrow(ExpressionError);
    expect(() => evaluateExpression('((', facts)).toThrow(ExpressionError);
  });

  it('拒绝任意 JS 求值（安全性）', () => {
    expect(() => evaluateExpression('process.exit(1)', facts)).toThrow(ExpressionError);
    expect(() => evaluateExpression("require('fs')", facts)).toThrow(ExpressionError);
  });

  it('白名单外的函数名在解析期就被拒（与是否注册在 __functions 无关）', () => {
    // customFn 已存在于注册表中，却仍不许出现在表达式里：
    // 证明拒绝来自解析期的白名单，而不是求值期的注册表查空。
    const f: Facts = {
      __functions: { customFn: () => true, deps: () => [] },
    };
    expect(() => evaluateExpression('customFn(1)', f)).toThrow(/不允许调用函数/);
    expect(() => evaluateExpression('process.exit(1)', f)).toThrow(/不允许调用函数/);
    // 与「白名单内但未注册」的错误文案可区分
    expect(() => evaluateExpression('deps(wp)', { wp: {} })).toThrow(/未注册的函数/);
  });
});