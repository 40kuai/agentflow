import { describe, expect, it } from 'vitest';
import { project } from './projector.js';
import type { KernelEvent } from '../shared/events.js';

let seq = 0;
function ev(type: KernelEvent['type'], payload: Record<string, unknown>): KernelEvent {
  seq += 1;
  return {
    seq,
    event_id: `evt_${seq}`,
    task_id: 'task_1',
    type,
    payload,
    actor: 'test',
    created_at: 1_700_000_000_000 + seq,
  };
}

describe('project', () => {
  it('空事件流产出初始状态', () => {
    const s = project([]);
    expect(s.status).toBe('active');
    expect(s.currentNodeIds).toEqual([]);
    expect(s.artifacts).toEqual([]);
    expect(s.completedNodeIds).toEqual([]);
  });

  it('task.created 填充任务元信息', () => {
    const s = project([
      ev('task.created', {
        title: '自动流转',
        requirement_raw: '让多角色自动流转',
        base_branch: 'main',
      }),
    ]);
    expect(s.title).toBe('自动流转');
    expect(s.requirementRaw).toBe('让多角色自动流转');
    expect(s.baseBranch).toBe('main');
  });

  it('node.started 把节点置为当前节点并累加 visitCount', () => {
    const s = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
    ]);
    expect(s.currentNodeIds).toEqual(['pm_analyze']);
    expect(s.nodes.pm_analyze?.status).toBe('running');
    expect(s.visitCounts.pm_analyze).toBe(1);
  });

  it('node.started 带 log_ref 时立即写入 lastLogRef（运行中即可见日志）', () => {
    const s = project([
      ev('node.queued', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('node.started', {
        node_id: 'pm_analyze',
        role_id: 'pm',
        run_id: 'run_1',
        attempt: 1,
        log_ref: 'logs/runs/run_1.jsonl',
      }),
    ]);
    // queued 先把它重置为 null，started 再写回：重放顺序 queued → started，最终值非空
    expect(s.nodes.pm_analyze?.status).toBe('running');
    expect(s.nodes.pm_analyze?.lastLogRef).toBe('logs/runs/run_1.jsonl');
  });

  it('node.started 缺 log_ref 时回退为 previous 值（历史事件兼容）', () => {
    const s = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
    ]);
    expect(s.nodes.pm_analyze?.lastLogRef).toBeNull();
  });

  it('node.succeeded 把节点移出当前节点并加入已完成', () => {
    const s = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'logs/runs/run_1.jsonl' }),
    ]);
    expect(s.currentNodeIds).toEqual([]);
    expect(s.completedNodeIds).toEqual(['pm_analyze']);
    expect(s.nodes.pm_analyze?.status).toBe('succeeded');
    expect(s.nodes.pm_analyze?.lastLogRef).toBe('logs/runs/run_1.jsonl');
  });

  it('node.failed 记录错误信息，节点不进入 completed', () => {
    const s = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('node.failed', { node_id: 'pm_analyze', run_id: 'run_1', error: 'CLI 退出码 1' }),
    ]);
    expect(s.completedNodeIds).toEqual([]);
    expect(s.nodes.pm_analyze?.status).toBe('failed');
    expect(s.nodes.pm_analyze?.lastError).toBe('CLI 退出码 1');
  });

  it('artifact.created 追加产物并挂到对应节点', () => {
    const s = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('artifact.created', {
        artifact_id: 'art_1',
        run_id: 'run_1',
        node_id: 'pm_analyze',
        type: 'requirement',
        status: 'ok',
        summary: '需求已澄清',
      }),
    ]);
    expect(s.artifacts.map((a) => a.artifact_id)).toEqual(['art_1']);
    expect(s.nodes.pm_analyze?.artifactIds).toEqual(['art_1']);
  });

  it('artifact.invalidated 同时清理节点上的 artifactIds，不留悬空 id', () => {
    const s = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('artifact.created', {
        artifact_id: 'art_1',
        run_id: 'run_1',
        node_id: 'pm_analyze',
        type: 'requirement',
        status: 'ok',
        summary: 's',
      }),
      ev('artifact.invalidated', { artifact_id: 'art_1' }),
    ]);
    expect(s.artifacts).toEqual([]);
    expect(s.nodes.pm_analyze?.artifactIds).toEqual([]);

    // 同一节点上另一个产物不受影响
    const s2 = project([
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('artifact.created', {
        artifact_id: 'art_1',
        run_id: 'run_1',
        node_id: 'pm_analyze',
        type: 'requirement',
        status: 'ok',
        summary: 's1',
      }),
      ev('artifact.created', {
        artifact_id: 'art_2',
        run_id: 'run_1',
        node_id: 'pm_analyze',
        type: 'requirement',
        status: 'ok',
        summary: 's2',
      }),
      ev('artifact.invalidated', { artifact_id: 'art_1' }),
    ]);
    expect(s2.artifacts.map((a) => a.artifact_id)).toEqual(['art_2']);
    expect(s2.nodes.pm_analyze?.artifactIds).toEqual(['art_2']);
  });

  it('transfer.decided 记录转移历史', () => {
    const s = project([
      ev('transfer.decided', {
        from: 'pm_analyze',
        to: 'dev_implement',
        reason: 'requirement.status == ok',
        decided_by: 'rule',
      }),
    ]);
    expect(s.transfers).toEqual([
      { from: 'pm_analyze', to: 'dev_implement', reason: 'requirement.status == ok', decidedBy: 'rule' },
    ]);
  });

  it('node.usage_recorded 累加预算消耗', () => {
    const s = project([
      ev('node.usage_recorded', { node_id: 'pm_analyze', run_id: 'run_1', cost_usd: 0.12, tokens_in: 100, tokens_out: 50 }),
      ev('node.usage_recorded', { node_id: 'dev_implement', run_id: 'run_2', cost_usd: 0.08, tokens_in: 200, tokens_out: 80 }),
    ]);
    expect(s.budgetUsedUsd).toBeCloseTo(0.2, 6);
  });

  it('task.completed 改变任务状态', () => {
    const s = project([ev('task.completed', { reason: '流程图走完' })]);
    expect(s.status).toBe('completed');
  });

  it('重放同一事件序列两次结果完全一致（确定性）', () => {
    const events = [
      ev('task.created', { title: 't', requirement_raw: 'r', base_branch: 'main' }),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }),
    ];
    expect(project(events)).toEqual(project(events));
  });
});