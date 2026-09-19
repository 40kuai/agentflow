import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKernel } from './kernel.js';
import { project } from './projector.js';
import { createEventStore } from './event-store.js';
import { createFakeRunner, type FakeScriptItem } from '../runner/fake-runner.js';
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