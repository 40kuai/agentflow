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
      'responsibilities:',
      '  - 澄清需求',
      'prohibitions:',
      '  - 不修改代码',
      'done_criteria:',
      '  - 产出 requirement',
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

  it('把 YAML 的 max_retries 带成 maxRetries（用非默认值区分真实值与默认值）', () => {
    const dir = makeConfigDir();
    // 故意用 1（schema 默认为 2）：若映射遗漏该字段，断言会因 undefined 变红，
    // 且此值能排除"其实只是读了默认值"的假阳性。
    writeFileSync(
      join(dir, 'roles', 'qa.yaml'),
      [
        'id: qa',
        'display_name: 测试工程师',
        'system_prompt_ref: prompts/pm.md',
        'inputs: []',
        'outputs:',
        '  - test_report',
        'owns: []',
        'reads: []',
        'responsibilities:',
        '  - 测试',
        'prohibitions:',
        '  - 不改实现',
        'done_criteria:',
        '  - 产出 test_report',
        'model: sonnet',
        'max_retries: 1',
        'max_wall_time_ms: 1000',
      ].join('\n'),
    );
    expect(loadRole(dir, 'qa').maxRetries).toBe(1);
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
        'responsibilities:',
        '  - 占位',
        'prohibitions:',
        '  - 占位',
        'done_criteria:',
        '  - 占位',
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
      ['id: bad2', 'start: a', 'nodes:', '  - id: a', '    title: A', '    role: pm', '    consumes: []', '    produces: requirement', '    isolate: false', 'edges:', '  - from: a', '    to: ghost', '    description: 指向不存在的节点', '    on_missing: fail'].join('\n'),
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

  it('加载角色并带出职责边界、禁止事项、完成判据', () => {
    const dir = makeConfigDir();
    const role = loadRole(dir, 'pm');
    expect(role.responsibilities).toEqual(['澄清需求']);
    expect(role.prohibitions).toEqual(['不修改代码']);
    expect(role.doneCriteria).toEqual(['产出 requirement']);
  });

  it('缺少职责边界字段时校验失败（中文错误）', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'roles', 'no_resp.yaml'),
      [
        'id: no_resp',
        'display_name: 缺职责',
        'system_prompt_ref: prompts/pm.md',
        'inputs: []',
        'outputs:',
        '  - requirement',
        'owns: []',
        'reads: []',
        'prohibitions:',
        '  - 占位',
        'done_criteria:',
        '  - 占位',
        'model: sonnet',
        'max_retries: 1',
        'max_wall_time_ms: 1000',
      ].join('\n'),
    );
    expect(() => loadRole(dir, 'no_resp')).toThrow(/responsibilities（职责边界）/);
  });
});

/** 写一份角色文件，用于契约一致性用例 */
function writeRole(dir: string, id: string, inputs: string[], outputs: string[]): void {
  writeFileSync(
    join(dir, 'roles', `${id}.yaml`),
    [
      `id: ${id}`,
      `display_name: ${id}`,
      'system_prompt_ref: prompts/pm.md',
      'inputs:',
      ...inputs.map((v) => `  - ${v}`),
      'outputs:',
      ...outputs.map((v) => `  - ${v}`),
      'owns: []',
      'reads: []',
      'responsibilities:',
      '  - 占位',
      'prohibitions:',
      '  - 占位',
      'done_criteria:',
      '  - 占位',
      'model: sonnet',
      'max_retries: 1',
      'max_wall_time_ms: 1000',
    ].join('\n'),
  );
}

/** 写一份工作流文件，用于契约一致性用例 */
function writeWorkflow(dir: string, id: string, nodeLines: string[]): void {
  writeFileSync(
    join(dir, 'workflows', `${id}.yaml`),
    ['id: ' + id, 'start: n1', 'nodes:', ...nodeLines, 'edges: []'].join('\n'),
  );
}

describe('契约唯一来源（角色 inputs/outputs 为权威，节点 consumes/produces 为派生）', () => {
  it('节点 consumes 与角色 inputs 冲突时加载报错，并指明角色 id、节点 id、冲突字段', () => {
    const dir = makeConfigDir();
    writeWorkflow(dir, 'conflict_consumes', [
      '  - id: n1',
      '    title: 需求分析',
      '    role: pm',
      '    consumes:',
      '      - code_diff',
      '    produces: requirement',
      '    isolate: false',
    ]);
    expect(() => loadWorkflow(dir, 'conflict_consumes')).toThrow(/节点 n1/);
    expect(() => loadWorkflow(dir, 'conflict_consumes')).toThrow(/角色 pm/);
    expect(() => loadWorkflow(dir, 'conflict_consumes')).toThrow(/consumes\/inputs/);
  });

  it('节点 produces 与角色 outputs 冲突时加载报错，并指明角色 id、节点 id、冲突字段', () => {
    const dir = makeConfigDir();
    writeWorkflow(dir, 'conflict_produces', [
      '  - id: n1',
      '    title: 需求分析',
      '    role: pm',
      '    consumes: []',
      '    produces: test_report',
      '    isolate: false',
    ]);
    expect(() => loadWorkflow(dir, 'conflict_produces')).toThrow(/节点 n1/);
    expect(() => loadWorkflow(dir, 'conflict_produces')).toThrow(/角色 pm/);
    expect(() => loadWorkflow(dir, 'conflict_produces')).toThrow(/produces\/outputs/);
  });

  it('节点引用未注册的角色时加载报错', () => {
    const dir = makeConfigDir();
    writeWorkflow(dir, 'ghost_role', [
      '  - id: n1',
      '    title: 幽灵',
      '    role: ghost',
      '    consumes: []',
      '    produces: requirement',
      '    isolate: false',
    ]);
    expect(() => loadWorkflow(dir, 'ghost_role')).toThrow(/未注册的角色：ghost/);
  });

  it('声明一致时以角色为权威回填派生字段（consumes 顺序按角色 inputs）', () => {
    const dir = makeConfigDir();
    writeRole(dir, 'worker', ['a', 'b'], ['out']);
    writeWorkflow(dir, 'derived', [
      '  - id: n1',
      '    title: 派生',
      '    role: worker',
      '    consumes:',
      '      - b',
      '      - a',
      '    produces: out',
      '    isolate: false',
    ]);
    const wf = loadWorkflow(dir, 'derived');
    expect(wf.nodes[0]?.consumes).toEqual(['a', 'b']);
    expect(wf.nodes[0]?.produces).toBe('out');
  });
});

