export type NodeStateDto = {
  nodeId: string;
  roleId: string;
  status: string;
  attempt: number;
  lastLogRef: string | null;
  lastError: string | null;
  artifactIds: string[];
};

export type ArtifactDto = {
  artifact_id: string;
  type: string;
  status: string;
  summary: string;
  payload: unknown;
};

export type TaskStateDto = {
  taskId: string;
  title: string;
  requirementRaw: string;
  status: string;
  nodes: Record<string, NodeStateDto>;
  completedNodeIds: string[];
  currentNodeIds: string[];
  artifacts: ArtifactDto[];
  transfers: Array<{ from: string; to: string; reason: string; decidedBy: string }>;
  budgetUsedUsd: number;
};

export type TaskSummaryDto = { taskId: string; title: string; status: string };

export async function createTask(input: {
  title: string;
  requirementRaw: string;
  baseBranch?: string;
}): Promise<{ taskId: string }> {
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`创建任务失败：HTTP ${res.status}`);
  return (await res.json()) as { taskId: string };
}

export async function listTasks(): Promise<TaskSummaryDto[]> {
  const res = await fetch('/api/tasks');
  if (!res.ok) throw new Error(`获取任务列表失败：HTTP ${res.status}`);
  const body = (await res.json()) as { tasks: TaskSummaryDto[] };
  return body.tasks;
}

export async function getTask(taskId: string): Promise<TaskStateDto> {
  const res = await fetch(`/api/tasks/${taskId}`);
  if (!res.ok) throw new Error(`获取任务详情失败：HTTP ${res.status}`);
  return (await res.json()) as TaskStateDto;
}

export function openEventSocket(onMessage: (message: unknown) => void): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  socket.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data as string));
    } catch {
      // 忽略无法解析的消息
    }
  };
  return socket;
}