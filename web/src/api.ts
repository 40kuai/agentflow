/**
 * 后端契约类型与 fetch 封装。
 *
 * 字段以服务端实现为准（src/server/server.ts、src/kernel/projector.ts、src/shared/events.ts），
 * 而非仅按需求文档抄写。两处文档与实现的偏差已在此处兼容处理：
 *  1. 事件的时间戳实现为 `created_at`（ms），文档写作 `ts` —— 两者都读，`created_at` 优先。
 *  2. TaskState.artifacts[] 的投影当前**不含** `node_id`（ArtifactSchema 无该列），
 *     故声明为可选；节点→产物的归属一律走 `NodeState.artifactIds`。
 */

export type ArtifactStatus = 'ok' | 'needs_changes' | 'blocked';

export type ArtifactType = 'requirement' | 'work_package_plan' | 'code_diff' | 'test_report';

export type ArtifactRef = { kind: string; uri: string };

export type Artifact = {
  artifact_id: string;
  task_id: string;
  run_id: string;
  type: ArtifactType | string;
  status: ArtifactStatus | string;
  schema_version: number;
  payload: unknown;
  refs: ArtifactRef[];
  summary: string;
  created_at: number;
  /** 投影当前未输出；保留可选以兼容后续加入 */
  node_id?: string | null;
};

/** 节点状态：8 个字段，与服务端 project() 的 node.queued / node.started / node.succeeded / node.failed 投影一致 */
export type NodeState = {
  nodeId: string;
  roleId: string;
  status: string;
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
  decidedBy: string;
  /** 所用边；进入起始节点（无入边）时缺省 */
  edge?: { from: string; to: string };
  /** 条件表达式原文；无条件边或起始进入时为 null */
  when?: string | null;
  /** 该条件的人类可读说明（工作流边配置的 description 原文） */
  edgeDescription?: string | null;
  /** 判定依据：该次转移时相关产物的实际状态 */
  artifactStatuses?: { type: string; status: string }[];
};

export type TaskState = {
  taskId: string;
  title: string;
  requirementRaw: string;
  baseBranch: string;
  status: string;
  currentNodeIds: string[];
  /** Record（对象）而非数组：key 为 nodeId */
  nodes: Record<string, NodeState>;
  artifacts: Artifact[];
  transfers: TransferRecord[];
  visitCounts: Record<string, number>;
  budgetUsedUsd: number;
  completedNodeIds: string[];
};

/** 任务列表摘要：8 个字段，服务端从事件库聚合，按 updatedAt 倒序 */
export type TaskSummary = {
  taskId: string;
  title: string;
  status: string;
  budgetUsedUsd: number;
  nodeCount: number;
  completedNodeCount: number;
  createdAt: number;
  updatedAt: number;
};

/** 内核事件。未知类型不做枚举约束（事件类型 > 20 种），统一走通用 JSON 兜底展示 */
export type KernelEvent = {
  seq: number;
  event_id?: string;
  task_id: string;
  type: string;
  payload: Record<string, unknown>;
  actor: string;
  /** 事件库落库字段（ms） */
  created_at?: number;
  /** 契约文档中的写法，做兼容兜底 */
  ts?: number;
};

/** 日志尾行响应；lines 为未经解析的原始字符串行 */
export type LogTail = {
  /** 节点日志端点返回 */
  nodeId?: string;
  /** runId 回退日志端点返回 */
  runId?: string;
  logRef: string;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  lines: string[];
  /** 以下为文件活性字段（后端 capabilities 见 health.features）。旧后端可能缺省，缺省时按「未知」处理 */
  sizeBytes?: number;
  /** 文件最后修改时间（ms） */
  lastModifiedAt?: number;
  /** 服务端上报的「现在 − 最后修改时间」（ms） */
  ageMs?: number;
};

/** 本机 claude 进程（E 项）：内核不记录 spawn 的 PID，无法精确关联 runId，故只如实报告进程本身 */
export type ClaudeProcess = { pid: number; etimeMs: number; command: string };

/**
 * /api/health 响应。除 ok 外全部可选：
 * 旧后端只返回 { ok: true }，此时 `features` 缺失即代表「后端版本落后于前端」。
 */
export type HealthInfo = {
  ok: boolean;
  pid?: number;
  startedAt?: number;
  uptimeMs?: number;
  /** 后端声明的能力集；缺失或缺少前端所需能力 → 后端版本落后 */
  features?: string[];
  /**
   * 节点「停滞自动停止」阈值（ms）：0 = 未启用；字段缺失 = 后端不支持该能力（版本落后）。
   * 前端据此如实说明「连续多久无输出会被自动终止」，而不是只展示「疑似停滞」。
   */
  nodeStallTimeoutMs?: number;
  claudeProcesses?: ClaudeProcess[];
};

export type CreateTaskInput = {
  title: string;
  requirementRaw: string;
  baseBranch?: string;
};

