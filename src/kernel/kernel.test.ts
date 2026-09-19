import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKernel } from './kernel.js';
import { project } from './projector.js';
import { createEventStore } from './event-store.js';
import { createFakeRunner, type FakeRunner, type FakeScriptItem } from '../runner/fake-runner.js';
import type { AgentRunner, RunRequest, RunnerEvent } from '../runner/types.js';
import type { RoleDef, WorkflowDef } from '../shared/domain.js';

const workflow: WorkflowDef = {
  id: 'simple_dev',
  start: 'pm_analyze',
  nodes: [
    { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
    { id: 'dev_implement', title: '编码实现', role: 'backend_dev', consumes: ['requirement'], produces: 'code_diff', isolate: false },
    { id: 'qa_verify', title: '测试验证', role: 'qa_engineer', consumes: ['requirement', 'code_diff'], produces: 'test_report', isolate: false },
  ],
  edges: [
    { from: 'pm_analyze', to: 'dev_implement', when: "all(artifacts.requirement.status == 'ok')", description: '需求已澄清', onMissing: 'fail' },
    { from: 'dev_implement', to: 'qa_verify', when: "all(artifacts.code_diff.status == 'ok')", description: '改动自测通过', onMissing: 'fail' },
  ],
};

function roles(): Map<string, RoleDef> {
  const make = (id: string, outputs: string[], owns: string[]): RoleDef => ({
    id,
    displayName: id,
    systemPrompt: `你是 ${id}`,
    inputs: [],
    outputs,
    owns,
    reads: [],
    responsibilities: [`${id} 的职责`],
    prohibitions: [`${id} 的禁止事项`],
    doneCriteria: [`${id} 的完成判据`],
    model: 'sonnet',
    maxRetries: 1,
    maxWallTimeMs: 60_000,
  });
  return new Map([
    ['pm', make('pm', ['requirement'], [])],
    ['backend_dev', make('backend_dev', ['code_diff'], ['src/**'])],
    ['qa_engineer', make('qa_engineer', ['test_report'], ['tests/**'])],
  ]);
}

const ARTIFACTS: Record<string, unknown> = {
  requirement: {
    problem: '多角色无法自动流转',
    goals: ['实现自动流转'],
    non_goals: ['不做分布式'],
    acceptance_criteria: ['一个需求输入后三角色自动完成'],
  },
  code_diff: {
    wp_id: 'wp1',
    branch: 'main',
    files_changed: ['src/a.ts'],
    insertions: 10,
    deletions: 2,
    self_test_result: 'passed',
    notes: '已自测',
  },
  test_report: { wp_id: 'wp1', suites: ['unit'], passed: 5, failed: 0, failures: [] },
};

function scriptFor(artifactType: string): FakeScriptItem[] {
  return [
    { kind: 'log', chunk: `开始执行 ${artifactType}` },
    { kind: 'artifact', raw: ARTIFACTS[artifactType] },
    { kind: 'usage', tokensIn: 100, tokensOut: 50, costUsd: 0.01 },
    { kind: 'exited', code: 0 },
  ];
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-repo-'));
  writeFileSync(join(dir, 'README.md'), '# 测试仓库\n');
  return dir;
}

/**
 * 临时日志目录。刻意以 `logs` 作为末级目录名，与生产配置 `AGENTFLOW_LOG_DIR=./logs`
 * 的路径形状一致——`log_ref` 里必须出现 `logs/runs/<run_id>.jsonl` 这段形状。
 */
function makeLogDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'agentflow-logs-')), 'logs');
}

function makeKernel(scripts: FakeScriptItem[][] | undefined, repoPath: string, logDir: string) {
  const store = createEventStore(':memory:');
  const runner = createFakeRunner(
    scripts
      ? { scripts }
      : {
          scripts: [
            scriptFor('requirement'),
            scriptFor('code_diff'),
            scriptFor('test_report'),
          ],
        },
  );
  const kernel = createKernel({
    store,
    runner,
    workflow,
    roles: roles(),
    maxPromptTokens: 30_000,
    workspaceRoot: join(repoPath, '.agentflow-ws'),
    logDir,
    repoPath,
    maxSteps: 20,
  });
  return { kernel, store, runner };
}

