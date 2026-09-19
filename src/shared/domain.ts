export type TaskStatus = 'active' | 'completed' | 'failed';

export type NodeRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'waiting_gate';

/** 本阶段只用这三个角色 */
export type RoleId = 'pm' | 'backend_dev' | 'qa_engineer';

/** 角色定义（来自 config/roles/*.yaml，由 Task 11 加载） */
export type RoleDef = {
  id: string;
  displayName: string;
  systemPrompt: string;
  inputs: string[];
  outputs: string[];
  owns: string[];
  reads: string[];
  model: string;
  maxPromptTokens?: number;
  /** 单节点最大重试次数；超出后节点升级（node.escalated） */
  maxRetries: number;
  maxWallTimeMs: number;
};

/** 工作流定义（来自 config/workflows/*.yaml，由 Task 11 加载） */
export type WorkflowNodeDef = {
  id: string;
  title: string;
  role: string;
  consumes: string[];
  produces: string;
  /** 该节点是否需要在独立 git worktree 中执行 */
  isolate: boolean;
};

export type WorkflowEdgeDef = {
  from: string;
  to: string;
  /** 受限表达式；为空表示无条件转移 */
  when?: string;
};

export type WorkflowDef = {
  id: string;
  start: string;
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
};