/**
 * 从事件流归集节点级花费与耗时。
 *
 * 为什么必须从事件归集：TaskState 只给任务级的 `budgetUsedUsd`，节点级没有任何直接字段。
 * 实际事件 payload 形状（读 src/kernel/kernel.ts 的 append 调用确认，非猜测）：
 *  - `node.usage_recorded`: { node_id, run_id, tokens_in, tokens_out, cost_usd }  ← 自带 node_id，首选
 *  - `budget.consumed`:     { run_id, cost_usd }                                   ← 只有 run_id，需反查节点
 *  - `node.queued` / `node.started`: { node_id, role_id, run_id, attempt }
 *  - `node.succeeded`: { node_id, run_id, log_ref }
 *  - `node.failed`:    { node_id, run_id, error, log_ref }
 * 一次 usage 会同时落 `node.usage_recorded` + `budget.consumed`（同额），
 * 因此按 run_id 去重：已由 node.usage_recorded 覆盖的 run 不再计 budget.consumed，避免翻倍。
 */

import type { KernelEvent, TaskState } from './api';
import { eventTime } from './format';
import { payloadNumber, payloadString, runIdToNodeId } from './logparse';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type RunAggregate = {
  runId: string;
  nodeId: string;
  attempt: number;
  startedAt: number | null;
  endedAt: number | null;
  status: RunStatus;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  logRef: string | null;
};

export type NodeAggregate = {
  nodeId: string;
  roleId: string;
  status: string;
  attempt: number;
  runId: string | null;
  artifactIds: string[];
  lastLogRef: string | null;
  lastError: string | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** 已完成尝试的耗时合计 + 运行中尝试的实时耗时 */
  durationMs: number;
  firstStartedAt: number | null;
  lastEndedAt: number | null;
  visitCount: number;
  runs: RunAggregate[];
};

export type TaskAggregate = {
  nodes: NodeAggregate[];
  taskStartedAt: number | null;
  taskEndedAt: number | null;
  /** 事件流归集出的总花费（用于与 TaskState.budgetUsedUsd 交叉核对） */
  costFromEvents: number;
  costFromUsageEvents: number;
  costFromBudgetEvents: number;
  eventCount: number;
};

type RunAccumulator = RunAggregate & { seenUsage: boolean };

function ensureRun(
  runs: Map<string, RunAccumulator>,
  runId: string,
  nodeId: string,
  attempt: number,
): RunAccumulator {
  const existing = runs.get(runId);
  if (existing) {
    if (!existing.nodeId && nodeId) existing.nodeId = nodeId;
    if (!existing.attempt && attempt) existing.attempt = attempt;
    return existing;
  }
  const created: RunAccumulator = {
    runId,
    nodeId,
    attempt,
    startedAt: null,
    endedAt: null,
    status: 'queued',
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    logRef: null,
    seenUsage: false,
  };
  runs.set(runId, created);
  return created;
}