describe('Kernel 串行闭环', () => {
  it('三个角色自动流转完成，任务状态为 completed', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({
      title: '自动流转',
      requirementRaw: '让多角色自动流转',
      baseBranch: 'main',
    });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('completed');
    expect(state.completedNodeIds).toEqual(['pm_analyze', 'dev_implement', 'qa_verify']);
    store.close();
  });

  it('产出 3 个 Artifact，类型与节点对应', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.artifacts.map((a) => a.type).sort()).toEqual([
      'code_diff',
      'requirement',
      'test_report',
    ]);
    store.close();
  });

  it('事件库能完整重放出相同状态', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const live = await kernel.runTask(taskId);
    const replayed = kernel.getState(taskId);

    expect(replayed).toEqual(live);
    expect(store.readTask(taskId).length).toBeGreaterThan(8);
    store.close();
  });

  it('记录了每一步转移的理由与决策来源', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.transfers.map((t) => `${t.from}→${t.to}`)).toEqual([
      '→pm_analyze',
      'pm_analyze→dev_implement',
      'dev_implement→qa_verify',
    ]);
    expect(state.transfers.every((t) => t.decidedBy === 'rule')).toBe(true);
    store.close();
  });

  it('runner 收到的工作目录、只读标记与产出 schema 正确', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store, runner } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    await kernel.runTask(taskId);

    expect(runner.requests).toHaveLength(3);
    expect(runner.requests[0]?.artifactType).toBe('requirement');
    expect(runner.requests[0]?.readOnly).toBe(true);
    expect(runner.requests[0]?.outputSchema).toBeDefined();
    expect(runner.requests[1]?.readOnly).toBe(false);
    store.close();
  });

  it('节点失败时任务标记为 failed，且不继续推进', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(
      [
        scriptFor('requirement'),
        [{ kind: 'log', chunk: '编译报错' }, { kind: 'exited', code: 1 }],
      ],
      repo,
      logs,
    );

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('failed');
    expect(state.nodes.dev_implement?.status).toBe('failed');
    expect(state.completedNodeIds).toEqual(['pm_analyze']);
    store.close();
  });

  it('产出载荷不合规时该节点失败', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(
      [
        [{ kind: 'artifact', raw: { problem: 123 } }, { kind: 'exited', code: 0 }],
      ],
      repo,
      logs,
    );

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);
    expect(state.nodes.pm_analyze?.status).toBe('failed');
    store.close();
  });

  it('产出不合规载荷时任务以 failed 收尾，且不调用后续 runner', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    // pm 产出缺字段的 requirement：载荷校验失败 → 节点失败 → 任务失败 → 不推进到 dev_implement
    const { kernel, store, runner } = makeKernel(
      [[{ kind: 'artifact', raw: { problem: '' } }, { kind: 'exited', code: 0 }]],
      repo,
      logs,
    );

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);
    expect(state.status).toBe('failed');
    expect(runner.requests).toHaveLength(1);
    store.close();
  });

  it('退出码为 0 但零产物时节点失败，不会静默空跑成功', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    // hasArtifact 判据：CLI 退出码为 0，却没有任何 artifact 事件 → 不得当作成功
    const { kernel, store, runner } = makeKernel(
      [[{ kind: 'log', chunk: '看起来完成了' }, { kind: 'exited', code: 0 }]],
      repo,
      logs,
    );

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.nodes.pm_analyze?.status).toBe('failed');
    expect(state.nodes.pm_analyze?.lastError).toContain('结构化结果');
    expect(state.status).toBe('failed');
    expect(runner.requests).toHaveLength(1);
    store.close();
  });

  it('原始日志写入 logs 目录，事件库里只有引用不含日志正文', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    await kernel.runTask(taskId);

    const events = store.readTask(taskId);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('开始执行 requirement');

    const logFiles = JSON.stringify(events).match(/logs\/runs\/[^"]+\.jsonl/g);
    expect(logFiles).not.toBeNull();
    store.close();
  });

  it('node.started 落库即带 log_ref：运行中节点 lastLogRef 非空，且与结束时一致', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    const events = store.readTask(taskId);
    const started = events.find(
      (e) => e.type === 'node.started' && e.payload['node_id'] === 'pm_analyze',
    );
    expect(started).toBeDefined();
    const runId = String(started!.payload['run_id']);
    const expected = join(logs, 'runs', `${runId}.jsonl`);
    expect(started!.payload['log_ref']).toBe(expected);

    // 只重放到 node.started：模拟“节点正在运行”的投影，lastLogRef 必须已经非空
    const startedIndex = events.indexOf(started!);
    const running = project(events.slice(0, startedIndex + 1));
    expect(running.nodes['pm_analyze']?.status).toBe('running');
    expect(running.nodes['pm_analyze']?.lastLogRef).toBe(expected);

    // 节点结束后引用不变：succeeded 的 log_ref 与 started 逐字一致
    const succeeded = events.find(
      (e) => e.type === 'node.succeeded' && e.payload['node_id'] === 'pm_analyze',
    );
    expect(succeeded?.payload['log_ref']).toBe(expected);
    expect(state.nodes['pm_analyze']?.lastLogRef).toBe(expected);
    store.close();
  });

  it('自环工作流被死循环保护终止，不会无限重试', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const store = createEventStore(':memory:');
    // 让 pm 每次都成功，但工作流里加一条 pm→pm 的自环，触发节点访问次数保护
    const loopWorkflow: WorkflowDef = {
      ...workflow,
      edges: [{ from: 'pm_analyze', to: 'pm_analyze', when: 'true', description: '自环', onMissing: 'fail' }],
    };
    const runner = createFakeRunner({
      scripts: Array.from({ length: 30 }, () => scriptFor('requirement')),
    });
    const kernel = createKernel({
      store,
      runner,
      workflow: loopWorkflow,
      roles: roles(),
      maxPromptTokens: 30_000,
      workspaceRoot: join(repo, '.agentflow-ws'),
      logDir: logs,
      repoPath: repo,
      maxSteps: 50,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('failed');
    // 失败原因记录在 task.failed 事件里（transfers 只记录成功的转移）
    const failedEvent = kernel
      .getEvents(taskId)
      .find((e) => e.type === 'task.failed');
    expect(String(failedEvent?.payload['reason'])).toContain('访问次数');
    // 只跑了 3 次就被拦住，不是无限重试
    expect(runner.requests).toHaveLength(3);
    store.close();
  });
});

describe('Artifact status 由模型决定并被内核消费', () => {
  it('模型判 blocked 时 artifact.status 记 blocked，边不通过 → 任务 failed 且错误信息说明原因', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store, runner } = makeKernel(
      [
        [
          {
            kind: 'artifact',
            raw: { ...(ARTIFACTS['requirement'] as Record<string, unknown>), status: 'blocked' },
          },
          { kind: 'usage', tokensIn: 100, tokensOut: 50, costUsd: 0.01 },
          { kind: 'exited', code: 0 },
        ],
      ],
      repo,
      logs,
    );

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    // status 来自模型的结构化输出，而不是内核写死的 ok
    expect(state.artifacts.find((a) => a.type === 'requirement')?.status).toBe('blocked');
    // 边条件 all(artifacts.requirement.status == 'ok') 不成立 → 不再推进到 dev_implement
    expect(runner.requests).toHaveLength(1);
    expect(state.status).toBe('failed');
    expect(state.completedNodeIds).toEqual(['pm_analyze']);

    const failedEvent = kernel.getEvents(taskId).find((e) => e.type === 'task.failed');
    const reason = String(failedEvent?.payload['reason']);
    expect(reason).toContain('pm_analyze');
    expect(reason).toContain('requirement=blocked');
    store.close();
  });

  it('模型未给 status 时默认为 ok，流程照常流转到底', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.artifacts.every((a) => a.status === 'ok')).toBe(true);
    expect(state.status).toBe('completed');
    store.close();
  });
});

describe('Task 创建的元数据落库', () => {
  it('task.created 事件包含标题与原始需求', () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);
    const taskId = kernel.startTask({ title: 'A', requirementRaw: 'B', baseBranch: 'dev' });
    const [first] = store.readTask(taskId);
    expect(first?.type).toBe('task.created');
    expect(first?.payload['title']).toBe('A');
    expect(first?.payload['requirement_raw']).toBe('B');
    expect(first?.payload['base_branch']).toBe('dev');
    store.close();
  });

  it('getEvents 返回按 seq 升序的真实事件', () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);
    const taskId = kernel.startTask({ title: 'A', requirementRaw: 'B', baseBranch: 'main' });
    const events = kernel.getEvents(taskId);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    expect(events[0]?.type).toBe('task.created');
    store.close();
  });

  it('getState 对未知任务抛错', () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);
    expect(() => kernel.getState('task_nope')).toThrow(/task_nope/);
    store.close();
  });
});

