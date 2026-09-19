import type { ArtifactType } from '../shared/artifacts.js';
import type { FailureReason } from '../shared/events.js';

export type RunRequest = {
  runId: string;
  prompt: string;
  systemPrompt: string;
  workdir: string;
  model: string;
  outputSchema?: object;
  /** 期望产出的 Artifact 类型；runner 只做形状提取，载荷校验由内核侧完成（Phase 1 在 Task 12 的 hasArtifact 判据落地） */
  artifactType: ArtifactType;
  readOnly: boolean;
  budgetCapUsd?: number;
  wallTimeMs: number;
  sessionId?: string;
};

export type RunnerEvent =
  | { kind: 'started'; pid: number; sessionId?: string }
  | { kind: 'log'; chunk: string }
  | { kind: 'usage'; tokensIn: number; tokensOut: number; costUsd: number }
  | { kind: 'artifact'; raw: unknown }
  /**
   * 已分类的失败信号：runner 层负责把 CLI 的 subtype / 超时 / 权限迹象映射成稳定枚举，
   * 内核据此在失败事件里写分类（含中文说明），而**不必解析 CLI 原始文本**。
   * `detail` 保留原始文本作为附加信息。
   */
  | { kind: 'failure'; reason: FailureReason; detail: string }
  | { kind: 'exited'; code: number | null };

export type RunnerCapabilities = {
  structuredOutput: boolean;
  budgetCap: boolean;
  sessionResume: boolean;
  builtinReview: boolean;
};

export interface AgentRunner {
  readonly id: string;
  readonly capabilities: RunnerCapabilities;
  run(req: RunRequest): AsyncIterable<RunnerEvent>;
  cancel(runId: string): Promise<void>;
}