import type { ArtifactType } from '../shared/artifacts.js';

export type RunRequest = {
  runId: string;
  prompt: string;
  systemPrompt: string;
  workdir: string;
  model: string;
  outputSchema?: object;
  /** 期望产出的 Artifact 类型，runner 用它做载荷校验 */
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