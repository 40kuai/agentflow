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
  nodeId: string;
  logRef: string;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  lines: string[];
};

export type CreateTaskInput = {
  title: string;
  requirementRaw: string;
  baseBranch?: string;
};

/** 带 HTTP 状态码的接口错误：日志端点的 400 / 404 需要如实上报给界面 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      detail = [body?.error, body?.detail].filter(Boolean).join(' — ');
    } catch {
      // 响应体非 JSON：忽略，退回状态码
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getHealth(): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>('/api/health');
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