describe('工作流拓扑字段解析与校验', () => {
  it('节点可声明 description 与 entry_condition，加载后保留（注意 YAML 用 entry_condition）', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'workflows', 'topology.yaml'),
      [
        'id: topology',
        'start: n1',
        'nodes:',
        '  - id: n1',
        '    title: 需求分析',
        '    role: pm',
        '    description: 流程起点',
        '    entry_condition: 任务开始即进入',
        '    consumes: []',
        '    produces: requirement',
        '    isolate: false',
        'edges: []',
      ].join('\n'),
    );
    const wf = loadWorkflow(dir, 'topology');
    expect(wf.nodes[0]?.description).toBe('流程起点');
    expect(wf.nodes[0]?.entryCondition).toBe('任务开始即进入');
  });

  it('节点 description 声明为空串时校验失败（中文错误）', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'workflows', 'empty_desc.yaml'),
      [
        'id: empty_desc',
        'start: n1',
        'nodes:',
        '  - id: n1',
        '    title: 空说明',
        '    role: pm',
        '    description: ""',
        '    consumes: []',
        '    produces: requirement',
        '    isolate: false',
        'edges: []',
      ].join('\n'),
    );
    expect(() => loadWorkflow(dir, 'empty_desc')).toThrow(/description（节点说明）不得为空/);
  });

  it('边缺少 description 时校验失败（中文错误）', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'workflows', 'edge_no_desc.yaml'),
      [
        'id: edge_no_desc',
        'start: n1',
        'nodes:',
        '  - id: n1',
        '    title: 需求分析',
        '    role: pm',
        '    consumes: []',
        '    produces: requirement',
        '    isolate: false',
        'edges:',
        '  - from: n1',
        '    to: n1',
        '    when: "true"',
        '    on_missing: fail',
      ].join('\n'),
    );
    expect(() => loadWorkflow(dir, 'edge_no_desc')).toThrow(/description（边的人类可读说明）/);
  });

  it('边缺少 on_missing 时校验失败（中文错误）', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'workflows', 'edge_no_missing.yaml'),
      [
        'id: edge_no_missing',
        'start: n1',
        'nodes:',
        '  - id: n1',
        '    title: 需求分析',
        '    role: pm',
        '    consumes: []',
        '    produces: requirement',
        '    isolate: false',
        'edges:',
        '  - from: n1',
        '    to: n1',
        '    when: "true"',
        '    description: 自环',
      ].join('\n'),
    );
    expect(() => loadWorkflow(dir, 'edge_no_missing')).toThrow(/on_missing（条件不满足时的失败语义）/);
  });

  it('边 on_missing 取值非法时校验失败（中文错误）', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'workflows', 'edge_bad_missing.yaml'),
      [
        'id: edge_bad_missing',
        'start: n1',
        'nodes:',
        '  - id: n1',
        '    title: 需求分析',
        '    role: pm',
        '    consumes: []',
        '    produces: requirement',
        '    isolate: false',
        'edges:',
        '  - from: n1',
        '    to: n1',
        '    when: "true"',
        '    description: 自环',
        '    on_missing: ignore',
      ].join('\n'),
    );
    expect(() => loadWorkflow(dir, 'edge_bad_missing')).toThrow(/on_missing（条件不满足时的失败语义）只能是 fail 或 wait/);
  });

  it('边声明的 description 与 on_missing 在加载后可读', () => {
    const dir = makeConfigDir();
    writeFileSync(
      join(dir, 'workflows', 'edge_ok.yaml'),
      [
        'id: edge_ok',
        'start: n1',
        'nodes:',
        '  - id: n1',
        '    title: 需求分析',
        '    role: pm',
        '    consumes: []',
        '    produces: requirement',
        '    isolate: false',
        'edges:',
        '  - from: n1',
        '    to: n1',
        '    when: "true"',
        '    description: 自环等待',
        '    on_missing: wait',
      ].join('\n'),
    );
    const wf = loadWorkflow(dir, 'edge_ok');
    expect(wf.edges[0]?.description).toBe('自环等待');
    expect(wf.edges[0]?.onMissing).toBe('wait');
  });
});