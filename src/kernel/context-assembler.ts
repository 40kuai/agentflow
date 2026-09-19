import { jsonSchemaForArtifact, type Artifact, type ArtifactType } from '../shared/artifacts.js';
import type { RoleDef, WorkflowNodeDef } from '../shared/domain.js';
import type { TaskState } from './projector.js';

export type AssembledPrompt = {
  systemPrompt: string;
  prompt: string;
  usedArtifactIds: string[];
  droppedArtifactIds: string[];
  estimatedTokens: number;
};

export type AssembleInput = {
  role: RoleDef;
  node: WorkflowNodeDef;
  state: TaskState;
  worktreePath: string;
  maxPromptTokens: number;
};

/**
 * 粗略的 token 估算：按 4 字符 ≈ 1 token。
 * 目的不是精确计数，而是在装配阶段防止 prompt 失控膨胀。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function renderArtifactBlock(artifact: Artifact): string {
  const lines = [
    `### 输入产物：${artifact.type}（id=${artifact.artifact_id}，status=${artifact.status}）`,
    `摘要：${artifact.summary}`,
  ];
  if (artifact.refs.length > 0) {
    lines.push('引用：');
    for (const ref of artifact.refs) {
      lines.push(`- [${ref.kind}] ${ref.uri}`);
    }
  }
  return lines.join('\n');
}

function buildPrompt(
  input: AssembleInput,
  artifacts: Artifact[],
  dropped: Artifact[],
): string {
  const { role, node, state } = input;

  const sections: string[] = [];

  sections.push(
    [
      '## 任务背景',
      `任务标题：${state.title}`,
      `原始需求：${state.requirementRaw}`,
      `当前节点：${node.id}（${node.title}）`,
      `你的角色：${role.displayName}（${role.id}）`,
    ].join('\n'),
  );

  sections.push(['## 工作区', `工作目录：${input.worktreePath}`, '所有文件读写都必须在上述目录内完成。'].join('\n'));

  if (artifacts.length > 0) {
    sections.push(['## 输入材料', ...artifacts.map((a) => renderArtifactBlock(a))].join('\n\n'));
  }

  if (dropped.length > 0) {
    const refs = dropped
      .flatMap((a) => a.refs.map((r) => `- [${r.kind}] ${r.uri}（${a.type}）`))
      .join('\n');
    sections.push(
      ['## 被省略的输入材料', '以下产物因上下文长度限制未包含摘要，需要时请自行读取引用文件：', refs].join('\n'),
    );
  }

  sections.push(
    [
      '## 你的产出要求',
      `必须产出类型为 \`${node.produces}\` 的结构化结果，并严格遵守其 JSON Schema：`,
      '```json',
      JSON.stringify(jsonSchemaForArtifact(node.produces as ArtifactType), null, 2),
      '```',
    ].join('\n'),
  );

  sections.push(
    [
      '## 硬约束',
      `1. 只允许修改以下路径：${role.owns.length > 0 ? role.owns.join('、') : '（无写入权限）'}`,
      `2. 可以读取以下路径：${role.reads.length > 0 ? role.reads.join('、') : '（仅当前工作区）'}`,
      '3. 不要修改工作区之外的文件。',
      '4. 完成后直接输出结构化结果，不要输出额外的解释性长文。',
    ].join('\n'),
  );

  sections.push(`## 可读取的输入产物类型\n${node.consumes.join('、') || '（无）'}`);

  return sections.join('\n\n');
}

/**
 * 装配 prompt。
 * 超限时按"从后往前"逐个整体丢弃产物摘要（保留 ref 引用），而不是截断任何内容。
 */
export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const consumedTypes = new Set(input.node.consumes);
  const candidates = input.state.artifacts.filter((a) => consumedTypes.has(a.type));

  let used = [...candidates];
  let dropped: Artifact[] = [];

  const render = (u: Artifact[], d: Artifact[]): string => buildPrompt(input, u, d);

  let prompt = render(used, dropped);
  let estimated = estimateTokens(input.role.systemPrompt) + estimateTokens(prompt);

  // 从数组末尾（最先产出、优先级最低）开始丢弃
  while (estimated > input.maxPromptTokens && used.length > 0) {
    const removed = used.pop()!;
    dropped = [removed, ...dropped];
    prompt = render(used, dropped);
    estimated = estimateTokens(input.role.systemPrompt) + estimateTokens(prompt);
  }

  return {
    systemPrompt: input.role.systemPrompt,
    prompt,
    usedArtifactIds: used.map((a) => a.artifact_id),
    droppedArtifactIds: dropped.map((a) => a.artifact_id),
    estimatedTokens: estimated,
  };
}