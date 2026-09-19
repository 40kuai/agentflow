import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import { createEventStore } from '../kernel/event-store.js';
import { createKernel } from '../kernel/kernel.js';
import { createFakeRunner, type FakeScriptItem } from '../runner/fake-runner.js';
import type { RoleDef, WorkflowDef } from '../shared/domain.js';

const workflow: WorkflowDef = {
  id: 'simple_dev',
  start: 'pm_analyze',
  nodes: [
    { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
  ],
  edges: [],
};

function role(): RoleDef {
  return {
    id: 'pm',
    displayName: '产品经理',
    systemPrompt: '你是产品经理',
    inputs: [],
    outputs: ['requirement'],
    owns: [],
    reads: [],
    model: 'sonnet',
    maxRetries: 1,
    maxWallTimeMs: 60_000,
  };
}

const REQUIREMENT = {
  problem: 'p',
  goals: ['g'],
  non_goals: [],
  acceptance_criteria: ['a'],
};

let closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  // POST /api/tasks 会异步触发 runTask；等它落地再关服务与事件库，
  // 否则出现"数据库已关闭"的偶发失败
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const close of closers) await close();
  closers = [];
});

function boot() {
  const repo = mkdtempSync(join(tmpdir(), 'agentflow-repo-'));
  writeFileSync(join(repo, 'README.md'), '# x\n');
  const store = createEventStore(':memory:');
  const runner = createFakeRunner({
    scripts: [[{ kind: 'artifact', raw: REQUIREMENT }, { kind: 'exited', code: 0 }] as FakeScriptItem[]],
  });
  const kernel = createKernel({
    store,
    runner,
    workflow,
    roles: new Map([['pm', role()]]),
    maxPromptTokens: 30_000,
    workspaceRoot: join(repo, '.ws'),
    logDir: join(repo, 'logs'),
    repoPath: repo,
    maxSteps: 5,
  });
  const server = createServer({ kernel, host: '127.0.0.1', port: 0 });
  closers.push(async () => {
    await server.close();
    store.close();
  });
  return { server, kernel };
}

/**
 * 通过 HTTP 创建任务并返回 taskId。
 * 必须走 POST：只有它会在服务层登记 knownTaskIds / taskSummaries，
 * 直接用 kernel.startTask 建出来的任务，HTTP 读取接口一律返回 404。
 */
async function postTask(
  server: ReturnType<typeof boot>['server'],
  title = '自动流转',
): Promise<string> {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { title, requirementRaw: '让角色自动流转' },
  });
  return (res.json() as { taskId: string }).taskId;
}

describe('HTTP API', () => {
  it('health 返回 ok', async () => {
    const { server } = boot();
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('POST /api/tasks 创建任务并返回 taskId', async () => {
    const { server } = boot();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: '自动流转', requirementRaw: '让角色自动流转' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ taskId: expect.stringMatching(/^task_/) });
  });

  it('缺少必填字段时返回 400', async () => {
    const { server } = boot();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: '只有标题' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/tasks/:id 返回投影状态', async () => {
    const { server } = boot();
    const taskId = await postTask(server);
    const res = await server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ taskId });
  });

  it('GET 未知任务返回 404', async () => {
    const { server } = boot();
    const res = await server.app.inject({ method: 'GET', url: '/api/tasks/task_ghost' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/tasks/:id/events 返回原始事件流', async () => {
    const { server } = boot();
    const taskId = await postTask(server);
    const res = await server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/events` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ type: string }> };
    expect(body.events[0]?.type).toBe('task.created');
    expect(body.events.length).toBeGreaterThan(1);
  });

  it('GET /api/tasks 返回任务列表', async () => {
    const { server } = boot();
    await postTask(server, 'A');
    const res = await server.app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<{ title: string }> };
    expect(body.tasks.map((t) => t.title)).toEqual(['A']);
  });
});