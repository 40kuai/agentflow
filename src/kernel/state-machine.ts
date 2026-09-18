import type { WorkflowDef, WorkflowEdgeDef } from '../shared/domain.js';
import { ExpressionError, evaluateExpression, type Facts } from './expression.js';
import type { TaskState } from './projector.js';

/** 同一节点被启动的最大次数，超出即判定死循环 */
const MAX_NODE_VISITS = 3;

export type Decision =
  | { kind: 'start'; nodeId: string; reason: string }
  | { kind: 'end'; status: 'completed' | 'failed'; reason: string }
  | { kind: 'wait'; reason: string };

export type DecideInput = {
  workflow: WorkflowDef;
  state: TaskState;
  facts: Facts;
};

/** 求值一条边的条件；空 when 视为无条件匹配 */
function edgeMatches(edge: WorkflowEdgeDef, facts: Facts): { matched: boolean; reason: string } {
  if (!edge.when || edge.when.trim() === '') {
    return { matched: true, reason: '无条件边' };
  }
  try {
    const matched = evaluateExpression(edge.when, facts);
    return { matched, reason: edge.when };
  } catch (error) {
    const detail = error instanceof ExpressionError ? error.message : String(error);
    return { matched: false, reason: `条件求值失败：${detail}` };
  }
}

/** 找到"刚完成、需要判定后继"的那个节点：优先取最后一个完成的节点 */
function lastCompletedNodeId(state: TaskState, workflow: WorkflowDef): string | null {
  const known = new Set(workflow.nodes.map((n) => n.id));
  for (let i = state.completedNodeIds.length - 1; i >= 0; i -= 1) {
    const id = state.completedNodeIds[i]!;
    if (known.has(id)) return id;
  }
  return null;
}

export function decideNext(input: DecideInput): Decision {
  const { workflow, state, facts } = input;

  if (state.status === 'completed') {
    return { kind: 'end', status: 'completed', reason: '任务已完成' };
  }
  if (state.status === 'failed') {
    return { kind: 'end', status: 'failed', reason: '任务已失败' };
  }

  if (state.currentNodeIds.length > 0) {
    return { kind: 'wait', reason: `节点 ${state.currentNodeIds.join(', ')} 仍在运行` };
  }

  const lastNodeId = lastCompletedNodeId(state, workflow);
  if (lastNodeId === null) {
    return { kind: 'start', nodeId: workflow.start, reason: '任务开始，进入起始节点' };
  }

  const outgoing = workflow.edges.filter((e) => e.from === lastNodeId);
  if (outgoing.length === 0) {
    const node = workflow.nodes.find((n) => n.id === lastNodeId);
    if (node) {
      return { kind: 'end', status: 'completed', reason: '流程已走完，无后继节点' };
    }
    return { kind: 'end', status: 'failed', reason: `完成的节点 ${lastNodeId} 不在流程定义中` };
  }

  const failures: string[] = [];
  for (const edge of outgoing) {
    const { matched, reason } = edgeMatches(edge, facts);
    if (!matched) {
      failures.push(`${edge.from}→${edge.to}: ${reason}`);
      continue;
    }
    const visits = state.visitCounts[edge.to] ?? 0;
    if (visits >= MAX_NODE_VISITS) {
      return {
        kind: 'end',
        status: 'failed',
        reason: `节点 ${edge.to} 访问次数已达 ${visits} 次，判定为死循环`,
      };
    }
    return { kind: 'start', nodeId: edge.to, reason };
  }

  return {
    kind: 'end',
    status: 'failed',
    reason: `节点 ${lastNodeId} 完成后没有可用的转移：${failures.join(' | ')}`,
  };
}