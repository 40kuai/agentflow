import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import { createEventStore, type EventStore } from '../kernel/event-store.js';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import { createFakeRunner, type FakeRunner, type FakeScriptItem } from '../runner/fake-runner.js';
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
    responsibilities: ['澄清需求'],
    prohibitions: ['不写代码'],
    doneCriteria: ['产出 requirement'],
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

/** 默认脚本：成功产出 requirement，并记录 0.02 美元用量，退出码 0 */
const DEFAULT_SCRIPT: FakeScriptItem[] = [
  { kind: 'artifact', raw: REQUIREMENT },
  { kind: 'usage', tokensIn: 100, tokensOut: 50, costUsd: 0.02 },
  { kind: 'exited', code: 0 },
];

let closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  // POST /api/tasks 会异步触发 runTask；等它落地再关服务与事件库，
  // 否则出现"数据库已关闭"的偶发失败
  await sleep(50);
  for (const close of closers) await close();
  closers = [];
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Boot = {
  server: ReturnType<typeof createServer>;
  kernel: Kernel;
  store: EventStore;
  runner: FakeRunner;
  repo: string;
  logDir: string;
};

function boot(options?: { scripts?: FakeScriptItem[][] }): Boot {
  const repo = mkdtempSync(join(tmpdir(), 'agentflow-repo-'));
  writeFileSync(join(repo, 'README.md'), '# x\n');
  const logDir = join(repo, 'logs');
  const store = createEventStore(':memory:');
  const runner = createFakeRunner({ scripts: options?.scripts ?? [DEFAULT_SCRIPT] });
  const kernel = createKernel({
    store,
    runner,
    workflow,
    roles: new Map([['pm', role()]]),
    maxPromptTokens: 30_000,
    workspaceRoot: join(repo, '.ws'),
    logDir,
    repoPath: repo,
    maxSteps: 5,
  });
  // store 与 logDir 都交给服务层：列表从事件库聚合，日志端点需要日志根目录做穿越校验
  const server = createServer({ kernel, store, logDir, host: '127.0.0.1', port: 0 });
  closers.push(async () => {
    await server.close();
    store.close();
  });
  return { server, kernel, store, runner, repo, logDir };
}

/** 直接经内核建任务并跑完，完全不经过 POST /api/tasks */
async function startAndRun(b: Boot, title = 't'): Promise<string> {
  const taskId = b.kernel.startTask({ title, requirementRaw: 'r', baseBranch: 'main' });
  await b.kernel.runTask(taskId);
  return taskId;
}

/** 写入一个真实的小日志文件；末尾换行，模拟 runner 落盘的 stream-json 行 */
function writeLogFile(logRef: string, lines: string[]): void {
  mkdirSync(dirname(logRef), { recursive: true });
  writeFileSync(logRef, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * 直接在事件库里构造一个带自定义 log_ref 的节点：
 * 用 node.queued 建出节点，再用 node.failed 把 log_ref 覆盖成目标路径。
 */
function seedNodeWithLogRef(b: Boot, logRef: string, title = 't'): { taskId: string; nodeId: string } {
  const nodeId = 'pm_analyze';
  const taskId = b.kernel.startTask({ title, requirementRaw: 'r', baseBranch: 'main' });
  b.store.append({
    task_id: taskId,
    type: 'node.queued',
    payload: { node_id: nodeId, role_id: 'pm', run_id: 'run_seed', attempt: 1 },
    actor: 'kernel',
  });
  b.store.append({
    task_id: taskId,
    type: 'node.failed',
    payload: { node_id: nodeId, run_id: 'run_seed', error: '测试构造', log_ref: logRef },
    actor: 'kernel',
  });
  return { taskId, nodeId };
}

/**
 * 构造一个“正在运行”的节点：只有 node.queued + node.started，没有任何结束事件。
 * 默认不带 log_ref（模拟较早的历史事件），用于验证按 runId 回退取日志。
 */
function seedRunningNode(b: Boot, runId: string): { taskId: string; nodeId: string } {
  const nodeId = 'pm_analyze';
  const taskId = b.kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
  b.store.append({
    task_id: taskId,
    type: 'node.queued',
    payload: { node_id: nodeId, role_id: 'pm', run_id: runId, attempt: 1 },
    actor: 'kernel',
  });
  b.store.append({
    task_id: taskId,
    type: 'node.started',
    payload: { node_id: nodeId, role_id: 'pm', run_id: runId, attempt: 1 },
    actor: 'role:pm',
  });
  return { taskId, nodeId };
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
    const b = boot();
    const taskId = await startAndRun(b);
    const res = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ taskId });
  });

  it('GET 未知任务返回 404', async () => {
    const { server } = boot();
    const res = await server.app.inject({ method: 'GET', url: '/api/tasks/task_ghost' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/tasks/:id/events 返回原始事件流', async () => {
    const b = boot();
    const taskId = await startAndRun(b);
    const res = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/events` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ type: string }> };
    expect(body.events[0]?.type).toBe('task.created');
    expect(body.events.length).toBeGreaterThan(1);
  });

  it('GET /api/tasks 返回任务列表（含内嵌的完整摘要字段）', async () => {
    const b = boot();
    const taskId = await startAndRun(b, 'A');
    const res = await b.server.app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<Record<string, unknown>> };
    expect(body.tasks.map((t) => t['title'])).toEqual(['A']);
    expect(body.tasks[0]).toMatchObject({
      taskId,
      status: 'completed',
      budgetUsedUsd: 0.02,
      nodeCount: 1,
      completedNodeCount: 1,
    });
    expect(typeof body.tasks[0]?.['createdAt']).toBe('number');
    expect(typeof body.tasks[0]?.['updatedAt']).toBe('number');
  });
});

describe('GET /api/tasks 从事件库聚合（重启不丢、不依赖内存登记）', () => {
  it('包含由内核直接 startTask 建出的任务（从未经 POST 登记）', async () => {
    const b = boot();
    const taskId = b.kernel.startTask({ title: '内核直建', requirementRaw: 'r', baseBranch: 'main' });
    await b.kernel.runTask(taskId);

    const res = await b.server.app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<{ taskId: string }> };
    expect(body.tasks.map((t) => t.taskId)).toContain(taskId);
  });

  it('内核直建的任务也可通过详情/事件接口读取（404 判据改到事件库）', async () => {
    const b = boot();
    const taskId = b.kernel.startTask({ title: '内核直建', requirementRaw: 'r', baseBranch: 'main' });

    const detail = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ taskId });

    const events = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/events` });
    expect(events.statusCode).toBe(200);
  });

  it('按 updatedAt 倒序排列（最新任务在最前）', async () => {
    const b = boot();
    b.kernel.startTask({ title: '先建', requirementRaw: 'r', baseBranch: 'main' });
    await sleep(15);
    b.kernel.startTask({ title: '后建', requirementRaw: 'r', baseBranch: 'main' });

    const res = await b.server.app.inject({ method: 'GET', url: '/api/tasks' });
    const body = res.json() as { tasks: Array<{ title: string; updatedAt: number }> };
    expect(body.tasks.map((t) => t.title)).toEqual(['后建', '先建']);
    expect(body.tasks[0]!.updatedAt).toBeGreaterThan(body.tasks[1]!.updatedAt);
  });
});