export function aggregateTask(
  state: TaskState | null,
  events: KernelEvent[],
  now: number,
): TaskAggregate {
  const runs = new Map<string, RunAccumulator>();
  const runToNode = runIdToNodeId(events);
  const nodeCostFromUsage = new Map<string, number>();
  const coveredRuns = new Set<string>();
  const budgetEntries: { runId: string; costUsd: number }[] = [];
  let costFromUsageEvents = 0;
  let costFromBudgetEvents = 0;
  let taskStartedAt: number | null = null;
  let taskEndedAt: number | null = null;

  for (const event of events) {
    const payload = event.payload ?? {};
    const ts = eventTime(event);
    const nodeId = payloadString(payload, 'node_id');
    const runId = payloadString(payload, 'run_id');
    const attempt = payloadNumber(payload, 'attempt');

    switch (event.type) {
      case 'task.created': {
        if (taskStartedAt === null || (ts > 0 && ts < taskStartedAt)) taskStartedAt = ts;
        break;
      }
      case 'task.completed':
      case 'task.failed': {
        if (ts > 0 && (taskEndedAt === null || ts > taskEndedAt)) taskEndedAt = ts;
        break;
      }
      case 'node.queued': {
        if (runId) ensureRun(runs, runId, nodeId, attempt);
        if (taskStartedAt === null || (ts > 0 && ts < taskStartedAt)) taskStartedAt = ts;
        break;
      }
      case 'node.started': {
        if (runId) {
          const run = ensureRun(runs, runId, nodeId, attempt);
          run.startedAt = ts > 0 ? ts : run.startedAt;
          run.status = 'running';
        }
        if (taskStartedAt === null || (ts > 0 && ts < taskStartedAt)) taskStartedAt = ts;
        break;
      }
      case 'node.succeeded': {
        if (runId) {
          const run = ensureRun(runs, runId, nodeId, attempt);
          run.endedAt = ts > 0 ? ts : run.endedAt;
          run.status = 'succeeded';
          run.logRef = payloadString(payload, 'log_ref') || run.logRef;
        }
        break;
      }
      case 'node.failed': {
        if (runId) {
          const run = ensureRun(runs, runId, nodeId, attempt);
          run.endedAt = ts > 0 ? ts : run.endedAt;
          run.status = 'failed';
          run.logRef = payloadString(payload, 'log_ref') || run.logRef;
        }
        break;
      }
      case 'node.cancelled': {
        if (runId) {
          const run = ensureRun(runs, runId, nodeId, attempt);
          run.endedAt = ts > 0 ? ts : run.endedAt;
          run.status = 'cancelled';
        }
        break;
      }
      case 'node.usage_recorded': {
        const cost = payloadNumber(payload, 'cost_usd');
        const tokensIn = payloadNumber(payload, 'tokens_in');
        const tokensOut = payloadNumber(payload, 'tokens_out');
        costFromUsageEvents += cost;
        if (runId) {
          coveredRuns.add(runId);
          const run = ensureRun(runs, runId, nodeId, attempt);
          run.seenUsage = true;
          run.costUsd += cost;
          run.tokensIn += tokensIn;
          run.tokensOut += tokensOut;
        }
        const owner = nodeId || (runId ? (runToNode.get(runId) ?? '') : '');
        if (owner) nodeCostFromUsage.set(owner, (nodeCostFromUsage.get(owner) ?? 0) + cost);
        break;
      }
      case 'budget.consumed': {
        const cost = payloadNumber(payload, 'cost_usd');
        costFromBudgetEvents += cost;
        if (runId) budgetEntries.push({ runId, costUsd: cost });
        break;
      }
      default:
        // 其余事件（artifact.created / transfer.decided / wp.* / budget.exceeded 等）不参与花费归集
        break;
    }
  }

  // 未被 node.usage_recorded 覆盖的 budget.consumed：用 run_id → node_id 反查后补记
  const extraNodeCost = new Map<string, number>();
  for (const entry of budgetEntries) {
    if (coveredRuns.has(entry.runId)) continue;
    const owner = runToNode.get(entry.runId);
    if (!owner) continue;
    extraNodeCost.set(owner, (extraNodeCost.get(owner) ?? 0) + entry.costUsd);
  }

  const stateNodes = state?.nodes ?? {};
  const currentNodeIds = state?.currentNodeIds ?? [];
  const visitCounts = state?.visitCounts ?? {};

  // 节点集合：以 TaskState 投影为准（权威状态），并补上只在事件里出现过的节点
  const nodeIds = new Set<string>(Object.keys(stateNodes));
  for (const run of runs.values()) {
    if (run.nodeId) nodeIds.add(run.nodeId);
  }

  const nodes: NodeAggregate[] = [];
  for (const nodeId of nodeIds) {
    const nodeState = stateNodes[nodeId];
    const nodeRuns = [...runs.values()]
      .filter((run) => run.nodeId === nodeId)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.runId.localeCompare(b.runId));

    const isRunningNow =
      nodeState?.status === 'running' ||
      (currentNodeIds.includes(nodeId) && nodeState?.status !== 'succeeded' && nodeState?.status !== 'failed');

    let durationMs = 0;
    for (const run of nodeRuns) {
      if (run.startedAt === null) continue;
      if (run.endedAt !== null) {
        durationMs += Math.max(0, run.endedAt - run.startedAt);
      } else if (isRunningNow && run.runId === nodeState?.runId) {
        // 运行中的当前尝试：实时累计
        durationMs += Math.max(0, now - run.startedAt);
      } else if (isRunningNow && nodeState?.runId == null) {
        durationMs += Math.max(0, now - run.startedAt);
      }
    }

    const tokensIn = nodeRuns.reduce((sum, run) => sum + run.tokensIn, 0);
    const tokensOut = nodeRuns.reduce((sum, run) => sum + run.tokensOut, 0);
    const firstStartedAt = nodeRuns.find((run) => run.startedAt !== null)?.startedAt ?? null;
    const lastEndedAt =
      nodeRuns
        .map((run) => run.endedAt)
        .filter((ts): ts is number => ts !== null)
        .sort((a, b) => b - a)[0] ?? null;

    nodes.push({
      nodeId,
      roleId: nodeState?.roleId ?? '',
      status: nodeState?.status ?? nodeRuns.at(-1)?.status ?? 'unknown',
      attempt: nodeState?.attempt ?? nodeRuns.length,
      runId: nodeState?.runId ?? null,
      artifactIds: nodeState?.artifactIds ?? [],
      lastLogRef: nodeState?.lastLogRef ?? nodeRuns.at(-1)?.logRef ?? null,
      lastError: nodeState?.lastError ?? null,
      costUsd: (nodeCostFromUsage.get(nodeId) ?? 0) + (extraNodeCost.get(nodeId) ?? 0),
      tokensIn,
      tokensOut,
      durationMs,
      firstStartedAt,
      lastEndedAt,
      visitCount: visitCounts[nodeId] ?? nodeRuns.length,
      runs: nodeRuns.map(({ seenUsage: _seenUsage, ...rest }) => rest),
    });
  }

  // 稳定排序：按首次开始时间升序（未开始的排最后），再按 nodeId 兜底。
  // 不依赖对象键顺序，因为 nodes 是 Record，键序无契约保证。
  nodes.sort((a, b) => {
    if (a.firstStartedAt === null && b.firstStartedAt === null) return a.nodeId.localeCompare(b.nodeId);
    if (a.firstStartedAt === null) return 1;
    if (b.firstStartedAt === null) return -1;
    if (a.firstStartedAt !== b.firstStartedAt) return a.firstStartedAt - b.firstStartedAt;
    return a.nodeId.localeCompare(b.nodeId);
  });

  return {
    nodes,
    taskStartedAt,
    taskEndedAt,
    // usage 事件与 budget 事件对同一笔花费各记一次，直接相加会翻倍；
    // 以 node.usage_recorded 为准，budget 合计仅作交叉核对。
    costFromEvents: costFromUsageEvents > 0 ? costFromUsageEvents : costFromBudgetEvents,
    costFromUsageEvents,
    costFromBudgetEvents,
    eventCount: events.length,
  };
}