/** 带 HTTP 状态码的接口错误：日志端点的 400 / 404 需要如实上报给界面 */
export class ApiError extends Error {
  readonly status: number;
  /** 后端给出的原因码（如 NO_LOG_REF / FILE_NOT_FOUND / OUT_OF_LOG_ROOT）；未知或缺失为 null */
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = '';
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: string; detail?: string; code?: string };
      detail = [body?.error, body?.detail].filter(Boolean).join(' — ');
      if (typeof body?.code === 'string' && body.code !== '') code = body.code;
    } catch {
      // 响应体非 JSON：忽略，退回状态码
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`, code);
  }
  return (await res.json()) as T;
}

export async function getHealth(): Promise<HealthInfo> {
  return requestJson<HealthInfo>('/api/health');
}

export async function createTask(input: CreateTaskInput): Promise<{ taskId: string }> {
  return requestJson<{ taskId: string }>('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function listTasks(): Promise<TaskSummary[]> {
  const body = await requestJson<{ tasks?: TaskSummary[] }>('/api/tasks');
  return Array.isArray(body?.tasks) ? body.tasks : [];
}

export async function getTask(taskId: string): Promise<TaskState> {
  return requestJson<TaskState>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

export async function getTaskEvents(taskId: string): Promise<KernelEvent[]> {
  const body = await requestJson<{ events?: KernelEvent[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/events`,
  );
  return Array.isArray(body?.events) ? body.events : [];
}

/**
 * 拉取节点日志尾行。tail 由服务端钳制到 [1, 2000]。
 * 400（路径越界）/ 404（无日志引用或文件不存在）会以 ApiError 抛出，界面需如实显示。
 */
export async function getNodeLog(taskId: string, nodeId: string, tail: number): Promise<LogTail> {
  const qs = new URLSearchParams({ tail: String(tail) });
  return requestJson<LogTail>(
    `/api/tasks/${encodeURIComponent(taskId)}/nodes/${encodeURIComponent(nodeId)}/log?${qs}`,
  );
}

/**
 * 按 runId 回退拉取日志尾行：运行中的节点在日志引用落库前也能看到活日志。
 * 服务端复用与节点端点同一套目录穿越校验；400（越界）/ 404（文件不存在）会以 ApiError 抛出。
 */
export async function getRunLog(taskId: string, runId: string, tail: number): Promise<LogTail> {
  const qs = new URLSearchParams({ tail: String(tail) });
  return requestJson<LogTail>(
    `/api/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/log?${qs}`,
  );
}

// ---------------------------------------------------------------------------
// 流转视图 / 角色 相关的契约类型（字段形状以 src/server/server.ts 的
// buildFlowView / buildRoleUsage / roleView 为准，不在前端猜测）
// ---------------------------------------------------------------------------

/** 节点进入理由：来自 transfer.decided，回答「为什么走到这一步」 */
export type FlowEnterReason = {
  from: string;
  reason: string;
  edge: { from: string; to: string } | null;
  when: string | null;
  edgeDescription: string | null;
  /** 判定依据：该次转移时相关产物的实际状态 */
  artifactStatuses: { type: string; status: string }[];
};

/** 分类化的阻塞原因（来自 node.failed）：界面无需解析 CLI 原文即可展示根因 */
export type BlockedReason = {
  category: string | null;
  label: string | null;
  error: string;
};

export type FlowNode = {
  id: string;
  title: string;
  role: string;
  roleDisplayName: string | null;
  description: string | null;
  entryCondition: string | null;
  consumes: string[];
  produces: string | null;
  isolate: boolean | null;
  /** NodeRunStatus；未进入过的节点为 'not_started' */
  status: string;
  attempt: number;
  /** 是否在 TaskState.currentNodeIds 里（并发时可能多个同时为 true） */
  current: boolean;
  enterReason: FlowEnterReason | null;
  blockedReason: BlockedReason | null;
  durationMs: number | null;
  /**
   * 本节点**最后一次尝试**的启动时刻（ms）；从未启动为 null。
   * `durationMs` 只在节点结束后才有值，运行中的节点要靠 `startedAt` 才能显示「已运行多久」。
   */
  startedAt: number | null;
  costUsd: number;
  artifactTypes: string[];
  invalidatedArtifactTypes: string[];
  changedPaths: string[];
  worktreePath: string | null;
};

export type FlowEdge = {
  from: string;
  to: string;
  when: string | null;
  description: string | null;
  onMissing: 'fail' | 'wait' | null;
};

/** 任务级失败的结构化原因（来自最后一个 task.failed） */
export type TaskFailure = {
  reason: string;
  category: string | null;
  label: string | null;
  unmetConditions: string[];
  artifactStatuses: { type: string; status: string }[];
};

