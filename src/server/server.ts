import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventStore } from '../kernel/event-store.js';
import type { Kernel } from '../kernel/kernel.js';
import { project } from '../kernel/projector.js';
import type { KernelEvent } from '../shared/events.js';

const CreateTaskSchema = z.object({
  title: z.string().min(1),
  requirementRaw: z.string().min(1),
  baseBranch: z.string().min(1).default('main'),
});

/** 日志尾行的默认条数 */
const DEFAULT_LOG_TAIL = 200;
/** 日志尾行下限 */
const MIN_LOG_TAIL = 1;
/** 日志尾行上限：单文件可达数 MB，2000 行是刻意的体积保护 */
const MAX_LOG_TAIL = 2000;

export type ServerDeps = {
  kernel: Kernel;
  /** 事件库：列表聚合与任务存在性判据的数据源（不再依赖进程内存登记） */
  store: EventStore;
  /** 日志根目录：内核拼 log_ref 用的同一个值，日志端点据此做目录穿越校验 */
  logDir: string;
  host: string;
  port: number;
};

export type AgentFlowServer = {
  app: FastifyInstance;
  close(): Promise<void>;
};

type PushSocket = { send(data: string): void; readyState: number };

/** 任务列表摘要：从事件库聚合出的持久化视图，服务重启后依然可见 */
type TaskSummary = {
  taskId: string;
  title: string;
  status: string;
  budgetUsedUsd: number;
  nodeCount: number;
  completedNodeCount: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * 把 tail 查询参数钳制到 [1, 2000]、缺省或非数字回退默认值。
 * 采用"钳制"而非报错：日志端点的目的是尽力让用户看到诊断信息，非法参数不应成为阻碍。
 */
function normalizeTail(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LOG_TAIL;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LOG_TAIL;
  return Math.min(MAX_LOG_TAIL, Math.max(MIN_LOG_TAIL, Math.trunc(n)));
}

/** 按 task_id 分组事件（保持 seq 顺序） */
function groupByTask(events: KernelEvent[]): Map<string, KernelEvent[]> {
  const byTask = new Map<string, KernelEvent[]>();
  for (const event of events) {
    const bucket = byTask.get(event.task_id);
    if (bucket) bucket.push(event);
    else byTask.set(event.task_id, [event]);
  }
  return byTask;
}

/**
 * 目录穿越防护的唯一入口：把候选日志路径解析后校验是否落在日志根目录内。
 * 越界返回 null（调用方据此返回 400，且绝不读取任何文件内容）。
 * 所有依赖“数据驱动路径”的日志端点都必须走这里，不得另写一份更宽松的校验。
 */
function resolveWithinLogRoot(logDir: string, candidate: string): string | null {
  const resolvedRoot = resolve(logDir);
  const resolved = resolve(candidate);
  if (!resolved.startsWith(resolvedRoot + sep)) return null;
  return resolved;
}

/** 读取已通过穿越校验的日志文件的末 tail 行（原样返回字符串行，不做 JSON 解析） */
function readLogFileTail(
  resolved: string,
  rawTail: unknown,
): { totalLines: number; returnedLines: number; truncated: boolean; lines: string[] } {
  const raw = readFileSync(resolved, 'utf8');
  const allLines = raw.split('\n');
  // 丢弃文件末尾换行产生的空元素
  while (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

  const totalLines = allLines.length;
  const tail = normalizeTail(rawTail);
  const lines = totalLines <= tail ? allLines : allLines.slice(totalLines - tail);
  return { totalLines, returnedLines: lines.length, truncated: lines.length < totalLines, lines };
}

export function createServer(deps: ServerDeps): AgentFlowServer {
  const app = Fastify({ logger: false });
  const sockets = new Set<PushSocket>();

  function broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  app.register(websocket);

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/tasks', async (request, reply) => {
    const parsed = CreateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: '请求体不合法', detail: parsed.error.message });
    }

    // task.created 已在 startTask 内同步落库，列表/详情接口无需任何内存登记即可立刻读到
    const taskId = deps.kernel.startTask(parsed.data);

    // 异步推进任务，不阻塞 HTTP 响应
    void deps.kernel
      .runTask(taskId)
      .then((state) => broadcast({ type: 'task_state', state }))
      .catch((error: unknown) => {
        broadcast({ type: 'task_error', taskId, message: (error as Error).message });
      });

    return reply.status(201).send({ taskId });
  });

  app.get('/api/tasks', async () => {
    // Phase 1 取舍：readAll() 是全量读事件库，任务/事件规模大了需要改为分页或专门的
    // 任务索引表；当前规模下可接受，换来"服务重启后列表不丢、内核直建任务也可见"的正确性。
    const summaries: TaskSummary[] = [];

    for (const [taskId, events] of groupByTask(deps.store.readAll())) {
      const state = project(events);
      let createdAt = events[0]!.created_at;
      let updatedAt = events[0]!.created_at;
      for (const event of events) {
        if (event.created_at < createdAt) createdAt = event.created_at;
        if (event.created_at > updatedAt) updatedAt = event.created_at;
      }
      summaries.push({
        taskId,
        title: state.title,
        status: state.status,
        budgetUsedUsd: state.budgetUsedUsd,
        nodeCount: Object.keys(state.nodes).length,
        completedNodeCount: state.completedNodeIds.length,
        createdAt,
        updatedAt,
      });
    }

    // 按 updatedAt 倒序：最新任务排最前
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return { tasks: summaries };
  });

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    // 判据改到事件库：有事件即可读，不再要求经 POST 登记
    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}` });
    }
    return deps.kernel.getState(taskId);
  });

  app.get('/api/tasks/:taskId/events', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}` });
    }
    return { events: deps.kernel.getEvents(taskId) };
  });

  app.get('/api/tasks/:taskId/nodes/:nodeId/log', async (request, reply) => {
    const { taskId, nodeId } = request.params as { taskId: string; nodeId: string };
    const query = request.query as { tail?: string };

    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}` });
    }

    const state = deps.kernel.getState(taskId);
    const node = state.nodes[nodeId];
    if (!node) {
      return reply.status(404).send({ error: `找不到节点：${nodeId}` });
    }
    if (!node.lastLogRef) {
      return reply.status(404).send({ error: `节点 ${nodeId} 没有日志引用` });
    }

    // lastLogRef 来自事件库、属于数据驱动的路径：必须先做目录穿越校验，绝不能直接读任意文件。
    // 校验不通过时直接返回 400，且不读取任何文件内容。
    const resolved = resolveWithinLogRoot(deps.logDir, node.lastLogRef);
    if (!resolved) {
      return reply
        .status(400)
        .send({ error: `日志路径越界：不在允许的日志根目录内（${resolve(node.lastLogRef)}）` });
    }

    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return reply.status(404).send({ error: `日志文件不存在：${resolved}` });
    }

    // 只读、不修改任何文件。服务端不做 JSON 解析/格式化：原样返回字符串行，
    // 由前端决定如何展示 stream-json。tail 上限 2000 行是刻意的体积保护。
    return { nodeId, logRef: resolved, ...readLogFileTail(resolved, query.tail) };
  });

  // 运行中节点的回退日志端点：node.started 之前的老事件可能没有 log_ref，
  // 而日志文件其实早已在写入。此时按 runId 直接定位 logs/runs/<runId>.jsonl。
  app.get('/api/tasks/:taskId/runs/:runId/log', async (request, reply) => {
    const { taskId, runId } = request.params as { taskId: string; runId: string };
    const query = request.query as { tail?: string };

    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}` });
    }

    // runId 来自 URL，属于外部输入：拼接后同样要过“根目录内校验”，绝不能放宽。
    const candidate = join(deps.logDir, 'runs', `${runId}.jsonl`);
    const resolved = resolveWithinLogRoot(deps.logDir, candidate);
    if (!resolved) {
      return reply
        .status(400)
        .send({ error: `日志路径越界：不在允许的日志根目录内（${resolve(candidate)}）` });
    }

    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return reply.status(404).send({ error: `日志文件不存在：${resolved}` });
    }

    return { runId, logRef: resolved, ...readLogFileTail(resolved, query.tail) };
  });

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      const s = socket as unknown as PushSocket;
      sockets.add(s);
      socket.on('close', () => sockets.delete(s));
    });
  });

  return {
    app,
    async close(): Promise<void> {
      await app.close();
    },
  };
}