import { describe, expect, it } from 'vitest';
import { assemblePrompt, estimateTokens } from './context-assembler.js';
import type { Artifact } from '../shared/artifacts.js';
import type { RoleDef, WorkflowNodeDef } from '../shared/domain.js';
import type { TaskState } from './projector.js';

const role: RoleDef = {
  id: 'backend_dev',
  displayName: '后端开发',
  systemPrompt: '你是一名后端开发工程师。',
  inputs: ['requirement'],
  outputs: ['code_diff'],
  owns: ['src/server/**'],
  reads: ['docs/**'],
  model: 'sonnet',
  maxRetries: 2,
  maxWallTimeMs: 1_800_000,
};

const node: WorkflowNodeDef = {
  id: 'dev_implement',
  title: '编码实现',
  role: 'backend_dev',
  consumes: ['requirement'],
  produces: 'code_diff',
  isolate: true,
};

function artifact(id: string, type: Artifact['type'], summary: string): Artifact {
  return {
    artifact_id: id,
    task_id: 'task_1',
    run_id: 'run_0',
    type,
    status: 'ok',
    schema_version: 1,
    payload: { note: 'payload 内容不应出现在 prompt 里' },
    refs: [{ kind: 'file', uri: `docs/${id}.md` }],
    summary,
    created_at: 1,
  };
}

function baseState(artifacts: Artifact[]): TaskState {
  return {
    taskId: 'task_1',
    title: '自动流转',
    requirementRaw: '让多角色自动流转',
    baseBranch: 'main',
    status: 'active',
    currentNodeIds: [],
    nodes: {},
    artifacts,
    transfers: [],
    visitCounts: {},
    budgetUsedUsd: 0,
    completedNodeIds: [],
  };
}

describe('estimateTokens', () => {
  it('按字符数估算，空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('assemblePrompt', () => {
  it('包含角色提示、任务标题、原始需求、产出要求与硬约束', () => {
    const r = assemblePrompt({
      role,
      node,
      state: baseState([artifact('a1', 'requirement', '需求已澄清')]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 30_000,
    });
    expect(r.systemPrompt).toBe('你是一名后端开发工程师。');
    expect(r.prompt).toContain('自动流转');
    expect(r.prompt).toContain('让多角色自动流转');
    expect(r.prompt).toContain('code_diff');
    expect(r.prompt).toContain('src/server/**');
    expect(r.prompt).toContain('/tmp/ws');
  });

  it('只放输入产物的 summary 与 refs，不放 payload 正文', () => {
    const r = assemblePrompt({
      role,
      node,
      state: baseState([artifact('a1', 'requirement', '需求已澄清')]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 30_000,
    });
    expect(r.prompt).toContain('需求已澄清');
    expect(r.prompt).toContain('docs/a1.md');
    expect(r.prompt).not.toContain('payload 内容不应出现在 prompt 里');
    expect(r.usedArtifactIds).toEqual(['a1']);
    expect(r.droppedArtifactIds).toEqual([]);
  });

  it('只取节点 consumes 声明的产物类型，其他类型不进 prompt', () => {
    const r = assemblePrompt({
      role,
      node,
      state: baseState([
        artifact('a1', 'requirement', '需求已澄清'),
        artifact('a2', 'test_report', '测试报告内容'),
      ]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 30_000,
    });
    expect(r.usedArtifactIds).toEqual(['a1']);
    expect(r.prompt).not.toContain('测试报告内容');
  });

  it('超出 token 上限时整体丢弃低优先级产物 summary，并记录 droppedArtifactIds', () => {
    // 每条大摘要 20_000 字符 ≈ 5000 token，上限 1500，base prompt ≈ 250 token。
    // 必须让"丢掉最后一条后仍然超限"，才能验证出多条被连续丢弃；
    // 若摘要只有 1000 token，丢掉一条就满足了，断言会与预期不符。
    const big = 'x'.repeat(20_000);
    const r = assemblePrompt({
      role,
      node,
      state: baseState([
        artifact('keep', 'requirement', '短摘要'),
        artifact('drop1', 'requirement', big),
        artifact('drop2', 'requirement', big),
      ]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 1500,
    });
    expect(r.estimatedTokens).toBeLessThanOrEqual(1500);
    expect(r.usedArtifactIds).toEqual(['keep']);
    expect(r.droppedArtifactIds.sort()).toEqual(['drop1', 'drop2']);
    // 丢弃的产物仍以 ref 形式保留可追溯性
    expect(r.prompt).toContain('docs/drop1.md');
  });

  it('即使单条摘要就超限，也不会截断内容，而是整体丢弃它', () => {
    const huge = 'y'.repeat(20_000);
    // 上限必须大于"不含任何产物摘要的 base prompt"本身（其中内嵌了 code_diff 的完整 JSON Schema，
    // 约 300~400 token）。设成 200 会导致断言不可能成立。
    // 20_000 字符 ≈ 5000 token，远大于 1500，因此必然被丢弃。
    const r = assemblePrompt({
      role,
      node,
      state: baseState([artifact('huge', 'requirement', huge)]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 1500,
    });
    expect(r.prompt).not.toContain('yyyy');
    expect(r.droppedArtifactIds).toEqual(['huge']);
    expect(r.estimatedTokens).toBeLessThanOrEqual(1500);
  });

  it('无输入产物时也能装配出合法 prompt', () => {
    const r = assemblePrompt({
      role,
      node,
      state: baseState([]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 30_000,
    });
    expect(r.prompt.length).toBeGreaterThan(0);
    expect(r.usedArtifactIds).toEqual([]);
  });

  it('硬约束里写明终止语义：调用一次 StructuredOutput 后立即结束本轮', () => {
    // 依据 2026-09-19 真实失败现场：CLI 的结构化输出 harness 要求那次调用是**终结动作**，
    // 模型在调用之间继续读写文件、重复提交，harness 反复重新注入约束，最终
    // error_max_structured_output_retries（5 次成功调用仍零产出）。
    const r = assemblePrompt({
      role,
      node,
      state: baseState([]),
      worktreePath: '/tmp/ws',
      maxPromptTokens: 30_000,
    });
    expect(r.prompt).toContain('StructuredOutput');
    expect(r.prompt).toContain('立即结束');
    expect(r.prompt).toContain('不要重复提交');
  });
});