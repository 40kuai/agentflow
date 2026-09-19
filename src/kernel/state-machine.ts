import type { WorkflowDef, WorkflowEdgeDef } from '../shared/domain.js';
import type { FailureReason } from '../shared/events.js';
import { ExpressionError, evaluateExpression, type Facts } from './expression.js';
import type { TaskState } from './projector.js';

/** 同一节点被启动的最大次数，超出即判定死循环 */
const MAX_NODE_VISITS = 3;

/** 某一时刻相关产物的状态快照：转移决策"判定依据"的可机读形态 */
export type ArtifactStatusSnapshot = { type: string; status: string };

/**
 * 一条边的求值结果——可解释性的最小单元。
 * `when` / `description` 都是**原文透传**：`description` 直接取自工作流边的 `description` 字段
 * （Task 2 已让拓扑自解释），引擎里不另造一套人类可读说明。
 */
export type EdgeEvaluation = {
  from: string;
  to: string;
  /** 条件表达式原文；无条件边为 null */
  when: string | null;
  /** 该边的人类可读说明（工作流配置原文）；未声明则为 null */
  description: string | null;
  matched: boolean;
  /** 选中/未选中的原因（人类可读） */
  reason: string;
};

/** 失败时的结构化解释：同时给出分类、未满足的条件与相关产物的实际状态 */
export type DecisionFailure = {
  category: FailureReason;
  /** 未满足的条件（表达式原文清单） */
  unmetConditions: string[];
  /** 判定依据：相关产物的实际状态 */
  artifactStatuses: ArtifactStatusSnapshot[];
};

/**
 * 决策结果（结构化、可解释）。
 *
 * 与旧形状（`{kind, nodeId, reason}`）的差别：`start` 用**激活节点集合** `nodeIds` 取代单个 `nodeId`
 * （支持多于一个，为后续 fan-out 铺路；当前内核仍是串行消费，只激活一个），并带上
 * **被选中的边**与**未选中的边及各自原因**；`end` 为失败时附 `failure` 结构化原因。
 * 「无法推进」在本类型上即区分为 `end/status:failed`（无条件满足）与 `wait`（仍有节点在运行）。
 */
export type Decision =
  | {
      kind: 'start';
      /** 本批被激活的节点集合（支持多于一个；当前串行只含一个） */
      nodeIds: string[];
      /** 被选中的边；起始节点无入边时为 [] */
      selectedEdges: EdgeEvaluation[];
      /** 已求值但未被选中的边及各自原因（首条匹配即返回，之后的边不再求值） */
      skippedEdges: EdgeEvaluation[];
      reason: string;
    }
  | {
      kind: 'end';
      status: 'completed' | 'failed';
      reason: string;
      /** 仅在 status === 'failed' 时给出 */
      failure?: DecisionFailure;
    }
  | { kind: 'wait'; reason: string; runningNodeIds: string[] };

export type DecideInput = {
  workflow: WorkflowDef;
  state: TaskState;
  facts: Facts;
};

/** 求值一条边的条件；空 when 视为无条件匹配。不抛错——求值失败即判为不匹配，原因写进评价里 */
function evaluateEdge(edge: WorkflowEdgeDef, facts: Facts): EdgeEvaluation {
  const when = edge.when && edge.when.trim() !== '' ? edge.when : null;
  const description = edge.description ?? null;
  const base = { from: edge.from, to: edge.to, when, description };

  if (when === null) {
    return { ...base, matched: true, reason: '无条件边' };
  }
  try {
    const matched = evaluateExpression(when, facts);
    return {
      ...base,
      matched,
      // 选中时保留表达式原文（与既有 transfer.reason 的语义一致）；未选中时说明求值结果为 false
      reason: matched ? when : `条件求值结果为 false（表达式：${when}）`,
    };
  } catch (error) {
    const detail = error instanceof ExpressionError ? error.message : String(error);
    return { ...base, matched: false, reason: `条件求值失败：${detail}` };
  }
}

/** 相关产物的实际状态快照（转移决策与失败原因的"判定依据"） */
function artifactStatusSnapshot(state: TaskState): ArtifactStatusSnapshot[] {
  return state.artifacts.map((a) => ({ type: a.type, status: a.status }));
}

function artifactStatusText(snapshot: ArtifactStatusSnapshot[]): string {
  return snapshot.length > 0
    ? snapshot.map((s) => `${s.type}=${s.status}`).join(', ')
    : '（无产物）';
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
    // 等待与失败必须区分：仍有节点在运行时是 wait，而不是 failed
    return {
      kind: 'wait',
      reason: `节点 ${state.currentNodeIds.join(', ')} 仍在运行`,
      runningNodeIds: [...state.currentNodeIds],
    };
  }

  const lastNodeId = lastCompletedNodeId(state, workflow);
  if (lastNodeId === null) {
    return {
      kind: 'start',
      nodeIds: [workflow.start],
      selectedEdges: [],
      skippedEdges: [],
      reason: '任务开始，进入起始节点',
    };
  }

  const artifactStatuses = artifactStatusSnapshot(state);
  const outgoing = workflow.edges.filter((e) => e.from === lastNodeId);
  if (outgoing.length === 0) {
    const node = workflow.nodes.find((n) => n.id === lastNodeId);
    if (node) {
      return { kind: 'end', status: 'completed', reason: '流程已走完，无后继节点' };
    }
    return {
      kind: 'end',
      status: 'failed',
      reason: `完成的节点 ${lastNodeId} 不在流程定义中`,
      failure: { category: 'other', unmetConditions: [], artifactStatuses },
    };
  }

  const skippedEdges: EdgeEvaluation[] = [];
  for (const edge of outgoing) {
    const evaluation = evaluateEdge(edge, facts);
    if (!evaluation.matched) {
      skippedEdges.push(evaluation);
      continue;
    }
    const visits = state.visitCounts[edge.to] ?? 0;
    // 死循环保护：判据是「目标节点被反复进入」这件事本身，
    // 刻意**不**要求该节点曾经成功完成——否则在「反复失败重试」场景下保护会失效，
    // 而那正是最该拦住的场景（spec §9.4：visit_count 检测同状态反复进入 → 升级）。
    if (visits >= MAX_NODE_VISITS) {
      return {
        kind: 'end',
        status: 'failed',
        reason: `节点 ${edge.to} 访问次数已达 ${visits} 次，判定为死循环`,
        failure: { category: 'other', unmetConditions: [], artifactStatuses },
      };
    }
    return {
      kind: 'start',
      nodeIds: [edge.to],
      selectedEdges: [evaluation],
      skippedEdges,
      reason: evaluation.reason,
    };
  }

  // 无可用转移必须落到明确的 failed，并把**未满足的条件**、**当前产物状态**与**分类化原因**一并给出：
  // 边条件（如 all(artifacts.requirement.status == 'ok')）不成立的真实原因通常是
  // 模型把 status 判成了 blocked / needs_changes，只说"条件不满足"会让使用者无从判断。
  const unmet = skippedEdges.map((e) => `${e.from}→${e.to}: ${e.reason}`).join(' | ');
  return {
    kind: 'end',
    status: 'failed',
    reason: `节点 ${lastNodeId} 完成后没有可用的转移：${unmet}；当前产物状态：${artifactStatusText(artifactStatuses)}`,
    failure: {
      category: 'condition_unmet',
      unmetConditions: skippedEdges
        .map((e) => e.when)
        .filter((when): when is string => when !== null),
      artifactStatuses,
    },
  };
}