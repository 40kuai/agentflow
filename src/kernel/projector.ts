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

export type TransferRecord = {
  from: string;
  to: string;
  reason: string;
  decidedBy: DecidedBy;
  /** 所用边；进入起始节点（无入边）时缺省 */
  edge?: { from: string; to: string };
  /** 条件表达式原文；无条件边或起始进入时为 null */
  when?: string | null;
  /** 该条件的人类可读说明（工作流边配置的 `description` 原文） */
  edgeDescription?: string | null;
  /** 判定依据：该次转移时相关产物的实际状态 */
  artifactStatuses?: { type: string; status: string }[];
};

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
          // node.started 已带 log_ref（内核在启动前算好）：运行中节点即可拿到日志引用。
          // 兼容更早的历史事件（无 log_ref）时回退到 previous 的值，保持原有语义。
          lastLogRef: str(p, 'log_ref') || previous?.lastLogRef || null,
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
        // 取消是终态：被取消的节点不被**在途的迟到成功**翻转（取消时 CLI 可能刚跑完，
        // 若允许翻转，界面会先显示"已取消"再跳回"succeeded"，使用者无从判断到底怎么了）。
        // 非取消节点行为与此前逐字一致。
        const cancelled = node?.status === 'cancelled';
        if (node && !cancelled) {
          node.status = 'succeeded';
          node.lastLogRef = str(p, 'log_ref') || node.lastLogRef;
        }
        state.currentNodeIds = state.currentNodeIds.filter((id) => id !== nodeId);
        if (!cancelled && !state.completedNodeIds.includes(nodeId)) {
          state.completedNodeIds.push(nodeId);
        }
        break;
      }

      case 'node.failed': {
        const nodeId = str(p, 'node_id');
        const node = state.nodes[nodeId];
        if (node) {
          // 同上：错误文本照记（便于排查），但状态不被取消后到达的失败翻转
          if (node.status !== 'cancelled') node.status = 'failed';
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
          // ⚠️ 历史兼容缺省，不是活路径：内核写 artifact.created 时必带 status
          // （`src/kernel/kernel.ts` 写入的是 parseArtifactPayload 提升出的 parsed.status，永远合法），
          // 故这里的 'ok' 只对更早的历史事件（修复前内核写死 status 之前的载荷）生效，正常回放不会走到它。
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
        // 同步清理节点上的索引，否则 TaskState 内部自相矛盾：
        // artifacts 里已无此产物，而 nodes[].artifactIds 仍指向它
        for (const node of Object.values(state.nodes)) {
          node.artifactIds = node.artifactIds.filter((id) => id !== artifactId);
        }
        break;
      }

      case 'transfer.decided': {
        // 新增的边/条件/判定依据字段全部按"存在才读"处理：更早的历史事件没有这些键，
        // 回放时一律缺省省略（旧事件可回放，投影器对未知/缺失字段容错）。
        const edgeRaw = p['edge'];
        const edge =
          typeof edgeRaw === 'object' && edgeRaw !== null && !Array.isArray(edgeRaw)
            ? {
                from: str(edgeRaw as Record<string, unknown>, 'from'),
                to: str(edgeRaw as Record<string, unknown>, 'to'),
              }
            : undefined;
        const statusesRaw = p['artifact_statuses'];
        const artifactStatuses = Array.isArray(statusesRaw)
          ? statusesRaw
              .filter(
                (s): s is Record<string, unknown> =>
                  typeof s === 'object' && s !== null && !Array.isArray(s),
              )
              .map((s) => ({ type: str(s, 'type'), status: str(s, 'status') }))
          : undefined;

        state.transfers.push({
          from: str(p, 'from'),
          to: str(p, 'to'),
          reason: str(p, 'reason'),
          decidedBy: str(p, 'decided_by', 'rule') as DecidedBy,
          ...(edge !== undefined ? { edge } : {}),
          ...('when' in p ? { when: (p['when'] ?? null) as string | null } : {}),
          ...('edge_description' in p
            ? { edgeDescription: (p['edge_description'] ?? null) as string | null }
            : {}),
          ...(artifactStatuses !== undefined ? { artifactStatuses } : {}),
        });
        break;
      }

      case 'task.completed': {
        // 取消是终态：取消后不再被在途结果翻转
        if (state.status !== 'cancelled') state.status = 'completed';
        break;
      }

      case 'task.failed': {
        if (state.status !== 'cancelled') state.status = 'failed';
        break;
      }

      case 'task.cancelled': {
        // 人工取消：状态明确落到 cancelled（既不悬挂在 active，也不伪装成 failed）
        state.status = 'cancelled';
        state.currentNodeIds = [];
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