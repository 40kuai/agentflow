import { describe, expect, it } from 'vitest';
import { buildArgs } from './claude-code-runner.js';
import type { RunRequest } from './types.js';

const base: RunRequest = {
  runId: 'run_1',
  prompt: '做点事',
  systemPrompt: '你是后端开发',
  workdir: '/tmp',
  model: 'sonnet',
  artifactType: 'code_diff',
  readOnly: false,
  wallTimeMs: 60_000,
};

describe('buildArgs', () => {
  it('默认传 --json-schema（实测：不传时模型常把 JSON 包进代码块，导致解析失败、零产物）', () => {
    const args = buildArgs({ ...base, outputSchema: { type: 'object' } });
    const idx = args.indexOf('--json-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(JSON.stringify({ type: 'object' }));
  });

  it('没有 outputSchema 时不传 --json-schema', () => {
    const args = buildArgs(base);
    expect(args).not.toContain('--json-schema');
  });

  it('显式关闭 useJsonSchema 时不传 --json-schema', () => {
    const args = buildArgs({ ...base, outputSchema: { type: 'object' } }, false);
    expect(args).not.toContain('--json-schema');
  });

  it('stream-json 必须同时带 --verbose（实测缺它则无输出）', () => {
    const args = buildArgs(base);
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
  });

  it('只读角色不给写权限（permission-mode 为 default，且不开放写工具）', () => {
    const args = buildArgs({ ...base, readOnly: true });
    expect(args).toContain('--tools=Read,Grep,Glob');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args.join(' ')).not.toContain('Write');
    expect(args.join(' ')).not.toContain('acceptEdits');
  });

  it('非只读角色使用 acceptEdits 并开放写工具', () => {
    const args = buildArgs(base);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args.join(' ')).toContain('Write');
  });

  it('budgetCapUsd 映射到 --max-budget-usd', () => {
    const args = buildArgs({ ...base, budgetCapUsd: 0.5 });
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.5');
  });
});