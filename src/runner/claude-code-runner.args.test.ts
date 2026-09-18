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
  it('默认不传 --json-schema（实测该参数会让 CLI 永不退出）', () => {
    const args = buildArgs({ ...base, outputSchema: { type: 'object' } });
    expect(args).not.toContain('--json-schema');
  });

  it('显式开启 useJsonSchema 时才传 --json-schema', () => {
    const args = buildArgs({ ...base, outputSchema: { type: 'object' } }, true);
    const idx = args.indexOf('--json-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(JSON.stringify({ type: 'object' }));
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