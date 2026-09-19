import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, type Stats } from 'node:fs';
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

/** 进程启动时刻（ms）：用 uptime 反推，前端据此判断后端进程是否比前端代码旧 */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/**
 * 本服务对前端声明的能力集。
 * 前端缺少必需能力时应提示「后端版本落后于前端，请重启服务」，
 * 而不是把日志端点的 404 误读成「日志不存在」。
 */
const SERVER_FEATURES: readonly string[] = ['log-by-node', 'log-by-run', 'live-stats'];

/** claude 进程探测结果的缓存时长：health 会被前端高频轮询，避免每次都 spawn ps */
const CLAUDE_PROC_CACHE_MS = 3000;

/** claude 进程信息（E 项：孤儿进程可见） */
type ClaudeProcess = { pid: number; etimeMs: number; command: string };

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

/** 解析 ps 的 etime（[[dd-]hh:]mm:ss）为毫秒；无法解析返回 -1 */
function parseEtimeMs(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return -1;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

let claudeProcCache: { at: number; value: ClaudeProcess[] } | null = null;

/**
 * 列出本机 claude 进程（E 项：孤儿进程可见）。
 *
 * 平台相关取舍：AgentFlow 只监听 127.0.0.1、面向 macOS 单机场景，因此直接使用 POSIX 的 ps；
 * Windows / 远程主机需另接 tasklist 或远端采集，本实现不做跨平台兼容。
 * 内核不记录 spawn 出的 PID，PID ↔ runId 无法精确关联，故这里只如实报告进程本身，
 * 绝不编造「该进程属于哪个 run」。
 */
function listClaudeProcesses(): ClaudeProcess[] {
  const now = Date.now();
  if (claudeProcCache && now - claudeProcCache.at < CLAUDE_PROC_CACHE_MS) {
    return claudeProcCache.value;
  }

  let value: ClaudeProcess[] = [];
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,etime=,command='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const command = m[3]!.trim();
      // 只认命令行里出现 claude 的进程；ps 自身的命令行不含 claude，不会自匹配。
      // 用子串而非精确匹配，是为兼容 `claude` 与 `<path>/claude-code/cli.js` 等多种启动形态。
      if (!/claude/i.test(command)) continue;
      value.push({ pid: Number(m[1]), etimeMs: parseEtimeMs(m[2]!), command });
    }
  } catch {
    // ps 不可用（非 POSIX 环境）时如实返回空列表，不抛错拖垮 health
    value = [];
  }
  claudeProcCache = { at: now, value };
  return value;
}

/** 日志文件活性：sizeBytes + 最后修改时间 + ageMs（判断 agent 是否还在干活的核心信号） */
function logFileFacts(st: Pick<Stats, 'size' | 'mtimeMs'>): {
  sizeBytes: number;
  lastModifiedAt: number;
  ageMs: number;
} {
  const lastModifiedAt = Math.round(st.mtimeMs);
  return { sizeBytes: st.size, lastModifiedAt, ageMs: Math.max(0, Date.now() - lastModifiedAt) };
}

/** 读取文件 stat；不存在或不是普通文件返回 null（调用方据此返回 404 + FILE_NOT_FOUND） */
function statLogFile(resolved: string): Stats | null {
  try {
    const st = statSync(resolved);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
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

  // 能力探测端点：前端据此判断「后端是否落后于前端代码」，从而不再把日志端点的 404 误读成
  // 「日志不存在」。pid / startedAt 用于诊断「前端热更新、后端正跑着旧代码」这类最常见误诊。
  app.get('/api/health', async () => {
    const now = Date.now();
    return {
      ok: true,
      pid: process.pid,
      startedAt: PROCESS_STARTED_AT,
      uptimeMs: Math.max(0, now - PROCESS_STARTED_AT),
      features: [...SERVER_FEATURES],
      claudeProcesses: listClaudeProcesses(),
    };
  });

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
      return reply.status(404).send({ error: `找不到任务：${taskId}`, code: 'TASK_NOT_FOUND' });
    }

    const state = deps.kernel.getState(taskId);
    const node = state.nodes[nodeId];
    if (!node) {
      return reply.status(404).send({ error: `找不到节点：${nodeId}`, code: 'NODE_NOT_FOUND' });
    }
    if (!node.lastLogRef) {
      return reply
        .status(404)
        .send({ error: `节点 ${nodeId} 没有日志引用`, code: 'NO_LOG_REF' });
    }

    // lastLogRef 来自事件库、属于数据驱动的路径：必须先做目录穿越校验，绝不能直接读任意文件。
    // 校验不通过时直接返回 400，且不读取任何文件内容。
    const resolved = resolveWithinLogRoot(deps.logDir, node.lastLogRef);
    if (!resolved) {
      return reply.status(400).send({
        error: `日志路径越界：不在允许的日志根目录内（${resolve(node.lastLogRef)}）`,
        code: 'OUT_OF_LOG_ROOT',
      });
    }

    const st = statLogFile(resolved);
    if (!st) {
      return reply
        .status(404)
        .send({ error: `日志文件不存在：${resolved}`, code: 'FILE_NOT_FOUND' });
    }

    // 只读、不修改任何文件。服务端不做 JSON 解析/格式化：原样返回字符串行，
    // 由前端决定如何展示 stream-json。tail 上限 2000 行是刻意的体积保护。
    // 同时带上文件活性（sizeBytes/lastModifiedAt/ageMs）：这是判断 agent 是否还在干活的核心信号。
    return {
      nodeId,
      logRef: resolved,
      ...readLogFileTail(resolved, query.tail),
      ...logFileFacts(st),
    };
  });

  // 运行中节点的回退日志端点：node.started 之前的老事件可能没有 log_ref，
  // 而日志文件其实早已在写入。此时按 runId 直接定位 logs/runs/<runId>.jsonl。
  app.get('/api/tasks/:taskId/runs/:runId/log', async (request, reply) => {
    const { taskId, runId } = request.params as { taskId: string; runId: string };
    const query = request.query as { tail?: string };

    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}`, code: 'TASK_NOT_FOUND' });
    }

    // runId 来自 URL，属于外部输入：拼接后同样要过“根目录内校验”，绝不能放宽。
    const candidate = join(deps.logDir, 'runs', `${runId}.jsonl`);
    const resolved = resolveWithinLogRoot(deps.logDir, candidate);
    if (!resolved) {
      return reply.status(400).send({
        error: `日志路径越界：不在允许的日志根目录内（${resolve(candidate)}）`,
        code: 'OUT_OF_LOG_ROOT',
      });
    }

    const st = statLogFile(resolved);
    if (!st) {
      return reply
        .status(404)
        .send({ error: `日志文件不存在：${resolved}`, code: 'FILE_NOT_FOUND' });
    }

    // 与节点端点一致：附上文件活性，运行中即可判断「还在写」还是「已停滞」。
    return {
      runId,
      logRef: resolved,
      ...readLogFileTail(resolved, query.tail),
      ...logFileFacts(st),
    };
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