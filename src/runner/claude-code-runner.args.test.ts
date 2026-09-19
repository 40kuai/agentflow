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

  // 安全边界：预授权只属于「真正需要执行」的角色。只读角色若被放开 Bash 预授权，
  // 就等于把 Read/Grep/Glob 的沙箱彻底打破，故这条必须有断言把守。
  it('只读角色不含任何 Bash 预授权（安全边界）', () => {
    const args = buildArgs({ ...base, readOnly: true });
    expect(args).not.toContain('--allowed-tools');
    expect(args.join(' ')).not.toContain('Bash');
  });

  it('非只读角色使用 acceptEdits 并开放写工具', () => {
    const args = buildArgs(base);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args.join(' ')).toContain('Write');
  });

  // 2026-09-18 探针（/tmp/agentflow-perm-probe，claude 2.1.38）实测：
  // headless 下 `acceptEdits` 只放行文件编辑，`sh -c 'echo ...'` 返回
  // `This command requires approval`（Task 15 端到端里这类拒绝 461 次）；
  // 叠加 --allowed-tools 预授权后，sh/bash/chmod/git/node/npm 均真实执行、`permission_denials` 为空。
  it('非只读角色带 --allowed-tools 精准预授权（headless 下 acceptEdits 不放行执行）', () => {
    const args = buildArgs(base);
    const idx = args.indexOf('--allowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(
      'Bash(sh:*),Bash(bash:*),Bash(chmod:*),Bash(git:*),Bash(node:*),Bash(npm:*)',
    );
  });

  it('--tools 与 --allowed-tools 并用：工具集含 Bash，且不放弃 CLI 权限强制', () => {
    const args = buildArgs(base);
    // 探针 D 实测：两者同时给出不冲突——--tools 限定可用工具集，--allowed-tools 在其内预授权
    expect(args).toContain('--tools=Read,Edit,Write,Grep,Glob,Bash');
    expect(args).toContain('--allowed-tools');
    expect(args.join(' ')).not.toContain('dangerously-skip-permissions');
  });

  it('budgetCapUsd 映射到 --max-budget-usd', () => {
    const args = buildArgs({ ...base, budgetCapUsd: 0.5 });
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.5');
  });
});