import type { RoleDef, WorkflowDef } from '../shared/domain.js';
import type { Facts } from './expression.js';
import type { TaskState } from './projector.js';

export type BuildFactsInput = {
  state: TaskState;
  workflow: WorkflowDef;
  roles: Map<string, RoleDef>;
};

/** 按 artifact 类型聚合成下游条件表达式可以直接引用的形状 */
function buildArtifactFacts(state: TaskState): Record<string, unknown> {
  const byType: Record<string, unknown> = {};
  for (const artifact of state.artifacts) {
    const bucket = (byType[artifact.type] as Record<string, unknown> | undefined) ?? {};
    const statuses = (bucket['status'] as string[] | undefined) ?? [];
    statuses.push(artifact.status);
    bucket['status'] = statuses;
    byType[artifact.type] = bucket;
  }
  return byType;
}

/**
 * 从任务状态构建条件表达式的可用事实。
 * 只暴露流程判断真正需要的信息——不把整个 state 直接倒进去。
 */
export function buildFacts(input: BuildFactsInput): Facts {
  const { state } = input;

  const attempts: Record<string, number> = {};
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    attempts[nodeId] = node.attempt;
  }

  const workflowNodeIds = new Set(input.workflow.nodes.map((n) => n.id));
  const activeNodeId =
    state.currentNodeIds[0] ?? [...state.completedNodeIds].reverse().find((id) => workflowNodeIds.has(id)) ?? '';

  return {
    task: {
      status: state.status,
      budget_used_usd: state.budgetUsedUsd,
    },
    run: {
      attempt: attempts[activeNodeId] ?? 1,
      active_node_id: activeNodeId,
    },
    node: {
      visit_count: state.visitCounts[activeNodeId] ?? 0,
      completed: state.completedNodeIds,
      current: state.currentNodeIds,
      failed: Object.values(state.nodes)
        .filter((n) => n.status === 'failed')
        .map((n) => n.nodeId),
    },
    artifacts: buildArtifactFacts(state),
    __functions: {
      // deps(x)：返回 x.depends_on 指向的对象数组。
      // Phase 1 没有真实工作包，返回空数组——空数组的 all() 为 true，语义上等于"无依赖"
      deps: () => [],
    },
  };
}