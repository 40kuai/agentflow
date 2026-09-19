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
    expect(d).toEqual({
      kind: 'start',
      nodeIds: ['pm_analyze'],
      selectedEdges: [],
      skippedEdges: [],
      reason: '任务开始，进入起始节点',
    });
  });

  it('有节点运行中时等待（wait 与 failed 必须区分）', () => {
    const d = decide([
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
    ]);
    expect(d.kind).toBe('wait');
    if (d.kind === 'wait') {
      expect(d.runningNodeIds).toEqual(['pm_analyze']);
    }
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
    expect(d).toEqual({
      kind: 'start',
      nodeIds: ['dev_implement'],
      selectedEdges: [
        {
          from: 'pm_analyze',
          to: 'dev_implement',
          when: "all(artifacts.requirement.status == 'ok')",
          description: null,
          matched: true,
          reason: "all(artifacts.requirement.status == 'ok')",
        },
      ],
      skippedEdges: [],
      reason: "all(artifacts.requirement.status == 'ok')",
    });
  });

  it('条件不满足时任务失败收尾，原因含分类 / 未满足条件 / 产物实际状态', () => {
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
      // 失败原因三要素：分类化原因 + 未满足的条件 + 相关产物实际状态
      expect(d.failure?.category).toBe('condition_unmet');
      expect(d.failure?.unmetConditions).toEqual(["all(artifacts.requirement.status == 'ok')"]);
      expect(d.failure?.artifactStatuses).toEqual([{ type: 'requirement', status: 'blocked' }]);
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
      kind: 'start',
      nodeIds: ['dev_implement'],
      selectedEdges: [
        { from: 'pm_analyze', to: 'dev_implement', when: null, description: null, matched: true, reason: '无条件边' },
      ],
      skippedEdges: [],
      reason: '无条件边',
    });
  });

  it('多条出边按声明顺序取第一条匹配的，未选中的边带各自原因', () => {
    const wf: WorkflowDef = {
      ...workflow,
      edges: [
        { from: 'pm_analyze', to: 'qa_verify', when: 'false', description: '先到 qa', onMissing: 'fail' },
        { from: 'pm_analyze', to: 'dev_implement', when: 'true', description: '再到 dev', onMissing: 'fail' },
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
    expect(d).toMatchObject({ kind: 'start', nodeIds: ['dev_implement'] });
    if (d.kind === 'start') {
      // 被选中边：人类可读说明直接取自边配置的 description
      expect(d.selectedEdges).toEqual([
        { from: 'pm_analyze', to: 'dev_implement', when: 'true', description: '再到 dev', matched: true, reason: 'true' },
      ]);
      // 未选中边及其原因
      expect(d.skippedEdges).toEqual([
        {
          from: 'pm_analyze',
          to: 'qa_verify',
          when: 'false',
          description: '先到 qa',
          matched: false,
          reason: '条件求值结果为 false（表达式：false）',
        },
      ]);
    }
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
      edges: [{ from: 'pm_analyze', to: 'pm_analyze', when: 'true', description: '自环', onMissing: 'fail' }],
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
      edges: [{ from: 'pm_analyze', to: 'pm_analyze', when: 'true', description: '自环', onMissing: 'fail' }],
    };
    const events: KernelEvent[] = [
      ev('task.created', {}, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_0', attempt: 1 }, 2),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_0', log_ref: 'x' }, 3),
    ];
    const state = project(events);
    const facts = buildFacts({ state, workflow: loopWorkflow, roles: new Map() });
    const d = decideNext({ workflow: loopWorkflow, state, facts });
    expect(d).toMatchObject({ kind: 'start', nodeIds: ['pm_analyze'] });
  });

  it('条件表达式求值失败时不会崩溃，而是判为不匹配（跳过原因说明求值失败）', () => {
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
    if (d.kind === 'end') {
      expect(d.status).toBe('failed');
      expect(d.failure?.category).toBe('condition_unmet');
      expect(d.failure?.unmetConditions).toEqual(['nonexistent.path == 1']);
      expect(d.failure?.artifactStatuses).toEqual([]);
    }
  });

  it('目标节点反复进入但从未成功完成时，同样判定为死循环', () => {
    // 这条用例钉住的是「死循环保护的判据是反复进入本身，而非完成过再进入」。
    // 若将来有人给保护加上「且已在 completedNodeIds 中」这个条件，
    // 本用例会变红——那正是我们要防止的退化：
    // 在「反复失败重试」场景下，该条件会让保护失效，而那是 SSD 最该拦住的场景。
    //
    // 注意：必须先用另一个节点完成，让 pm_analyze 成为「即将启动的目标节点」——
    // 若没有任何节点完成过，decideNext 会按规则 3 回到 start 节点，根本走不到死循环保护。
    const retryWorkflow: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'dev_implement', to: 'pm_analyze', when: 'true', description: '回退重试', onMissing: 'fail' }],
    };

    const events: KernelEvent[] = [ev('task.created', {}, 1)];
    let seq = 2;
    // pm_analyze 被反复进入 3 次，每次都是 started 后 failed（从未 succeeded，因此不进 completedNodeIds）
    for (let i = 0; i < 3; i += 1) {
      events.push(ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: `run_${i}`, attempt: i + 1 }, seq++));
      events.push(ev('node.failed', { node_id: 'pm_analyze', run_id: `run_${i}`, error: '模拟失败' }, seq++));
    }
    // 另一个节点完成，使 pm_analyze 成为「即将启动的目标节点」
    events.push(ev('node.started', { node_id: 'dev_implement', role_id: 'backend_dev', run_id: 'run_dev', attempt: 1 }, seq++));
    events.push(ev('node.succeeded', { node_id: 'dev_implement', run_id: 'run_dev', log_ref: 'x' }, seq++));

    const state = project(events);
    // 前提断言：待进入的目标节点 pm_analyze 确实从未完成过（因此不在 completedNodeIds 中）
    expect(state.completedNodeIds).toEqual(['dev_implement']);
    expect(state.visitCounts.pm_analyze).toBe(3);

    const facts = buildFacts({ state, workflow: retryWorkflow, roles: new Map() });
    const d = decideNext({ workflow: retryWorkflow, state, facts });

    expect(d.kind).toBe('end');
    if (d.kind === 'end') {
      expect(d.status).toBe('failed');
      expect(d.reason).toContain('访问次数');
    }
  });
});