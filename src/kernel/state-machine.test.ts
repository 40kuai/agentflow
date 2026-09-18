import { describe, expect, it } from 'vitest';
import { decideNext } from './state-machine.js';
import { buildFacts } from './facts.js';
import { project } from './projector.js';
import type { KernelEvent } from '../shared/events.js';
import type { WorkflowDef } from '../shared/domain.js';

const workflow: WorkflowDef = {
  id: 'simple_dev',
  start: 'pm_analyze',
  nodes: [
    { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
    { id: 'dev_implement', title: '编码实现', role: 'backend_dev', consumes: ['requirement'], produces: 'code_diff', isolate: true },
    { id: 'qa_verify', title: '测试验证', role: 'qa_engineer', consumes: ['code_diff'], produces: 'test_report', isolate: false },
  ],
  edges: [
    { from: 'pm_analyze', to: 'dev_implement', when: "all(artifacts.requirement.status == 'ok')" },
    { from: 'dev_implement', to: 'qa_verify', when: "all(artifacts.code_diff.status == 'ok')" },
  ],
};

function ev(type: KernelEvent['type'], payload: Record<string, unknown>, seq: number): KernelEvent {
  return { seq, event_id: `e${seq}`, task_id: 'task_1', type, payload, actor: 'test', created_at: seq };
}

function decide(events: KernelEvent[]) {
  const state = project(events);
  const facts = buildFacts({ state, workflow, roles: new Map() });
  return decideNext({ workflow, state, facts });
}

describe('decideNext', () => {
  it('初始状态从 start 节点开始', () => {
    const d = decide([ev('task.created', { title: 't', requirement_raw: 'r', base_branch: 'main' }, 1)]);
    expect(d).toEqual({ kind: 'start', nodeId: 'pm_analyze', reason: '任务开始，进入起始节点' });
  });

  it('有节点运行中时等待', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
    ]);
    expect(d.kind).toBe('wait');
  });

  it('节点成功后条件满足则转移到下游', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      ev('artifact.created', {
        artifact_id: 'a1', run_id: 'run_1', node_id: 'pm_analyze',
        type: 'requirement', status: 'ok', summary: 's',
      }, 3),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 4),
    ]);
    expect(d).toEqual({ kind: 'start', nodeId: 'dev_implement', reason: "all(artifacts.requirement.status == 'ok')" });
  });

  it('条件不满足时任务失败收尾', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      // 产出 blocked 的 requirement
      ev('artifact.created', {
        artifact_id: 'a1', run_id: 'run_1', node_id: 'pm_analyze',
        type: 'requirement', status: 'blocked', summary: '需求有歧义',
      }, 3),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 4),
    ]);
    expect(d.kind).toBe('end');
    if (d.kind === 'end') {
      expect(d.status).toBe('failed');
      expect(d.reason).toContain('没有可用的转移');
    }
  });

  it('无条件边（when 为空）总是匹配', () => {
    const wf: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'pm_analyze', to: 'dev_implement' }],
    };
    const state = project([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 3),
    ]);
    const facts = buildFacts({ state, workflow: wf, roles: new Map() });
    expect(decideNext({ workflow: wf, state, facts })).toEqual({
      kind: 'start', nodeId: 'dev_implement', reason: '无条件边',
    });
  });

  it('多条出边按声明顺序取第一条匹配的', () => {
    const wf: WorkflowDef = {
      ...workflow,
      edges: [
        { from: 'pm_analyze', to: 'qa_verify', when: "all(artifacts.requirement.status == 'ok')" },
        { from: 'pm_analyze', to: 'dev_implement', when: 'true' },
      ],
    };
    const state = project([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      ev('artifact.created', {
        artifact_id: 'a1', run_id: 'run_1', node_id: 'pm_analyze',
        type: 'requirement', status: 'ok', summary: 's',
      }, 3),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 4),
    ]);
    const facts = buildFacts({ state, workflow: wf, roles: new Map() });
    const d = decideNext({ workflow: wf, state, facts });
    expect(d).toMatchObject({ kind: 'start', nodeId: 'qa_verify' });
  });

  it('没有出边的末节点成功后任务完成', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'qa_verify', role_id: 'qa_engineer', run_id: 'run_3', attempt: 1 }, 2),
      ev('node.succeeded', { node_id: 'qa_verify', run_id: 'run_3', log_ref: 'x' }, 3),
    ]);
    expect(d).toEqual({ kind: 'end', status: 'completed', reason: '流程已走完，无后继节点' });
  });

  it('任务已终态时不再推进', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('task.completed', { reason: 'done' }, 2),
    ]);
    expect(d.kind).toBe('end');
  });

  it('同一节点访问超过 3 次时判定死循环', () => {
    // 必须用真正的自环（pm→pm）来触发保护：保护机制检查的是"即将启动的目标节点"
    // 的访问次数，若目标是 dev 且从未启动过，访问次数为 0，不会被拦住。
    const loopWorkflow: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'pm_analyze', to: 'pm_analyze', when: 'true' }],
    };

    const events: KernelEvent[] = [ev('task.created', {}, 1)];
    let seq = 2;
    for (let i = 0; i < 4; i += 1) {
      events.push(ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: `run_${i}`, attempt: i + 1 }, seq++));
      events.push(ev('artifact.created', {
        artifact_id: `a${i}`, run_id: `run_${i}`, node_id: 'pm_analyze',
        type: 'requirement', status: 'ok', summary: 's',
      }, seq++));
      events.push(ev('node.succeeded', { node_id: 'pm_analyze', run_id: `run_${i}`, log_ref: 'x' }, seq++));
    }

    const state = project(events);
    const facts = buildFacts({ state, workflow: loopWorkflow, roles: new Map() });
    const d = decideNext({ workflow: loopWorkflow, state, facts });

    expect(d.kind).toBe('end');
    if (d.kind === 'end') {
      expect(d.status).toBe('failed');
      expect(d.reason).toContain('访问次数');
    }
  });

  it('目标节点访问次数未超限时不会误判为死循环', () => {
    // 自环跑 1 次后继续判定，应当仍允许再次进入（1 < 3），而不是直接判死循环
    const loopWorkflow: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'pm_analyze', to: 'pm_analyze', when: 'true' }],
    };
    const events: KernelEvent[] = [
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_0', attempt: 1 }, 2),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_0', log_ref: 'x' }, 3),
    ];
    const state = project(events);
    const facts = buildFacts({ state, workflow: loopWorkflow, roles: new Map() });
    const d = decideNext({ workflow: loopWorkflow, state, facts });
    expect(d).toMatchObject({ kind: 'start', nodeId: 'pm_analyze' });
  });

  it('条件表达式求值失败时不会崩溃，而是判为不匹配', () => {
    const wf: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'pm_analyze', to: 'dev_implement', when: 'nonexistent.path == 1' }],
    };
    const state = project([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 3),
    ]);
    const facts = buildFacts({ state, workflow: wf, roles: new Map() });
    const d = decideNext({ workflow: wf, state, facts });
    expect(d.kind).toBe('end');
  });
});