describe('GET /api/tasks/:taskId/nodes/:nodeId/log', () => {
  const LINES = [
    '{"type":"system","subtype":"init","n":1}',
    '{"type":"assistant","n":2}',
    '{"type":"assistant","n":3}',
    '{"type":"result","subtype":"error_max_structured_output_retries","n":4}',
    '{"type":"result","n":5}',
  ];

  it('正常路径：返回文件末 tail 行、逐字一致，totalLines/truncated 正确', async () => {
    const b = boot();
    const taskId = await startAndRun(b);
    const logRef = b.kernel.getState(taskId).nodes['pm_analyze']?.lastLogRef;
    expect(logRef).toBeTruthy();
    writeLogFile(logRef!, LINES);

    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/nodes/pm_analyze/log?tail=2`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      nodeId: string;
      logRef: string;
      totalLines: number;
      returnedLines: number;
      truncated: boolean;
      lines: string[];
    };
    expect(body.nodeId).toBe('pm_analyze');
    expect(body.logRef).toBe(resolve(logRef!));
    expect(body.totalLines).toBe(5);
    expect(body.returnedLines).toBe(2);
    expect(body.truncated).toBe(true);
    // 逐字一致：末 2 行
    expect(body.lines).toEqual(LINES.slice(3));
  });

  it('tail 超出总行数（含缺省 200）时返回全部且 truncated=false', async () => {
    const b = boot();
    const taskId = await startAndRun(b);
    const logRef = b.kernel.getState(taskId).nodes['pm_analyze']?.lastLogRef;
    writeLogFile(logRef!, LINES);

    for (const suffix of ['', '?tail=200']) {
      const res = await b.server.app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}/nodes/pm_analyze/log${suffix}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { totalLines: number; returnedLines: number; truncated: boolean; lines: string[] };
      expect(body.totalLines).toBe(5);
      expect(body.returnedLines).toBe(5);
      expect(body.truncated).toBe(false);
      expect(body.lines).toEqual(LINES);
    }
  });

  it('tail 非法时钳制到 [1,2000]（0/负数→1，非数字→默认 200，超上限→2000）', async () => {
    const b = boot();
    const taskId = await startAndRun(b);
    const logRef = b.kernel.getState(taskId).nodes['pm_analyze']?.lastLogRef;
    const many = Array.from({ length: 2500 }, (_, i) => `{"i":${i}}`);
    writeLogFile(logRef!, many);

    const get = async (suffix: string) => {
      const res = await b.server.app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}/nodes/pm_analyze/log${suffix}`,
      });
      expect(res.statusCode).toBe(200);
      return res.json() as { totalLines: number; returnedLines: number; truncated: boolean; lines: string[] };
    };

    const zero = await get('?tail=0');
    expect(zero.totalLines).toBe(2500);
    expect(zero.returnedLines).toBe(1);
    expect(zero.lines).toEqual([many[2499]]);

    const negative = await get('?tail=-9');
    expect(negative.returnedLines).toBe(1);

    const over = await get('?tail=99999');
    expect(over.returnedLines).toBe(2000);
    expect(over.truncated).toBe(true);
    expect(over.lines).toEqual(many.slice(500));

    const nan = await get('?tail=abc');
    expect(nan.returnedLines).toBe(200);
    expect(nan.lines).toEqual(many.slice(2300));
  });

  it('路径穿越防护：logRef 在日志根之外时返回 400，且不泄露文件内容', async () => {
    const b = boot();
    const secretPath = join(b.repo, 'secret.txt');
    writeFileSync(secretPath, 'TOP_SECRET_MARKER\n', 'utf8');
    expect(secretPath.startsWith(b.logDir)).toBe(false);

    // 形式一：绝对路径直指日志根之外
    const one = seedNodeWithLogRef(b, secretPath);
    const res1 = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${one.taskId}/nodes/${one.nodeId}/log`,
    });
    expect(res1.statusCode).toBe(400);
    expect(res1.body).toContain('越界');
    expect(res1.body).not.toContain('TOP_SECRET_MARKER');

    // 形式二：用 ../../ 从日志根逃逸
    const escapeRef = join(b.logDir, 'runs', '..', '..', 'secret.txt');
    const two = seedNodeWithLogRef(b, escapeRef);
    const res2 = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${two.taskId}/nodes/${two.nodeId}/log`,
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.body).not.toContain('TOP_SECRET_MARKER');
  });

  it('未知 nodeId 返回 404', async () => {
    const b = boot();
    const taskId = await startAndRun(b);
    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/nodes/nope/log`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('lastLogRef 为 null 的节点返回 404', async () => {
    const b = boot();
    const taskId = b.kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    // 只 queued、不 succeeded/failed → 节点的 lastLogRef 保持 null
    b.store.append({
      task_id: taskId,
      type: 'node.queued',
      payload: { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_seed', attempt: 1 },
      actor: 'kernel',
    });

    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/nodes/pm_analyze/log`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('没有日志引用');
  });

  it('未知任务返回 404', async () => {
    const b = boot();
    const res = await b.server.app.inject({
      method: 'GET',
      url: '/api/tasks/task_ghost/nodes/pm_analyze/log',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/tasks/:taskId/runs/:runId/log（运行中节点的回退日志端点）', () => {
  const LINES = [
    '{"type":"system","subtype":"init","n":1}',
    '{"type":"assistant","n":2}',
    '{"type":"assistant","n":3}',
    '{"type":"assistant","n":4}',
    '{"type":"result","n":5}',
  ];

  it('运行中节点（事件里没有 log_ref，只有 runId）也能取到活日志，返回 200', async () => {
    const b = boot();
    const { taskId, nodeId } = seedRunningNode(b, 'run_live');
    const logRef = join(b.logDir, 'runs', 'run_live.jsonl');
    writeLogFile(logRef, LINES);

    // 节点端点仍 404：事件里没有 log_ref，lastLogRef 保持 null
    const viaNode = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/nodes/${nodeId}/log`,
    });
    expect(viaNode.statusCode).toBe(404);

    // runId 端点按约定路径命中正在写入的日志文件
    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/runs/run_live/log?tail=2`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      runId: string;
      logRef: string;
      totalLines: number;
      returnedLines: number;
      truncated: boolean;
      lines: string[];
    };
    expect(body.runId).toBe('run_live');
    expect(body.logRef).toBe(resolve(logRef));
    expect(body.totalLines).toBe(5);
    expect(body.returnedLines).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.lines).toEqual(LINES.slice(3));
  });

  it('目录穿越防护：runId 用 ../../ 逃逸时返回 400，且不泄露文件内容', async () => {
    const b = boot();
    const secretPath = join(b.repo, 'secret.txt');
    writeFileSync(secretPath, 'TOP_SECRET_MARKER\n', 'utf8');
    const { taskId } = seedRunningNode(b, 'run_any');
    // logs/runs/../../secret.txt.jsonl → repo/secret.txt.jsonl，已在日志根之外
    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/runs/${encodeURIComponent('../../secret.txt')}/log`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('越界');
    expect(res.body).not.toContain('TOP_SECRET_MARKER');
  });

  it('日志文件尚未写出时返回 404', async () => {
    const b = boot();
    const { taskId } = seedRunningNode(b, 'run_missing');
    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/runs/run_missing/log`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('未知任务返回 404', async () => {
    const b = boot();
    const res = await b.server.app.inject({
      method: 'GET',
      url: '/api/tasks/task_ghost/runs/run_x/log',
    });
    expect(res.statusCode).toBe(404);
  });
});