describe('失败原因分类化（Task 3）', () => {
  it('结构化输出重试耗尽：node.failed / task.failed 带稳定分类与中文说明，并保留原始 CLI 文本', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const rawDetail = '调用失败：subtype=error_max_structured_output_retries，result=undefined';
    const { kernel, store } = makeKernel(
      [
        [
          { kind: 'failure', reason: 'structured_output_retries_exhausted', detail: rawDetail },
          { kind: 'log', chunk: rawDetail },
          { kind: 'exited', code: 1 },
        ],
      ],
      repo,
      logs,
    );

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);
    expect(state.status).toBe('failed');

    const events = kernel.getEvents(taskId);
    const nodeFailed = events.find((e) => e.type === 'node.failed');
    expect(nodeFailed?.payload['reason_category']).toBe('structured_output_retries_exhausted');
    expect(nodeFailed?.payload['reason_label']).toBe('结构化输出重试耗尽');
    // 原始 CLI 文本作为附加信息保留（不丢原文）
    expect(String(nodeFailed?.payload['error'])).toContain('error_max_structured_output_retries');

    const taskFailed = events.find((e) => e.type === 'task.failed');
    expect(taskFailed?.payload['reason_category']).toBe('structured_output_retries_exhausted');
    expect(taskFailed?.payload['reason_label']).toBe('结构化输出重试耗尽');
    expect(String(taskFailed?.payload['raw'])).toContain('error_max_structured_output_retries');
    store.close();
  });

  it('超时分类为 timeout', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(
      [
        [
          { kind: 'failure', reason: 'timeout', detail: '调用超过 wall-clock 上限 60000ms，已被强制终止' },
          { kind: 'exited', code: -1 },
        ],
      ],
      repo,
      logs,
    );
    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    await kernel.runTask(taskId);
    const nodeFailed = kernel.getEvents(taskId).find((e) => e.type === 'node.failed');
    expect(nodeFailed?.payload['reason_category']).toBe('timeout');
    expect(nodeFailed?.payload['reason_label']).toBe('超时');
    store.close();
  });

  it('载荷不合规分类为 invalid_payload', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(
      [[{ kind: 'artifact', raw: { problem: 123 } }, { kind: 'exited', code: 0 }]],
      repo,
      logs,
    );
    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    await kernel.runTask(taskId);
    const events = kernel.getEvents(taskId);
    const nodeFailed = events.find((e) => e.type === 'node.failed');
    expect(nodeFailed?.payload['reason_category']).toBe('invalid_payload');
    expect(nodeFailed?.payload['reason_label']).toBe('载荷不合规');
    expect(events.find((e) => e.type === 'task.failed')?.payload['reason_category']).toBe(
      'invalid_payload',
    );
    store.close();
  });

  it('runner 未给出分类时归入 other，原始退出码文本仍在', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(
      [
        scriptFor('requirement'),
        [{ kind: 'log', chunk: '编译失败' }, { kind: 'exited', code: 1 }],
      ],
      repo,
      logs,
    );
    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    await kernel.runTask(taskId);
    const nodeFailed = kernel
      .getEvents(taskId)
      .find((e) => e.type === 'node.failed' && e.payload['node_id'] === 'dev_implement');
    expect(nodeFailed?.payload['reason_category']).toBe('other');
    expect(nodeFailed?.payload['reason_label']).toBe('其他');
    expect(String(nodeFailed?.payload['error'])).toContain('CLI 退出码 1');
    store.close();
  });
});

describe('转移决策的可解释性（Task 4）', () => {
  it('transfer.decided 记录所用边、条件原文、边的人类可读说明与判定依据', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(undefined, repo, logs);
    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    await kernel.runTask(taskId);

    const transfer = kernel
      .getEvents(taskId)
      .find((e) => e.type === 'transfer.decided' && e.payload['to'] === 'dev_implement');
    expect(transfer).toBeDefined();
    const p = transfer!.payload;
    expect(p['edge']).toEqual({ from: 'pm_analyze', to: 'dev_implement' });
    expect(p['when']).toBe("all(artifacts.requirement.status == 'ok')");
    // 人类可读说明直接取自工作流边的 description，引擎不另造一套
    expect(p['edge_description']).toBe('需求已澄清');
    expect(p['artifact_statuses']).toEqual([{ type: 'requirement', status: 'ok' }]);

    // 投影后的转移记录同样可读到这些字段（供后续流转视图消费）
    const rec = kernel.getState(taskId).transfers.find((t) => t.to === 'dev_implement');
    expect(rec?.edge).toEqual({ from: 'pm_analyze', to: 'dev_implement' });
    expect(rec?.when).toBe("all(artifacts.requirement.status == 'ok')");
    expect(rec?.edgeDescription).toBe('需求已澄清');
    expect(rec?.artifactStatuses).toEqual([{ type: 'requirement', status: 'ok' }]);

    // 起始进入没有入边：edge 缺省、when 为 null，旧字段语义不变
    const first = kernel.getState(taskId).transfers[0];
    expect(first?.to).toBe('pm_analyze');
    expect(first?.edge).toBeUndefined();
    expect(first?.when).toBeNull();
    store.close();
  });

  it('串行直线流程的转移序列与决策来源保持不变（串行等价性）', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store, runner } = makeKernel(undefined, repo, logs);
    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('completed');
    expect(state.completedNodeIds).toEqual(['pm_analyze', 'dev_implement', 'qa_verify']);
    expect(state.transfers.map((t) => `${t.from}→${t.to}`)).toEqual([
      '→pm_analyze',
      'pm_analyze→dev_implement',
      'dev_implement→qa_verify',
    ]);
    expect(state.transfers.every((t) => t.decidedBy === 'rule')).toBe(true);
    expect(runner.requests).toHaveLength(3);
    store.close();
  });

  it('无条件满足出边时任务 failed，原因同时含未满足条件、产物实际状态与分类化原因', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const { kernel, store } = makeKernel(
      [
        [
          {
            kind: 'artifact',
            raw: { ...(ARTIFACTS['requirement'] as Record<string, unknown>), status: 'blocked' },
          },
          { kind: 'exited', code: 0 },
        ],
      ],
      repo,
      logs,
    );
    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);
    expect(state.status).toBe('failed');

    const p = kernel.getEvents(taskId).find((e) => e.type === 'task.failed')!.payload;
    expect(p['reason_category']).toBe('condition_unmet');
    expect(p['reason_label']).toBe('条件不满足');
    expect(p['unmet_conditions']).toEqual(["all(artifacts.requirement.status == 'ok')"]);
    expect(p['artifact_statuses']).toEqual([{ type: 'requirement', status: 'blocked' }]);
    // 既有中文说明文案保留
    expect(String(p['reason'])).toContain('requirement=blocked');
    store.close();
  });
});

