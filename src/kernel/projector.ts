import type { Artifact } from '../shared/artifacts.js';
import type { DecidedBy, KernelEvent } from '../shared/events.js';
import type { NodeRunStatus, TaskStatus } from '../shared/domain.js';

export type NodeState = {
  nodeId: string;
  roleId: string;
  status: NodeRunStatus;
  attempt: number;
  runId: string | null;
  artifactIds: string[];
  lastLogRef: string | null;
  lastError: string | null;
};

export type TransferRecord = { from: string; to: string; reason: string; decidedBy: DecidedBy };

export type TaskState = {
  taskId: string;
  title: string;
  requirementRaw: string;
  baseBranch: string;
  status: TaskStatus;
  currentNodeIds: string[];
  nodes: Record<string, NodeState>;
  artifacts: Artifact[];
  transfers: TransferRecord[];
  visitCounts: Record<string, number>;
  budgetUsedUsd: number;
  completedNodeIds: string[];
};

function str(payload: Record<string, unknown>, key: string, fallback = ''): string {
  const v = payload[key];
  return typeof v === 'string' ? v : fallback;
}

function num(payload: Record<string, unknown>, key: string, fallback = 0): number {
  const v = payload[key];
  return typeof v === 'number' ? v : fallback;
}

function emptyState(): TaskState {
  return {
    taskId: '',
    title: '',
    requirementRaw: '',
    baseBranch: 'main',
    status: 'active',
    currentNodeIds: [],
    nodes: {},
    artifacts: [],
    transfers: [],
    visitCounts: {},
    budgetUsedUsd: 0,
    completedNodeIds: [],
  };
}

/**
 * 把事件流重放成任务状态。
 * 纯函数、无副作用、不读数据库——事件序列相同则结果必然相同。
 */
export function project(events: KernelEvent[]): TaskState {
  const state = emptyState();
  if (events.length > 0) {
    state.taskId = events[0]!.task_id;
  }

  for (const event of events) {
    const p = event.payload;

    switch (event.type) {
      case 'task.created': {
        state.title = str(p, 'title');
        state.requirementRaw = str(p, 'requirement_raw');
        state.baseBranch = str(p, 'base_branch', 'main');
        state.status = 'active';
        break;
      }

      case 'node.queued': {
        const nodeId = str(p, 'node_id');
        state.nodes[nodeId] = {
          nodeId,
          roleId: str(p, 'role_id'),
          status: 'queued',
          attempt: num(p, 'attempt', 1),
          runId: str(p, 'run_id') || null,
          artifactIds: [],
          lastLogRef: null,
          lastError: null,
        };
        break;
      }

      case 'node.started': {
        const nodeId = str(p, 'node_id');
        const previous = state.nodes[nodeId];
        state.nodes[nodeId] = {
          nodeId,
          roleId: str(p, 'role_id'),
          status: 'running',
          attempt: num(p, 'attempt', 1),
          runId: str(p, 'run_id') || null,
          artifactIds: previous?.artifactIds ?? [],
          lastLogRef: previous?.lastLogRef ?? null,
          lastError: null,
        };
        state.visitCounts[nodeId] = (state.visitCounts[nodeId] ?? 0) + 1;
        if (!state.currentNodeIds.includes(nodeId)) {
          state.currentNodeIds.push(nodeId);
        }
        break;
      }

      case 'node.succeeded': {
        const nodeId = str(p, 'node_id');
        const node = state.nodes[nodeId];
        if (node) {
          node.status = 'succeeded';
          node.lastLogRef = str(p, 'log_ref') || node.lastLogRef;
        }
        state.currentNodeIds = state.currentNodeIds.filter((id) => id !== nodeId);
        if (!state.completedNodeIds.includes(nodeId)) {
          state.completedNodeIds.push(nodeId);
        }
        break;
      }

      case 'node.failed': {
        const nodeId = str(p, 'node_id');
        const node = state.nodes[nodeId];
        if (node) {
          node.status = 'failed';
          node.lastError = str(p, 'error', '未知错误');
          node.lastLogRef = str(p, 'log_ref') || node.lastLogRef;
        }
        state.currentNodeIds = state.currentNodeIds.filter((id) => id !== nodeId);
        break;
      }

      case 'node.cancelled': {
        const nodeId = str(p, 'node_id');
        const node = state.nodes[nodeId];
        if (node) node.status = 'cancelled';
        state.currentNodeIds = state.currentNodeIds.filter((id) => id !== nodeId);
        break;
      }

      case 'node.usage_recorded': {
        state.budgetUsedUsd += num(p, 'cost_usd', 0);
        break;
      }

      case 'artifact.created': {
        const artifact: Artifact = {
          artifact_id: str(p, 'artifact_id'),
          task_id: event.task_id,
          run_id: str(p, 'run_id'),
          type: str(p, 'type') as Artifact['type'],
          status: str(p, 'status', 'ok') as Artifact['status'],
          schema_version: num(p, 'schema_version', 1),
          payload: p['payload'],
          refs: Array.isArray(p['refs']) ? (p['refs'] as Artifact['refs']) : [],
          summary: str(p, 'summary'),
          created_at: event.created_at,
        };
        state.artifacts.push(artifact);
        const nodeId = str(p, 'node_id');
        const node = state.nodes[nodeId];
        if (node && !node.artifactIds.includes(artifact.artifact_id)) {
          node.artifactIds.push(artifact.artifact_id);
        }
        break;
      }

      case 'artifact.invalidated': {
        const artifactId = str(p, 'artifact_id');
        state.artifacts = state.artifacts.filter((a) => a.artifact_id !== artifactId);
        break;
      }

      case 'transfer.decided': {
        state.transfers.push({
          from: str(p, 'from'),
          to: str(p, 'to'),
          reason: str(p, 'reason'),
          decidedBy: str(p, 'decided_by', 'rule') as DecidedBy,
        });
        break;
      }

      case 'task.completed': {
        state.status = 'completed';
        break;
      }

      case 'task.failed': {
        state.status = 'failed';
        break;
      }

      case 'budget.consumed':
      case 'budget.exceeded':
      case 'wp.declared':
      case 'wp.started':
      case 'wp.merged':
        // Phase 1 不使用这些事件；显式忽略以保持穷尽性检查
        break;

      default: {
        const exhaustive: never = event.type;
        throw new Error(`未处理的事件类型：${String(exhaustive)}`);
      }
    }
  }

  return state;
}