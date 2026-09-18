import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAllRoles, loadRole, loadWorkflow } from './loader.js';

function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-cfg-'));
  mkdirSync(join(dir, 'roles'), { recursive: true });
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  mkdirSync(join(dir, 'prompts'), { recursive: true });

  writeFileSync(join(dir, 'prompts', 'pm.md'), '你是产品经理。');
  writeFileSync(
    join(dir, 'roles', 'pm.yaml'),
    [
      'id: pm',
      'display_name: 产品经理',
      'system_prompt_ref: prompts/pm.md',
      'inputs: []',
      'outputs:',
      '  - requirement',
      'owns: []',
      'reads:',
      '  - "docs/**"',
      'model: sonnet',
      'max_retries: 2',
      'max_wall_time_ms: 900000',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'workflows', 'simple_dev.yaml'),
    [
      'id: simple_dev',
      'start: pm_analyze',
      'nodes:',
      '  - id: pm_analyze',
      '    title: 需求分析',
      '    role: pm',
      '    consumes: []',
      '    produces: requirement',
      '    isolate: false',
      'edges: []',
    ].join('\n'),
  );
  return dir;
}

describe('loadRole', () => {
  it('加载角色并内联 system prompt 内容', () => {
    const dir = makeConfigDir();
    const role = loadRole(dir, 'pm');
    expect(role.id).toBe('pm');
    expect(role.displayName).toBe('产品经理');
    expect(role.systemPrompt).toBe('你是产品经理。');
    expect(role.outputs).toEqual(['requirement']);
  });

  it('角色文件不存在时抛出带路径的错误', () => {
    const dir = makeConfigDir();
    expect(() => loadRole(dir, 'nope')).toThrow(/nope\.yaml/);
  });

  it('prompt 文件不存在时抛出错误', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'roles', 'broken.yaml'),
      [
        'id: broken',
        'display_name: 坏角色',
        'system_prompt_ref: prompts/missing.md',
        'inputs: []',
        'outputs:',
        '  - requirement',
        'owns: []',
        'reads: []',
        'model: sonnet',
        'max_retries: 1',
        'max_wall_time_ms: 1000',
      ].join('\n'),
    );
    expect(() => loadRole(dir, 'broken')).toThrow(/missing\.md/);
  });

  it('YAML 结构非法时抛出校验错误', () => {
    const dir = makeConfigDir();
    writeFileSync(join(dir, 'roles', 'bad.yaml'), 'id: bad\ndisplay_name: 缺字段\n');
    expect(() => loadRole(dir, 'bad')).toThrow(/校验失败/);
  });
});

describe('loadWorkflow', () => {
  it('加载工作流并保留节点与边', () => {
    const dir = makeConfigDir();
    const wf = loadWorkflow(dir, 'simple_dev');
    expect(wf.start).toBe('pm_analyze');
    expect(wf.nodes).toHaveLength(1);
    expect(wf.nodes[0]?.produces).toBe('requirement');
  });

  it('start 指向不存在的节点时拒绝', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'workflows', 'bad.yaml'),
      ['id: bad', 'start: nope', 'nodes:', '  - id: a', '    title: A', '    role: pm', '    consumes: []', '    produces: requirement', '    isolate: false', 'edges: []'].join('\n'),
    );
    expect(() => loadWorkflow(dir, 'bad')).toThrow(/start/);
  });

  it('边指向不存在的节点时拒绝', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'workflows', 'bad2.yaml'),
      ['id: bad2', 'start: a', 'nodes:', '  - id: a', '    title: A', '    role: pm', '    consumes: []', '    produces: requirement', '    isolate: false', 'edges:', '  - from: a', '    to: ghost'].join('\n'),
    );
    expect(() => loadWorkflow(dir, 'bad2')).toThrow(/ghost/);
  });
});

describe('loadAllRoles', () => {
  it('加载目录下全部角色为 Map', () => {
    const dir = makeConfigDir();
    const roles = loadAllRoles(dir);
    expect([...roles.keys()]).toEqual(['pm']);
  });
});