describe('owns 路径级强制与越界检出（Task 7）', () => {
  /** 真实临时 git 仓库：越界核对走真实 `git status`，未跟踪新文件必须被覆盖 */
  function makeGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agentflow-git-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'README.md'), '# 基座\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init'],
      { cwd: dir, stdio: 'pipe' },
    );
    return dir;
  }

  function makeKernelInRepo(repoPath: string, logDir: string, runner: FakeRunner) {
    const store = createEventStore(':memory:');
    const kernel = createKernel({
      store,
      runner,
      workflow,
      roles: roles(),
      maxPromptTokens: 30_000,
      workspaceRoot: join(repoPath, '.agentflow-ws'),
      logDir,
      repoPath,
      maxSteps: 20,
    });
    return { kernel, store };
  }

  it('越界写被检出：artifact.invalidated + permission_denied，任务不静默继续', async () => {
    const repo = makeGitRepo();
    const logs = makeLogDir();
    const runner = createFakeRunner({
      scripts: [scriptFor('requirement'), scriptFor('code_diff'), scriptFor('test_report')],
      // backend_dev（code_diff）越界写 README.md —— 复刻端到端实测的那次越界
      onRun: (req) => {
        if (req.artifactType === 'code_diff') {
          writeFileSync(join(req.workdir, 'README.md'), '# 越界写入\n');
        }
      },
    });
    const { kernel, store } = makeKernelInRepo(repo, logs, runner);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('failed');
    expect(state.nodes['dev_implement']?.status).toBe('failed');
    // 越界产物被作废（不再出现在状态里）
    expect(state.artifacts.find((a) => a.type === 'code_diff')).toBeUndefined();

    const events = kernel.getEvents(taskId);
    const invalidated = events.find((e) => e.type === 'artifact.invalidated');
    expect(invalidated).toBeDefined();
    expect(invalidated?.payload['node_id']).toBe('dev_implement');
    expect(invalidated?.payload['out_of_bounds_paths']).toEqual(['README.md']);

    const nodeFailed = events.find((e) => e.type === 'node.failed');
    expect(nodeFailed?.payload['reason_category']).toBe('permission_denied');
    expect(nodeFailed?.payload['reason_label']).toBe('权限被拒');
    expect(nodeFailed?.payload['out_of_bounds_paths']).toEqual(['README.md']);

    // 不静默继续：qa_verify 未被启动
    expect(runner.requests).toHaveLength(2);
    expect(state.nodes['qa_verify']).toBeUndefined();
    store.close();
  });

  it('未越界时不误报：变更全在 owns 内，正常完成且无违规记录', async () => {
    const repo = makeGitRepo();
    const logs = makeLogDir();
    const runner = createFakeRunner({
      scripts: [scriptFor('requirement'), scriptFor('code_diff'), scriptFor('test_report')],
      onRun: (req) => {
        if (req.artifactType === 'code_diff') {
          mkdirSync(join(req.workdir, 'src'), { recursive: true });
          writeFileSync(join(req.workdir, 'src', 'a.ts'), 'export const a = 1;\n');
        }
        if (req.artifactType === 'test_report') {
          mkdirSync(join(req.workdir, 'tests'), { recursive: true });
          writeFileSync(join(req.workdir, 'tests', 'a.test.ts'), '// 测试\n');
        }
      },
    });
    const { kernel, store } = makeKernelInRepo(repo, logs, runner);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('completed');
    expect(state.nodes['dev_implement']?.status).toBe('succeeded');
    expect(state.nodes['qa_verify']?.status).toBe('succeeded');
    expect(kernel.getEvents(taskId).some((e) => e.type === 'artifact.invalidated')).toBe(false);
    store.close();
  });

  it('只读角色（owns 为空）写入任何路径都算越界', async () => {
    const repo = makeGitRepo();
    const logs = makeLogDir();
    const runner = createFakeRunner({
      scripts: [scriptFor('requirement')],
      // pm 是只读角色（owns: []），却写了文件
      onRun: (req) => {
        if (req.artifactType === 'requirement') {
          writeFileSync(join(req.workdir, 'pm-note.md'), '不该写\n');
        }
      },
    });
    const { kernel, store } = makeKernelInRepo(repo, logs, runner);

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('failed');
    const failed = kernel.getEvents(taskId).find((e) => e.type === 'node.failed');
    expect(failed?.payload['reason_category']).toBe('permission_denied');
    expect(failed?.payload['out_of_bounds_paths']).toEqual(['pm-note.md']);
    store.close();
  });

  it('平台运行时目录位于仓库内时：只读角色不因平台自身日志/库被判越界（回归）', async () => {
    const realRepo = makeGitRepo();
    // 复刻真实冒烟形态：repoPath 经符号链接（process.cwd() 在 macOS 上会返回真实路径），
    // 而配置里的 logDir/dbPath 用真实路径——两侧不归一到同一基准就推导不出排除前缀。
    const linkRepo = `${realRepo}-link`;
    symlinkSync(realRepo, linkRepo);
    // 默认配置形态：日志 / 事件库 / 工作区根都落在目标仓库（repoPath）之内。
    // 缺陷即发生在此形态下——平台自己写的 logs/runs/*.jsonl 被采集为 pm（owns: []）的「节点变更」。
    const logDir = join(realRepo, 'logs');
    const workspaceRoot = join(realRepo, 'workspaces');
    const dbPath = join(realRepo, 'data', 'agentflow.sqlite');
    const store = createEventStore(dbPath);
    const runner = createFakeRunner({
      scripts: [scriptFor('requirement'), scriptFor('code_diff'), scriptFor('test_report')],
      // 模拟平台 runner 写运行日志（真实 runner 的 createWriteStream(logDir/runs/<run>.jsonl)）
      onRun: (req) => {
        mkdirSync(join(logDir, 'runs'), { recursive: true });
        writeFileSync(join(logDir, 'runs', `${req.runId}.jsonl`), '{}\n');
      },
    });
    const kernel = createKernel({
      store,
      runner,
      workflow,
      roles: roles(),
      maxPromptTokens: 30_000,
      workspaceRoot,
      logDir,
      repoPath: linkRepo,
      dbPath,
      maxSteps: 20,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    // 前置：平台确实写了运行日志（否则本用例没有落到缺陷场景）
    expect(existsSync(join(logDir, 'runs'))).toBe(true);
    expect(state.status).toBe('completed');
    expect(state.nodes['pm_analyze']?.status).toBe('succeeded');
    expect(kernel.getEvents(taskId).some((e) => e.type === 'artifact.invalidated')).toBe(false);
    // 事件载荷里也不应把平台运行时文件当作节点改动
    const succeeded = kernel.getEvents(taskId).find((e) => e.type === 'node.succeeded');
    expect(succeeded?.payload['changed_paths']).toEqual([]);
    store.close();
    rmSync(linkRepo, { force: true });
  });

  it('平台运行时目录位于仓库内时：真实越界（写 README.md）仍被检出', async () => {
    const repo = makeGitRepo();
    const logDir = join(repo, 'logs');
    const store = createEventStore(':memory:');
    const runner = createFakeRunner({
      scripts: [scriptFor('requirement'), scriptFor('code_diff'), scriptFor('test_report')],
      onRun: (req) => {
        // 平台自身日志（应被排除）
        mkdirSync(join(logDir, 'runs'), { recursive: true });
        writeFileSync(join(logDir, 'runs', `${req.runId}.jsonl`), '{}\n');
        // 节点真实越界（不得被排除）
        if (req.artifactType === 'code_diff') {
          writeFileSync(join(req.workdir, 'README.md'), '# 越界写入\n');
        }
      },
    });
    const kernel = createKernel({
      store,
      runner,
      workflow,
      roles: roles(),
      maxPromptTokens: 30_000,
      workspaceRoot: join(repo, '.agentflow-ws'),
      logDir,
      repoPath: repo,
      maxSteps: 20,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('failed');
    const invalidated = kernel.getEvents(taskId).find((e) => e.type === 'artifact.invalidated');
    expect(invalidated?.payload['out_of_bounds_paths']).toEqual(['README.md']);
    store.close();
  });
});

describe('fan-out / join / 并发上限（Task 9 + Task 10）', () => {
  /** 可观测时序的 runner：记录峰值并发与各角色进出时序，并支持挂起指定角色的执行 */
  type TimedRunner = AgentRunner & {
    peak: () => number;
    timeline: { role: string; phase: 'start' | 'end' }[];
  };

  function createTimedRunner(options: {
    /** 返回 promise 时该次 run 挂起，直到 promise resolve（模拟"上游仍在运行"） */
    hold?: (req: RunRequest) => Promise<void> | undefined;
    delayMs?: number;
  }): TimedRunner {
    let active = 0;
    let peak = 0;
    const timeline: { role: string; phase: 'start' | 'end' }[] = [];
    // 角色标识取自 systemPrompt（roles 约定为 `你是 <id>`）
    const roleOf = (req: RunRequest): string => /你是\s*(\S+)/.exec(req.systemPrompt)?.[1] ?? 'unknown';
    return {
      id: 'timed',
      capabilities: { structuredOutput: true, budgetCap: true, sessionResume: false, builtinReview: false },
      peak: () => peak,
      timeline,
      async *run(req: RunRequest): AsyncIterable<RunnerEvent> {
        const role = roleOf(req);
        active += 1;
        peak = Math.max(peak, active);
        timeline.push({ role, phase: 'start' });
        try {
          yield { kind: 'started', pid: 111, sessionId: `timed-${req.runId}` };
          const held = options.hold?.(req);
          if (held) await held;
          else if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
          yield { kind: 'artifact', raw: ARTIFACTS[req.artifactType] };
          yield { kind: 'usage', tokensIn: 10, tokensOut: 5, costUsd: 0.001 };
          yield { kind: 'exited', code: 0 };
        } finally {
          active -= 1;
          timeline.push({ role, phase: 'end' });
        }
      },
      async cancel(): Promise<void> {},
    };
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** 扇出工作流：pm_analyze 同时激活全部 dev 节点，dev 节点在 qa_verify 汇聚（join） */
  function fanOutWorkflow(devNodeIds: string[]): WorkflowDef {
    return {
      id: 'fan_out_demo',
      start: 'pm_analyze',
      nodes: [
        { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
        ...devNodeIds.map((id) => ({
          id,
          title: id,
          role: id,
          consumes: ['requirement'],
          produces: 'code_diff',
          isolate: false,
        })),
        { id: 'qa_verify', title: '汇总验证', role: 'qa_engineer', consumes: ['code_diff'], produces: 'test_report', isolate: false },
      ],
      edges: [
        ...devNodeIds.map((id) => ({
          from: 'pm_analyze',
          to: id,
          when: "all(artifacts.requirement.status == 'ok')",
          description: `需求已澄清 → ${id}`,
          onMissing: 'fail' as const,
        })),
        ...devNodeIds.map((id) => ({
          from: id,
          to: 'qa_verify',
          description: `${id} 完成 → 汇总`,
          onMissing: 'fail' as const,
        })),
      ],
    };
  }

  function fanOutRoles(devNodeIds: string[], ownsFor?: (id: string) => string[]): Map<string, RoleDef> {
    const make = (id: string, outputs: string[], owns: string[]): RoleDef => ({
      id,
      displayName: id,
      systemPrompt: `你是 ${id}`,
      inputs: [],
      outputs,
      owns,
      reads: [],
      responsibilities: [`${id} 的职责`],
      prohibitions: [`${id} 的禁止事项`],
      doneCriteria: [`${id} 的完成判据`],
      model: 'sonnet',
      maxRetries: 1,
      maxWallTimeMs: 60_000,
    });
    const map = new Map<string, RoleDef>([
      ['pm', make('pm', ['requirement'], [])],
      ['qa_engineer', make('qa_engineer', ['test_report'], ['tests/**'])],
    ]);
    for (const id of devNodeIds) {
      map.set(id, make(id, ['code_diff'], ownsFor ? ownsFor(id) : [`src/${id}/**`]));
    }
    return map;
  }

  function makeFanOutKernel(opts: {
    devNodeIds: string[];
    runner: AgentRunner;
    repoPath: string;
    logDir: string;
    globalConcurrency?: number;
    batchConflictPolicy?: 'serialize' | 'reject';
    ownsFor?: (id: string) => string[];
  }) {
    const store = createEventStore(':memory:');
    const kernel = createKernel({
      store,
      runner: opts.runner,
      workflow: fanOutWorkflow(opts.devNodeIds),
      roles: fanOutRoles(opts.devNodeIds, opts.ownsFor),
      maxPromptTokens: 30_000,
      workspaceRoot: join(opts.repoPath, '.agentflow-ws'),
      logDir: opts.logDir,
      repoPath: opts.repoPath,
      maxSteps: 40,
      globalConcurrency: opts.globalConcurrency,
      batchConflictPolicy: opts.batchConflictPolicy,
    });
    return { kernel, store };
  }

  it('fan-out：pm 完成后 dev_a 与 dev_b 被同一批次同时激活并真并发执行', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const runner = createTimedRunner({ delayMs: 15 });
    const { kernel, store } = makeFanOutKernel({
      devNodeIds: ['dev_a', 'dev_b'],
      runner,
      repoPath: repo,
      logDir: logs,
      globalConcurrency: 2,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('completed');
    // 两个 dev 节点都被启动，且峰值并发达到 2（并行是真发生的，而非串行假象）
    expect(runner.timeline.filter((t) => t.phase === 'start').map((t) => t.role)).toEqual(
      expect.arrayContaining(['dev_a', 'dev_b']),
    );
    expect(runner.peak()).toBe(2);
    // 转移记录：两个节点都由 pm_analyze 扇出（from 取自激活所用的边，不会相互串味）
    const transfers = kernel.getState(taskId).transfers.map((t) => `${t.from}→${t.to}`);
    expect(transfers).toContain('pm_analyze→dev_a');
    expect(transfers).toContain('pm_analyze→dev_b');
    expect(state.completedNodeIds).toEqual(
      expect.arrayContaining(['pm_analyze', 'dev_a', 'dev_b', 'qa_verify']),
    );
    store.close();
  });

  it('join：上游未全部进入终态时不启动；全部终态后启动（两个方向都有断言）', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const release = deferred();
    const runner = createTimedRunner({
      hold: (req) => (req.systemPrompt.includes('dev_b') ? release.promise : undefined),
    });
    const { kernel, store } = makeFanOutKernel({
      devNodeIds: ['dev_a', 'dev_b'],
      runner,
      repoPath: repo,
      logDir: logs,
      globalConcurrency: 2,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const running = kernel.runTask(taskId);

    // 方向一：dev_a 已成功、dev_b 仍在运行 → join 节点 qa_verify 不得启动
    await waitFor(() => {
      const s = project(kernel.getEvents(taskId));
      return s.nodes['dev_a']?.status === 'succeeded' && s.nodes['dev_b']?.status === 'running';
    }, 'dev_a 成功且 dev_b 运行中');
    const midway = project(kernel.getEvents(taskId));
    expect(midway.currentNodeIds).toEqual(['dev_b']);
    expect(midway.nodes['qa_verify']).toBeUndefined();
    expect(
      kernel
        .getEvents(taskId)
        .some((e) => e.type === 'node.started' && e.payload['node_id'] === 'qa_verify'),
    ).toBe(false);

    // 方向二：放行 dev_b，全部上游进入终态后 qa_verify 启动并完成
    release.resolve();
    const state = await running;
    expect(state.status).toBe('completed');
    expect(state.nodes['qa_verify']?.status).toBe('succeeded');
    store.close();
  });

  it('并发上限被遵守：3 个就绪节点在上限 2 下峰值并发为 2，超限节点排队等待', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const runner = createTimedRunner({ delayMs: 15 });
    const devNodeIds = ['dev_a', 'dev_b', 'dev_c'];
    const { kernel, store } = makeFanOutKernel({
      devNodeIds,
      runner,
      repoPath: repo,
      logDir: logs,
      globalConcurrency: 2,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('completed');
    // 三个 dev 节点都执行了（超限者排队，未被丢弃）
    expect(runner.timeline.filter((t) => t.phase === 'start').map((t) => t.role)).toEqual(
      expect.arrayContaining(devNodeIds),
    );
    // 上限被遵守：峰值并发恰好等于 2
    expect(runner.peak()).toBe(2);

    // 排队证据：dev_c 的启动发生在某个 dev 节点结束之后
    const firstDevEnd = runner.timeline.findIndex(
      (t) => t.phase === 'end' && devNodeIds.includes(t.role),
    );
    const devCStart = runner.timeline.findIndex((t) => t.phase === 'start' && t.role === 'dev_c');
    expect(firstDevEnd).toBeGreaterThanOrEqual(0);
    expect(devCStart).toBeGreaterThan(firstDevEnd);
    store.close();
  });

  it('占用检查仍是并行的前置闸：owns 重叠时该批次改为串行（峰值并发为 1）', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const runner = createTimedRunner({ delayMs: 15 });
    const { kernel, store } = makeFanOutKernel({
      devNodeIds: ['dev_a', 'dev_b'],
      runner,
      repoPath: repo,
      logDir: logs,
      globalConcurrency: 2,
      // 两个节点都声明可写 src/**：占用检查必须判定重叠并阻止并行
      ownsFor: () => ['src/**'],
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('completed');
    expect(runner.peak()).toBe(1);
    store.close();
  });

  it('占用检查：reject 策略下重叠批次在这些节点启动之前被拒绝', async () => {
    const repo = makeRepo();
    const logs = makeLogDir();
    const runner = createTimedRunner({});
    const { kernel, store } = makeFanOutKernel({
      devNodeIds: ['dev_a', 'dev_b'],
      runner,
      repoPath: repo,
      logDir: logs,
      globalConcurrency: 2,
      batchConflictPolicy: 'reject',
      ownsFor: () => ['src/**'],
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('failed');
    // 被拒绝的批次里两个 dev 节点一个都没启动，只有 pm 跑过
    const started = kernel.getEvents(taskId).filter((e) => e.type === 'node.started');
    expect(started.map((e) => e.payload['node_id'])).toEqual(['pm_analyze']);
    const failed = kernel.getEvents(taskId).find((e) => e.type === 'task.failed');
    expect(failed?.payload['owns_overlaps']).toBeDefined();
    store.close();
  });
});

describe('worktree 隔离与确定性合并（Task 11）', () => {
  /** 真实临时 git 仓库（含一次提交）：worktree 与合并必须走真实 git / 文件系统 */
  function makeIsolatedRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agentflow-git-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    mkdirSync(join(dir, 'src', 'shared'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# 基座\n');
    writeFileSync(join(dir, 'src', 'shared', 'seed.txt'), 'committed\n');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init'],
      { cwd: dir, stdio: 'pipe' },
    );
    return dir;
  }

  function isolatedRoles(): Map<string, RoleDef> {
    const make = (id: string, inputs: string[], outputs: string[], owns: string[]): RoleDef => ({
      id,
      displayName: id,
      systemPrompt: `你是 ${id}`,
      inputs,
      outputs,
      owns,
      reads: [],
      responsibilities: [`${id} 的职责`],
      prohibitions: [`${id} 的禁止事项`],
      doneCriteria: [`${id} 的完成判据`],
      model: 'sonnet',
      maxRetries: 1,
      maxWallTimeMs: 60_000,
    });
    return new Map([
      ['pm', make('pm', [], ['requirement'], [])],
      ['dev_a', make('dev_a', ['requirement'], ['code_diff'], ['src/dev_a/**'])],
      ['dev_b', make('dev_b', ['requirement'], ['code_diff'], ['src/dev_b/**'])],
      ['qa_engineer', make('qa_engineer', ['code_diff'], ['test_report'], ['tests/**'])],
    ]);
  }

  /** 钻石拓扑：pm 扇出 dev_a/dev_b（owns 互不相交），二者都汇入 qa_verify */
  function isolatedWorkflow(isolate: boolean): WorkflowDef {
    return {
      id: 'isolated_demo',
      start: 'pm_analyze',
      nodes: [
        { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
        { id: 'dev_a', title: 'dev_a', role: 'dev_a', consumes: ['requirement'], produces: 'code_diff', isolate },
        { id: 'dev_b', title: 'dev_b', role: 'dev_b', consumes: ['requirement'], produces: 'code_diff', isolate },
        { id: 'qa_verify', title: '汇总验证', role: 'qa_engineer', consumes: ['code_diff'], produces: 'test_report', isolate: false },
      ],
      edges: [
        { from: 'pm_analyze', to: 'dev_a', when: "all(artifacts.requirement.status == 'ok')", description: '需求已澄清 → dev_a', onMissing: 'fail' },
        { from: 'pm_analyze', to: 'dev_b', when: "all(artifacts.requirement.status == 'ok')", description: '需求已澄清 → dev_b', onMissing: 'fail' },
        { from: 'dev_a', to: 'qa_verify', description: 'dev_a 完成 → 汇总', onMissing: 'fail' },
        { from: 'dev_b', to: 'qa_verify', description: 'dev_b 完成 → 汇总', onMissing: 'fail' },
      ],
    };
  }

  const roleOf = (req: RunRequest): string => /你是\s*(\S+)/.exec(req.systemPrompt)?.[1] ?? 'unknown';

  type Behavior = { files?: Record<string, string>; exitCode?: number; onRun?: (req: RunRequest) => void };

  /** 按角色脚本化的 runner：可在节点工作区里写文件、可指定退出码，供断言隔离/合并 */
  function createScriptedRunner(
    behaviorFor: (req: RunRequest) => Behavior,
  ): AgentRunner & { requests: RunRequest[] } {
    const requests: RunRequest[] = [];
    return {
      id: 'scripted',
      capabilities: { structuredOutput: true, budgetCap: true, sessionResume: false, builtinReview: false },
      requests,
      async *run(req: RunRequest): AsyncIterable<RunnerEvent> {
        requests.push(req);
        const behavior = behaviorFor(req);
        yield { kind: 'started', pid: 1, sessionId: `scripted-${req.runId}` };
        behavior.onRun?.(req);
        if (behavior.files) {
          for (const [rel, content] of Object.entries(behavior.files)) {
            const target = join(req.workdir, rel);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, content);
          }
        }
        yield { kind: 'artifact', raw: ARTIFACTS[req.artifactType] };
        yield { kind: 'usage', tokensIn: 1, tokensOut: 1, costUsd: 0.001 };
        yield { kind: 'exited', code: behavior.exitCode ?? 0 };
      },
      async cancel(): Promise<void> {},
    };
  }

  function makeIsolatedKernel(opts: {
    workflow: WorkflowDef;
    roles: Map<string, RoleDef>;
    runner: AgentRunner;
    repoPath: string;
    workspaceRoot: string;
    logDir: string;
    globalConcurrency?: number;
  }) {
    const store = createEventStore(':memory:');
    const kernel = createKernel({
      store,
      runner: opts.runner,
      workflow: opts.workflow,
      roles: opts.roles,
      maxPromptTokens: 30_000,
      workspaceRoot: opts.workspaceRoot,
      logDir: opts.logDir,
      repoPath: opts.repoPath,
      maxSteps: 40,
      globalConcurrency: opts.globalConcurrency,
    });
    return { kernel, store };
  }

  it('并行节点在各自 worktree 中运行，批次结束后确定性合并回主工作区且 worktree 被回收', async () => {
    const repo = makeIsolatedRepo();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agentflow-ws-'));
    const logs = makeLogDir();
    const runner = createScriptedRunner((req): Behavior => {
      const role = roleOf(req);
      if (role === 'dev_a') return { files: { 'src/dev_a/a.ts': '// a\n' } };
      if (role === 'dev_b') return { files: { 'src/dev_b/b.ts': '// b\n' } };
      if (role === 'qa_engineer') return { files: { 'tests/qa.test.ts': '// qa\n' } };
      return {};
    });
    const { kernel, store } = makeIsolatedKernel({
      workflow: isolatedWorkflow(true),
      roles: isolatedRoles(),
      runner,
      repoPath: repo,
      workspaceRoot,
      logDir: logs,
      globalConcurrency: 2,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('completed');
    // 合并：主工作区确实包含各节点改动
    expect(readFileSync(join(repo, 'src/dev_a/a.ts'), 'utf8')).toBe('// a\n');
    expect(readFileSync(join(repo, 'src/dev_b/b.ts'), 'utf8')).toBe('// b\n');

    // 可追溯：节点事件记录「改动路径清单 + 工作区标识」
    const succeeded = kernel.getEvents(taskId).filter((e) => e.type === 'node.succeeded');
    const devA = succeeded.find((e) => e.payload['node_id'] === 'dev_a')!;
    expect(devA.payload['changed_paths']).toEqual(['src/dev_a/a.ts']);
    expect(devA.payload['isolated']).toBe(true);
    expect(devA.payload['worktree_created']).toBe(true);
    expect(String(devA.payload['worktree_path'])).toContain(workspaceRoot);
    expect(String(devA.payload['worktree_path'])).not.toBe(repo);
    const devB = succeeded.find((e) => e.payload['node_id'] === 'dev_b')!;
    expect(devB.payload['changed_paths']).toEqual(['src/dev_b/b.ts']);
    // 两个节点跑在**各自独立**的 worktree 里
    expect(String(devB.payload['worktree_path'])).not.toBe(String(devA.payload['worktree_path']));

    // 合并结论落库（wp.merged 之前全仓无生产者）
    const merged = kernel.getEvents(taskId).filter((e) => e.type === 'wp.merged');
    expect(merged.find((e) => e.payload['node_id'] === 'dev_a')?.payload['merged_paths']).toEqual([
      'src/dev_a/a.ts',
    ]);
    expect(merged.find((e) => e.payload['node_id'] === 'dev_a')?.payload['skipped_paths']).toEqual([]);

    // worktree 回收：仓库里只剩主工作树；workspaceRoot 下无残留目录；临时分支也已删除
    const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
    expect(worktrees.trim().split('\n')).toHaveLength(1);
    expect(readdirSync(workspaceRoot)).toEqual([]);
    const branches = execFileSync('git', ['branch', '--list', 'agentflow/*'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(branches.trim()).toBe('');
    store.close();
  });

  it('isolate:false 的并行节点仍被自动隔离；worktree 能看到主工作区最新的未提交改动', async () => {
    const repo = makeIsolatedRepo();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agentflow-ws-'));
    const logs = makeLogDir();
    // 主工作区存在未提交改动，模拟"上一批次合并回来的上游产物"
    writeFileSync(join(repo, 'src/shared/seed.txt'), 'dirty-from-upstream\n');
    let seenInWorktree: string | null = null;
    const runner = createScriptedRunner((req): Behavior => {
      const role = roleOf(req);
      if (role === 'dev_a') {
        return {
          onRun: (r) => {
            seenInWorktree = readFileSync(join(r.workdir, 'src/shared/seed.txt'), 'utf8');
          },
          files: { 'src/dev_a/a.ts': '// a\n' },
        };
      }
      if (role === 'dev_b') return { files: { 'src/dev_b/b.ts': '// b\n' } };
      if (role === 'qa_engineer') return { files: { 'tests/qa.test.ts': '// qa\n' } };
      return {};
    });
    const { kernel, store } = makeIsolatedKernel({
      workflow: isolatedWorkflow(false),
      roles: isolatedRoles(),
      runner,
      repoPath: repo,
      workspaceRoot,
      logDir: logs,
      globalConcurrency: 2,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('completed');
    // worktree 基于主工作区当前状态创建：节点看到未提交的上游改动
    expect(seenInWorktree).toBe('dirty-from-upstream\n');
    // 触发条件生效：配置里 isolate=false，但批次可能真并发 → 自动隔离
    const devA = kernel
      .getEvents(taskId)
      .find((e) => e.type === 'node.succeeded' && e.payload['node_id'] === 'dev_a')!;
    expect(devA.payload['isolated']).toBe(true);
    expect(devA.payload['worktree_created']).toBe(true);
    // 合并只落地 owns 内路径：非 owns 的 seed.txt 保持主工作区版本
    expect(readFileSync(join(repo, 'src/dev_a/a.ts'), 'utf8')).toBe('// a\n');
    expect(readFileSync(join(repo, 'src/shared/seed.txt'), 'utf8')).toBe('dirty-from-upstream\n');
    expect(readdirSync(workspaceRoot)).toEqual([]);
    store.close();
  });

  it('失败节点的改动不被合并（成功节点的改动仍合并），worktree 仍被回收', async () => {
    const repo = makeIsolatedRepo();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agentflow-ws-'));
    const logs = makeLogDir();
    const runner = createScriptedRunner((req): Behavior => {
      const role = roleOf(req);
      if (role === 'dev_a') return { files: { 'src/dev_a/a.ts': '// a\n' } };
      if (role === 'dev_b') return { files: { 'src/dev_b/b.ts': '// b\n' }, exitCode: 1 };
      return {};
    });
    const { kernel, store } = makeIsolatedKernel({
      workflow: isolatedWorkflow(true),
      roles: isolatedRoles(),
      runner,
      repoPath: repo,
      workspaceRoot,
      logDir: logs,
      globalConcurrency: 2,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('failed');
    expect(state.nodes['dev_b']?.status).toBe('failed');
    // 成功节点合并、失败节点不合并
    expect(existsSync(join(repo, 'src/dev_a/a.ts'))).toBe(true);
    expect(existsSync(join(repo, 'src/dev_b/b.ts'))).toBe(false);

    const devBFailed = kernel
      .getEvents(taskId)
      .find((e) => e.type === 'node.failed' && e.payload['node_id'] === 'dev_b')!;
    expect(devBFailed.payload['changed_paths']).toEqual(['src/dev_b/b.ts']);
    expect(devBFailed.payload['isolated']).toBe(true);
    const devBMerged = kernel
      .getEvents(taskId)
      .find((e) => e.type === 'wp.merged' && e.payload['node_id'] === 'dev_b')!;
    expect(devBMerged.payload['merged_paths']).toEqual([]);
    expect(String(devBMerged.payload['reason'])).toContain('失败');

    expect(readdirSync(workspaceRoot)).toEqual([]);
    store.close();
  });

  it('串行单节点批次不隔离（isolated=false，worktree_path 即主工作区），且无合并事件', async () => {
    const repo = makeIsolatedRepo();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agentflow-ws-'));
    const logs = makeLogDir();
    const runner = createScriptedRunner((req): Behavior => {
      const role = roleOf(req);
      if (role === 'backend_dev') return { files: { 'src/a.ts': '// dev\n' } };
      if (role === 'qa_engineer') return { files: { 'tests/a.test.ts': '// qa\n' } };
      return {};
    });
    const { kernel, store } = makeIsolatedKernel({
      workflow,
      roles: roles(),
      runner,
      repoPath: repo,
      workspaceRoot,
      logDir: logs,
      // 即便全局并发上限为 4，单节点批次也不会并发 → 不应隔离（串行等价性）
      globalConcurrency: 4,
    });

    const taskId = kernel.startTask({ title: 't', requirementRaw: 'r', baseBranch: 'main' });
    const state = await kernel.runTask(taskId);

    expect(state.status).toBe('completed');
    expect(state.completedNodeIds).toEqual(['pm_analyze', 'dev_implement', 'qa_verify']);
    const succeeded = kernel.getEvents(taskId).filter((e) => e.type === 'node.succeeded');
    expect(succeeded).toHaveLength(3);
    for (const event of succeeded) {
      expect(event.payload['isolated']).toBe(false);
      expect(event.payload['worktree_path']).toBe(repo);
    }
    // 非隔离节点直接写主工作区，无需合并
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf8')).toBe('// dev\n');
    expect(kernel.getEvents(taskId).some((e) => e.type === 'wp.merged')).toBe(false);
    const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
    expect(worktrees.trim().split('\n')).toHaveLength(1);
    store.close();
  });
});