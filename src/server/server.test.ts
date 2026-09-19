import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import { loadRole } from '../config/loader.js';
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

type BootOptions = {
  scripts?: FakeScriptItem[][];
  /** 角色查询/编辑 API 的配置根目录（测试必须用 mkdtemp 出来的副本，绝不能指向真实 config/） */
  configDir?: string;
  /** 刻意不向服务注入工作流，用于验证流转视图的 503 边界 */
  omitWorkflow?: boolean;
};

function boot(options?: BootOptions): Boot {
  const repo = mkdtempSync(join(tmpdir(), 'agentflow-repo-'));
  writeFileSync(join(repo, 'README.md'), '# x\n');
  const logDir = join(repo, 'logs');
  const store = createEventStore(':memory:');
  const runner = createFakeRunner({ scripts: options?.scripts ?? [DEFAULT_SCRIPT] });
  const roles = new Map<string, RoleDef>([['pm', role()]]);
  const kernel = createKernel({
    store,
    runner,
    workflow,
    roles,
    maxPromptTokens: 30_000,
    workspaceRoot: join(repo, '.ws'),
    logDir,
    repoPath: repo,
    maxSteps: 5,
  });
  // store 与 logDir 都交给服务层：列表从事件库聚合，日志端点需要日志根目录做穿越校验；
  // workflow/roles 供流转视图与角色使用情况使用；configDir 供角色查询/编辑 API 使用。
  const server = createServer({
    kernel,
    store,
    logDir,
    host: '127.0.0.1',
    port: 0,
    ...(options?.omitWorkflow ? {} : { workflow }),
    roles,
    ...(options?.configDir ? { configDir: options.configDir } : {}),
  });
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
  it('health 返回能力探测元信息（pid/startedAt/uptimeMs/features/claudeProcesses）', async () => {
    const { server } = boot();
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      pid: number;
      startedAt: number;
      uptimeMs: number;
      features: string[];
      claudeProcesses: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);
    expect(typeof body.startedAt).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    // 前端必需能力齐全，才能避免把日志 404 误读成「日志不存在」
    expect(body.features).toEqual(
      expect.arrayContaining(['log-by-node', 'log-by-run', 'live-stats']),
    );
    expect(Array.isArray(body.claudeProcesses)).toBe(true);
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

describe('日志端点：文件活性字段（B 项）', () => {
  const LINES = ['{"n":1}', '{"n":2}', '{"n":3}'];

  it('节点日志响应新增 sizeBytes/lastModifiedAt/ageMs，既有 6 个字段不变且与磁盘一致', async () => {
    const b = boot();
    const taskId = await startAndRun(b);
    const logRef = b.kernel.getState(taskId).nodes['pm_analyze']?.lastLogRef;
    writeLogFile(logRef!, LINES);

    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/nodes/pm_analyze/log?tail=2`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalLines: number;
      returnedLines: number;
      truncated: boolean;
      lines: string[];
      sizeBytes: number;
      lastModifiedAt: number;
      ageMs: number;
    };
    // 既有字段保持不变
    expect(body.totalLines).toBe(3);
    expect(body.returnedLines).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.lines).toEqual(LINES.slice(1));
    // 新增活性字段与磁盘真实文件一致
    const st = statSync(resolve(logRef!));
    expect(body.sizeBytes).toBe(st.size);
    expect(Math.abs(body.lastModifiedAt - Math.round(st.mtimeMs))).toBeLessThanOrEqual(1);
    expect(body.ageMs).toBeGreaterThanOrEqual(0);
    expect(body.ageMs).toBeLessThan(60_000);
  });

  it('runId 回退日志端点同样带活性字段', async () => {
    const b = boot();
    const { taskId } = seedRunningNode(b, 'run_live_stats');
    const logRef = join(b.logDir, 'runs', 'run_live_stats.jsonl');
    writeLogFile(logRef, LINES);

    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/runs/run_live_stats/log`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sizeBytes: number; lastModifiedAt: number; ageMs: number };
    const st = statSync(resolve(logRef));
    expect(body.sizeBytes).toBe(st.size);
    expect(body.ageMs).toBeGreaterThanOrEqual(0);
  });
});

describe('日志端点：错误原因码（F 项）', () => {
  it('NO_LOG_REF：节点无日志引用', async () => {
    const b = boot();
    const taskId = b.kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
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
    expect(res.json()).toMatchObject({ code: 'NO_LOG_REF' });
  });

  it('FILE_NOT_FOUND：log_ref 指向的文件不存在', async () => {
    const b = boot();
    const taskId = await startAndRun(b);
    // 不写出日志文件，直接请求 → 文件不存在
    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/nodes/pm_analyze/log`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('OUT_OF_LOG_ROOT：log_ref 越界返回 400 + code，且不泄露内容', async () => {
    const b = boot();
    const secretPath = join(b.repo, 'secret.txt');
    writeFileSync(secretPath, 'TOP_SECRET_MARKER\n', 'utf8');
    const { taskId, nodeId } = seedNodeWithLogRef(b, secretPath);

    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/nodes/${nodeId}/log`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'OUT_OF_LOG_ROOT' });
    expect(res.body).not.toContain('TOP_SECRET_MARKER');
  });

  it('runId 端点：文件不存在返回 FILE_NOT_FOUND + code', async () => {
    const b = boot();
    const { taskId } = seedRunningNode(b, 'run_never_written');
    const res = await b.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/runs/run_never_written/log`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'FILE_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Task 5：角色与流转的查询 API
// ---------------------------------------------------------------------------

/**
 * 角色 API 的测试配置目录：把**真实 config/ 复制一份**到临时目录再测。
 * 编辑角色会真实写文件，绝不能落在仓库的 config/ 上（那会污染真实配置）。
 */
function makeTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-server-cfg-'));
  cpSync(resolve(process.cwd(), 'config'), dir, { recursive: true });
  return dir;
}

/** 一份合法的 pm 角色编辑请求体（snake_case 配置字段对应的 camelCase 形态） */
function pmEdit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayName: '产品经理',
    systemPromptRef: 'prompts/pm.md',
    inputs: [],
    outputs: ['requirement'],
    owns: [],
    reads: ['docs/**'],
    responsibilities: ['澄清需求'],
    prohibitions: ['不写代码'],
    doneCriteria: ['产出 requirement'],
    model: 'sonnet',
    maxRetries: 2,
    maxWallTimeMs: 900000,
    ...overrides,
  };
}

describe('Task 5：角色列表与详情 API', () => {
  it('GET /api/roles 返回全部角色的职责/禁止事项/完成判据/可写路径/可读路径/模型/预算', async () => {
    const configDir = makeTempConfigDir();
    const { server } = boot({ configDir });
    const res = await server.app.inject({ method: 'GET', url: '/api/roles' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { roles: Array<Record<string, unknown>> };
    // 期望值随 config/roles 真实注册数更新：Task 12 新增了 parallel_dev 用的 3 个角色
    // （pm_planner / backend_dev_module_a / backend_dev_module_b）。
    expect(body.roles.map((r) => r['id']).sort()).toEqual([
      'backend_dev',
      'backend_dev_module_a',
      'backend_dev_module_b',
      'pm',
      'pm_planner',
      'qa_engineer',
    ]);

    const pm = body.roles.find((r) => r['id'] === 'pm')!;
    expect(pm['displayName']).toBe('产品经理');
    expect(pm['systemPromptRef']).toBe('prompts/pm.md');
    expect(pm['responsibilities']).toEqual([
      '把用户的一句话需求转写成可执行、可验收的需求文档（产物 requirement）',
      '明确划定"不做什么"，防止范围蔓延',
      '给出可被观测验证的验收标准',
    ]);
    expect(Array.isArray(pm['prohibitions'])).toBe(true);
    expect(Array.isArray(pm['doneCriteria'])).toBe(true);
    expect(pm['owns']).toEqual([]);
    expect(pm['reads']).toEqual(['docs/**']);
    expect(pm['model']).toBe('sonnet');
    expect(pm['budget']).toEqual({ maxRetries: 2, maxWallTimeMs: 900000 });
  });

  it('GET /api/roles/:id 返回详情；未知角色 404；非法 id 400', async () => {
    const configDir = makeTempConfigDir();
    const { server } = boot({ configDir });

    const ok = await server.app.inject({ method: 'GET', url: '/api/roles/backend_dev' });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as Record<string, unknown>;
    expect(body['id']).toBe('backend_dev');
    expect(body['owns']).toEqual(['src/**']);
    expect(body['budget']).toEqual({ maxRetries: 2, maxWallTimeMs: 1800000 });

    const missing = await server.app.inject({ method: 'GET', url: '/api/roles/nope' });
    expect(missing.statusCode).toBe(404);

    // 非法 id 必须挡在文件路径拼接之前（杜绝 `../` 之类越界读文件）
    const bad = await server.app.inject({ method: 'GET', url: '/api/roles/bad.id' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'INVALID_ROLE_ID' });
  });

  it('未配置 configDir 时角色 API 返回 503，而不是伪装成空列表', async () => {
    const { server } = boot();
    const res = await server.app.inject({ method: 'GET', url: '/api/roles' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'CONFIG_DIR_MISSING' });
  });
});

describe('Task 5：某任务的角色使用情况', () => {
  it('返回 角色↔节点↔状态↔产出类型↔耗时↔花费（结构化字段）', async () => {
    const b = boot();
    const taskId = await startAndRun(b, '角色使用');
    const res = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/roles` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      taskId: string;
      totalCostUsd: number;
      roles: Array<{
        roleId: string;
        displayName: string | null;
        model: string | null;
        budget: { maxRetries: number; maxWallTimeMs: number } | null;
        totalCostUsd: number;
        nodes: Array<{
          nodeId: string;
          status: string;
          produces: string | null;
          artifactTypes: string[];
          attempt: number;
          durationMs: number | null;
          costUsd: number;
        }>;
      }>;
    };
    expect(body.taskId).toBe(taskId);
    expect(body.roles).toHaveLength(1);
    const pm = body.roles[0]!;
    expect(pm).toMatchObject({ roleId: 'pm', displayName: '产品经理', model: 'sonnet' });
    expect(pm.budget).toEqual({ maxRetries: 1, maxWallTimeMs: 60_000 });
    expect(pm.nodes).toHaveLength(1);
    expect(pm.nodes[0]).toMatchObject({
      nodeId: 'pm_analyze',
      status: 'succeeded',
      produces: 'requirement',
      artifactTypes: ['requirement'],
      attempt: 1,
      costUsd: 0.02,
    });
    expect(typeof pm.nodes[0]!.durationMs).toBe('number');
    expect(pm.totalCostUsd).toBeCloseTo(0.02, 10);
    expect(body.totalCostUsd).toBeCloseTo(0.02, 10);
  });

  it('边界：只有 task.created、没有任何节点的任务 → roles 为空数组', async () => {
    const b = boot();
    const taskId = b.kernel.startTask({ title: '空', requirementRaw: 'r', baseBranch: 'main' });
    const res = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/roles` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ taskId, roles: [], totalCostUsd: 0 });
  });

  it('未知任务返回 404', async () => {
    const { server } = boot();
    const res = await server.app.inject({ method: 'GET', url: '/api/tasks/task_ghost/roles' });
    expect(res.statusCode).toBe(404);
  });
});

describe('Task 5：某任务的流转视图', () => {
  it('返回拓扑（节点+边+边说明）与每节点的进入理由、状态、耗时、花费', async () => {
    const b = boot();
    const taskId = await startAndRun(b);
    const res = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/flow` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      taskId: string;
      status: string;
      edges: unknown[];
      transfers: unknown[];
      taskFailure: unknown;
      nodes: Array<Record<string, unknown>>;
    };
    expect(body.taskId).toBe(taskId);
    expect(body.status).toBe('completed');
    expect(body.edges).toEqual([]);
    expect(body.nodes).toHaveLength(1);
    const node = body.nodes[0]!;
    expect(node).toMatchObject({
      id: 'pm_analyze',
      title: '需求分析',
      role: 'pm',
      roleDisplayName: '产品经理',
      status: 'succeeded',
      produces: 'requirement',
      current: false,
      artifactTypes: ['requirement'],
    });
    expect(node['enterReason']).toMatchObject({ from: '', reason: '任务开始，进入起始节点' });
    expect((node['enterReason'] as Record<string, unknown>)['edge']).toBeNull();
    expect(node['blockedReason']).toBeNull();
    expect(node['costUsd']).toBeCloseTo(0.02, 10);
    expect(typeof node['durationMs']).toBe('number');
    expect(body.transfers).toHaveLength(1);
    expect(body.taskFailure).toBeNull();
  });

  it('失败节点带分类化阻塞原因，任务级失败原因同时含分类与未满足条件', async () => {
    const FAIL_SCRIPT: FakeScriptItem[] = [
      { kind: 'failure', reason: 'timeout', detail: 'CLI 超时' },
      { kind: 'exited', code: 1 },
    ];
    const b = boot({ scripts: [FAIL_SCRIPT] });
    const taskId = await startAndRun(b);
    const res = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/flow` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      taskFailure: {
        reason: string;
        category: string | null;
        label: string | null;
        unmetConditions: string[];
        artifactStatuses: unknown[];
      } | null;
      nodes: Array<Record<string, unknown>>;
    };
    expect(body.status).toBe('failed');
    const node = body.nodes[0]!;
    expect(node['status']).toBe('failed');
    expect(node['blockedReason']).toMatchObject({ category: 'timeout', label: '超时' });
    expect((node['blockedReason'] as Record<string, unknown>)['error']).toContain('CLI 退出码 1');
    expect(body.taskFailure).toMatchObject({ category: 'timeout', label: '超时' });
    expect(Array.isArray(body.taskFailure!.unmetConditions)).toBe(true);
    expect(Array.isArray(body.taskFailure!.artifactStatuses)).toBe(true);
  });

  it('边界：未跑过的任务 → 节点 not_started、无转移、无失败原因', async () => {
    const b = boot();
    const taskId = b.kernel.startTask({ title: '未跑', requirementRaw: 'r', baseBranch: 'main' });
    const res = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/flow` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      nodes: Array<Record<string, unknown>>;
      transfers: unknown[];
      taskFailure: unknown;
    };
    expect(body.nodes[0]).toMatchObject({ id: 'pm_analyze', status: 'not_started', attempt: 0 });
    expect(body.nodes[0]!['enterReason']).toBeNull();
    expect(body.transfers).toEqual([]);
    expect(body.taskFailure).toBeNull();
  });

  it('未知任务返回 404；未注入工作流时返回 503', async () => {
    const { server } = boot();
    const ghost = await server.app.inject({ method: 'GET', url: '/api/tasks/task_ghost/flow' });
    expect(ghost.statusCode).toBe(404);

    const withoutWf = boot({ omitWorkflow: true });
    const taskId = withoutWf.kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const res = await withoutWf.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/flow` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'WORKFLOW_MISSING' });
  });
});

// ---------------------------------------------------------------------------
// Task 6：角色编辑 API（校验通过才写回 YAML；失败不产生任何写入）
// ---------------------------------------------------------------------------

describe('Task 6：角色编辑 API', () => {
  it('合法编辑写回后，重新加载（生产加载器）得到与提交一致的角色', async () => {
    const configDir = makeTempConfigDir();
    const { server } = boot({ configDir });
    const res = await server.app.inject({
      method: 'PUT',
      url: '/api/roles/pm',
      payload: pmEdit({ reads: ['docs/**', 'specs/**'], responsibilities: ['澄清需求', '划定范围'], maxRetries: 1, maxWallTimeMs: 1000 }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { role: Record<string, unknown>; path: string };
    expect(body.role).toMatchObject({
      id: 'pm',
      reads: ['docs/**', 'specs/**'],
      responsibilities: ['澄清需求', '划定范围'],
      budget: { maxRetries: 1, maxWallTimeMs: 1000 },
    });
    expect(body.path).toBe(join(configDir, 'roles', 'pm.yaml'));

    // 用生产加载路径重新加载：得到与提交一致的角色
    const role = loadRole(configDir, 'pm');
    expect(role.reads).toEqual(['docs/**', 'specs/**']);
    expect(role.responsibilities).toEqual(['澄清需求', '划定范围']);
    expect(role.maxRetries).toBe(1);
    expect(role.maxWallTimeMs).toBe(1000);

    // 查询 API 也能读到编辑后的值
    const detail = await server.app.inject({ method: 'GET', url: '/api/roles/pm' });
    expect((detail.json() as Record<string, unknown>)['reads']).toEqual(['docs/**', 'specs/**']);
  });

  it('非法编辑（预算为负）：返回 400，配置文件逐字不变', async () => {
    const configDir = makeTempConfigDir();
    const target = join(configDir, 'roles', 'pm.yaml');
    const before = readFileSync(target, 'utf8');
    const { server } = boot({ configDir });

    const res = await server.app.inject({
      method: 'PUT',
      url: '/api/roles/pm',
      payload: pmEdit({ maxWallTimeMs: -5 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('请求体不合法');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('必填字段缺失（responsibilities 为空数组）：返回 400，配置文件逐字不变', async () => {
    const configDir = makeTempConfigDir();
    const target = join(configDir, 'roles', 'pm.yaml');
    const before = readFileSync(target, 'utf8');
    const { server } = boot({ configDir });

    const res = await server.app.inject({
      method: 'PUT',
      url: '/api/roles/pm',
      payload: pmEdit({ responsibilities: [] }),
    });
    expect(res.statusCode).toBe(400);
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('破坏契约一致性的编辑（改 outputs）：写入前被拒 422，配置文件逐字不变', async () => {
    const configDir = makeTempConfigDir();
    const target = join(configDir, 'roles', 'pm.yaml');
    const before = readFileSync(target, 'utf8');
    const { server } = boot({ configDir });

    // pm 的 outputs 是工作流 pm_analyze 节点 produces 的权威来源；改掉它会让二者冲突，
    // 必须复用加载期一致性校验在**写入前**拒绝（否则会写出无法加载的配置）。
    const res = await server.app.inject({
      method: 'PUT',
      url: '/api/roles/pm',
      payload: pmEdit({ outputs: ['test_report'] }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('编辑被拒绝');
    expect(res.body).toContain('契约冲突');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('编辑不存在的角色返回 404，且不会凭空创建文件', async () => {
    const configDir = makeTempConfigDir();
    const { server } = boot({ configDir });
    const res = await server.app.inject({
      method: 'PUT',
      url: '/api/roles/ghost',
      payload: pmEdit(),
    });
    expect(res.statusCode).toBe(404);
    expect(existsSync(join(configDir, 'roles', 'ghost.yaml'))).toBe(false);
  });
});

describe('取消任务端点（内核 cancel 的 HTTP 入口）', () => {
  it('取消运行中的任务：任务与节点都落到 cancelled，返回 cancelled: true 与完整 state', async () => {
    const b = boot();
    const { taskId, nodeId } = seedRunningNode(b, 'run_cancel');

    const res = await b.server.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/cancel`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      cancelled: boolean;
      reason?: string;
      state: { status: string; currentNodeIds: string[]; nodes: Record<string, { status: string }> };
    };
    expect(body.cancelled).toBe(true);
    expect(body.reason).toBeUndefined();
    expect(body.state.status).toBe('cancelled');
    expect(body.state.currentNodeIds).toEqual([]);
    expect(body.state.nodes[nodeId]!.status).toBe('cancelled');

    // 事件库里的凭据：node.cancelled + task.cancelled（服务重启后同样读得到）
    const detail = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect((detail.json() as { status: string }).status).toBe('cancelled');
  });

  it('取消后到达的 task.failed 是终止余波：流转视图不得同时报告"已取消"和"失败原因"', async () => {
    const b = boot();
    const { taskId, nodeId } = seedRunningNode(b, 'run_late');
    await b.server.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/cancel` });
    // 模拟"进程被杀后节点收尾"：在途节点迟到的 node.failed + task.failed
    b.store.append({
      task_id: taskId,
      type: 'node.failed',
      payload: { node_id: nodeId, run_id: 'run_late', error: 'CLI 退出码 -1' },
      actor: 'kernel',
    });
    b.store.append({
      task_id: taskId,
      type: 'task.failed',
      payload: { reason: `节点 ${nodeId} 执行失败`, reason_category: 'other', reason_label: '其他' },
      actor: 'kernel',
    });

    const res = await b.server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/flow` });
    const body = res.json() as {
      status: string;
      taskFailure: unknown;
      nodes: Array<{ id: string; status: string }>;
    };
    expect(body.status).toBe('cancelled');
    expect(body.taskFailure).toBeNull();
    expect(body.nodes.find((n) => n.id === nodeId)!.status).toBe('cancelled');
  });

  it('已终态的任务：幂等返回 cancelled: false 与中文原因，不写新事件', async () => {
    const b = boot();
    const taskId = await startAndRun(b);
    const before = b.store.readTask(taskId).length;

    const res = await b.server.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/cancel`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { cancelled: boolean; reason?: string; state: { status: string } };
    expect(body.cancelled).toBe(false);
    expect(body.reason).toContain('终态');
    expect(body.state.status).toBe('completed');
    expect(b.store.readTask(taskId).length).toBe(before);
  });

  it('未知任务返回 404（不静默成功）', async () => {
    const { server } = boot();
    const res = await server.app.inject({ method: 'POST', url: '/api/tasks/task_ghost/cancel' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  it('health 声明 task-cancel 能力（前端据此判断后端是否落后）', async () => {
    const { server } = boot();
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect((res.json() as { features: string[] }).features).toContain('task-cancel');
  });
});