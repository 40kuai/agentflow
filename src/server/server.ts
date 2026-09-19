import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Kernel } from '../kernel/kernel.js';

const CreateTaskSchema = z.object({
  title: z.string().min(1),
  requirementRaw: z.string().min(1),
  baseBranch: z.string().min(1).default('main'),
});

export type ServerDeps = {
  kernel: Kernel;
  host: string;
  port: number;
};

export type AgentFlowServer = {
  app: FastifyInstance;
  close(): Promise<void>;
};

type PushSocket = { send(data: string): void; readyState: number };

export function createServer(deps: ServerDeps): AgentFlowServer {
  const app = Fastify({ logger: false });
  const sockets = new Set<PushSocket>();
  const knownTaskIds = new Set<string>();
  const taskSummaries = new Map<string, { taskId: string; title: string; status: string }>();

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

    const taskId = deps.kernel.startTask(parsed.data);
    knownTaskIds.add(taskId);
    taskSummaries.set(taskId, { taskId, title: parsed.data.title, status: 'active' });

    // 异步推进任务，不阻塞 HTTP 响应
    void deps.kernel
      .runTask(taskId)
      .then((state) => {
        const summary = taskSummaries.get(taskId);
        if (summary) summary.status = state.status;
        broadcast({ type: 'task_state', state });
      })
      .catch((error: unknown) => {
        broadcast({ type: 'task_error', taskId, message: (error as Error).message });
      });

    return reply.status(201).send({ taskId });
  });

  app.get('/api/tasks', async () => ({ tasks: [...taskSummaries.values()] }));

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (!knownTaskIds.has(taskId)) {
      return reply.status(404).send({ error: `找不到任务：${taskId}` });
    }
    return deps.kernel.getState(taskId);
  });

  app.get('/api/tasks/:taskId/events', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (!knownTaskIds.has(taskId)) {
      return reply.status(404).send({ error: `找不到任务：${taskId}` });
    }
    return { events: deps.kernel.getEvents(taskId) };
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