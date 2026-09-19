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

/**
 * 角色定义（来自 config/roles/*.yaml，由 Task 11 加载）。
 *
 * 契约唯一来源：`inputs`/`outputs` 是角色与工作流共享的输入输出契约的**权威**声明；
 * 工作流节点的 `consumes`/`produces` 由它们派生，并在加载期做一致性校验（见 config/loader.ts）。
 *
 * 路径语义：`owns` = 允许写入的路径（写边界，空数组代表只读角色）；`reads` = 允许读取的路径。
 * Phase 1 两者仅作为 prompt 中的硬约束提示，路径级强制属后续任务。
 */
export type RoleDef = {
  id: string;
  displayName: string;
  systemPrompt: string;
  inputs: string[];
  outputs: string[];
  owns: string[];
  reads: string[];
  /** 职责边界：本角色负责的事项清单（边界之内做什么）。配置文件 schema 中为必填 */
  responsibilities?: string[];
  /** 禁止事项：本角色明确不得做的事。配置文件 schema 中为必填 */
  prohibitions?: string[];
  /** 完成判据：满足哪些条件才算这个角色做完了。配置文件 schema 中为必填 */
  doneCriteria?: string[];
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
  /** 输入产物类型：由角色 `inputs` 派生（非权威声明，加载期校验一致性） */
  consumes: string[];
  /** 产出产物类型：由角色 `outputs` 派生（非权威声明，加载期校验一致性） */
  produces: string;
  /** 该节点是否需要在独立 git worktree 中执行 */
  isolate: boolean;
  /** 本节点在流程中的职责说明（人类可读，可选） */
  description?: string;
  /** 进入本节点的条件说明（人类可读，可选；起始节点为"任务开始即进入"） */
  entryCondition?: string;
};

export type WorkflowEdgeDef = {
  from: string;
  to: string;
  /** 受限表达式；为空表示无条件转移 */
  when?: string;
  /** 该边的人类可读说明：在什么情况下、为什么走它（配置文件 schema 中为必填） */
  description?: string;
  /**
   * 条件不满足时的失败语义：fail=判定任务失败；wait=保持等待（供 join 语义使用）。
   * 配置文件 schema 中为必填；类型上保持可选，以便程序化构造工作流（测试、后续 fan-out）时不必填展示性字段。
   */
  onMissing?: 'fail' | 'wait';
};

export type WorkflowDef = {
  id: string;
  start: string;
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
};