/** GET /api/tasks/:taskId/flow 的响应 */
export type FlowView = {
  taskId: string;
  title: string;
  status: string;
  currentNodeIds: string[];
  completedNodeIds: string[];
  budgetUsedUsd: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  transfers: TransferRecord[];
  taskFailure: TaskFailure | null;
};

/** 角色在某任务中的一个节点用量 */
export type RoleUsageNode = {
  nodeId: string;
  status: string;
  produces: string | null;
  artifactTypes: string[];
  invalidatedArtifactTypes: string[];
  attempt: number;
  durationMs: number | null;
  costUsd: number;
};

/** 某任务里一个角色的用量汇总（GET /api/tasks/:taskId/roles） */
export type RoleUsage = {
  roleId: string;
  displayName: string | null;
  model: string | null;
  budget: { maxRetries: number; maxWallTimeMs: number } | null;
  nodes: RoleUsageNode[];
  totalDurationMs: number;
  totalCostUsd: number;
};

export type TaskRoleUsage = {
  taskId: string;
  roles: RoleUsage[];
  totalCostUsd: number;
};

/** 角色详情（GET /api/roles、GET /api/roles/:id、PUT /api/roles/:id 的 role 字段） */
export type RoleView = {
  id: string;
  displayName: string;
  systemPromptRef: string;
  inputs: string[];
  outputs: string[];
  /** 允许写入的路径（写边界；空数组＝只读角色） */
  owns: string[];
  /** 允许读取的路径 */
  reads: string[];
  responsibilities: string[];
  prohibitions: string[];
  doneCriteria: string[];
  model: string;
  budget: { maxRetries: number; maxWallTimeMs: number };
};

/** PUT /api/roles/:id 的请求体（camelCase 形态） */
export type RoleEditInput = {
  displayName: string;
  systemPromptRef: string;
  inputs: string[];
  outputs: string[];
  owns: string[];
  reads: string[];
  responsibilities: string[];
  prohibitions: string[];
  doneCriteria: string[];
  model: string;
  maxRetries: number;
  maxWallTimeMs: number;
};

/** POST /api/tasks/:taskId/cancel 的响应 */
export type CancelTaskResult = {
  /** true=本次真的取消了；false=任务已在终态，未做任何改动（reason 说明原因） */
  cancelled: boolean;
  reason?: string;
  state: TaskState;
};

export async function getTaskFlow(taskId: string): Promise<FlowView> {
  return requestJson<FlowView>(`/api/tasks/${encodeURIComponent(taskId)}/flow`);
}

export async function getTaskRoles(taskId: string): Promise<TaskRoleUsage> {
  return requestJson<TaskRoleUsage>(`/api/tasks/${encodeURIComponent(taskId)}/roles`);
}

export async function listRoles(): Promise<RoleView[]> {
  const body = await requestJson<{ roles?: RoleView[] }>('/api/roles');
  return Array.isArray(body?.roles) ? body.roles : [];
}

export async function getRole(roleId: string): Promise<RoleView> {
  return requestJson<RoleView>(`/api/roles/${encodeURIComponent(roleId)}`);
}

/** 编辑角色：后端校验失败时抛 ApiError（422 带中文原因，且不会落盘） */
export async function updateRole(
  roleId: string,
  input: RoleEditInput,
): Promise<{ role: RoleView; path: string }> {
  return requestJson<{ role: RoleView; path: string }>(`/api/roles/${encodeURIComponent(roleId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** 取消任务。终态任务返回 cancelled=false（幂等），不会误报为"取消成功"。 */
export async function cancelTask(taskId: string): Promise<CancelTaskResult> {
  return requestJson<CancelTaskResult>(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
  });
}

export type SocketMessage =
  | { type: 'task_state'; state: TaskState }
  | { type: 'task_error'; taskId: string; message: string }
  | { type: 'other' };

/**
 * 打开 /ws。Phase 1 只会推 task_state / task_error，不会推节点级事件，
 * 因此运行中的进度刷新仍必须依赖轮询——这里只做补充，不作为唯一数据源。
 */
export function openEventSocket(
  onMessage: (message: SocketMessage) => void,
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void,
): () => void {
  let socket: WebSocket | null = null;
  let timer: number | null = null;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    onStatus?.('connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socket.onopen = () => onStatus?.('open');
    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as { type?: string };
        if (parsed?.type === 'task_state') {
          onMessage(parsed as SocketMessage);
        } else if (parsed?.type === 'task_error') {
          onMessage(parsed as SocketMessage);
        } else {
          onMessage({ type: 'other' });
        }
      } catch {
        // 无法解析的消息直接忽略，不打断轮询主路径
      }
    };
    socket.onclose = () => {
      onStatus?.('closed');
      if (closed) return;
      // 断线自愈：3 秒后重连
      timer = window.setTimeout(connect, 3000);
    };
    socket.onerror = () => {
      socket?.close();
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer !== null) window.clearTimeout(timer);
    socket?.close();
  };
}