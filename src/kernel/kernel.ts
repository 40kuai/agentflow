import { dirname, join } from 'node:path';
import { jsonSchemaForArtifact, parseArtifactPayload, type ArtifactType, type ParsedArtifactPayload } from '../shared/artifacts.js';
import { newId } from '../shared/ids.js';
import { FAILURE_REASON_LABELS, type FailureReason, type KernelEvent } from '../shared/events.js';
import type { RoleDef, WorkflowDef } from '../shared/domain.js';
import type { AgentRunner, RunnerEvent } from '../runner/types.js';
import { assemblePrompt } from './context-assembler.js';
import type { EventStore } from './event-store.js';
import { buildFacts } from './facts.js';
import {
  checkBatchOwns,
  collectChangedPaths,
  findOwnViolations,
  isUnderPrefix,
  runtimeExcludePrefixes,
  type BatchConflictPolicy,
} from './path-guard.js';
import { mergeBatchChanges } from './merge.js';
import { project, type TaskState } from './projector.js';
import { prepareWorkspace, releaseWorkspace, type Workspace } from './scheduler.js';
import { decideNext, type EdgeEvaluation } from './state-machine.js';

export type KernelDeps = {
  store: EventStore;
  runner: AgentRunner;
  workflow: WorkflowDef;
  roles: Map<string, RoleDef>;
  maxPromptTokens: number;
  workspaceRoot: string;
  logDir: string;
  repoPath: string;
  /**
   * 事件库文件路径（由 `AGENTFLOW_DB_PATH` 注入）。仅用于推导「平台自身运行时目录」，
   * 使 `owns` 越界核对排除 **事件库所在目录**（默认 `./data/agentflow.sqlite` → 排除 `data/`，
   * 连同 `-wal`/`-shm` 旁路文件）。传 `':memory:'` 或无文件库时可不传。
   */
  dbPath?: string;
  maxSteps: number;
  /**
   * 并行批次内 `owns` 重叠时的处理策略：serialize=改为串行；reject=拒绝该批次。
   * 取自 `AGENTFLOW_BATCH_CONFLICT_POLICY`（默认 serialize）。属 Task 8 的「配置中可指定」。
   */
  batchConflictPolicy?: BatchConflictPolicy;
  /**
   * 全局并发上限：同一时刻最多同时推进的就绪节点数。
   * 取自 `AGENTFLOW_GLOBAL_CONCURRENCY`（由 `src/main.ts` 注入，默认 4）；未显式配置时缺省为 1，
   * 即"不配置就不并发"——保守缺省不改变既有的单节点串行行为（Task 10 首次消费该配置）。
   */
  globalConcurrency?: number;
  /**
   * 节点「停滞自动停止」阈值（ms）：透传给 runner，节点子进程连续该时长无任何输出即被强制终止
   * 并按失败落库（`reason_category='timeout'`，error 文案写明是停滞）。
   * 取自 `AGENTFLOW_NODE_STALL_TIMEOUT_MS`（默认 600000）；`0` / 未传 = 不启用，
   * 从而不改变既有「不配置就不自动停」的行为。
   */
  nodeStallTimeoutMs?: number;
};

export type StartTaskInput = {
  title: string;
  requirementRaw: string;
  baseBranch: string;
};

/**
 * 一次节点执行的收尾信息（Task 11）：批次结束后据此**合并改动**并**回收工作区**。
 * `succeeded` 为 false 时其改动不参与合并（失败产物不可信）。
 */
type NodeRunResult = {
  nodeId: string;
  runId: string;
  workspace: Workspace;
  owns: string[];
  changedPaths: string[];
  succeeded: boolean;
};

export type Kernel = {
  startTask(input: StartTaskInput): string;
  getState(taskId: string): TaskState;
  getEvents(taskId: string): KernelEvent[];
  runTask(taskId: string): Promise<TaskState>;
  /** 取消任务（幂等）：语义见 createKernel 内 cancel 的注释 */
  cancel(taskId: string): TaskState;
};

export function createKernel(deps: KernelDeps): Kernel {
  const { store, workflow, roles } = deps;

  // 平台自身运行时目录（日志 / 事件库 / 工作区根）的**仓库相对前缀**，一律由注入的配置路径推导
  // （logDir / workspaceRoot / dbPath 的目录），不硬编码 `logs`/`data`/`workspaces`。
  // 默认配置下这些目录就落在 repoPath 之内，若不过滤，`git status` 会把平台自己写的日志/库
  // 采集为「节点变更」，`owns` 核对便把只读角色判成越界——整个平台在默认配置下不可用。
  const dbDir =
    deps.dbPath !== undefined && deps.dbPath !== ':memory:' ? dirname(deps.dbPath) : undefined;
  const runtimePrefixes = runtimeExcludePrefixes(deps.repoPath, [
    deps.logDir,
    deps.workspaceRoot,
    dbDir,
  ]);

  function getState(taskId: string): TaskState {
    const events = store.readTask(taskId);
    if (events.length === 0) {
      throw new Error(`找不到任务：${taskId}`);
    }
    return project(events);
  }

  function getEvents(taskId: string): KernelEvent[] {
    return store.readTask(taskId);
  }

  function startTask(input: StartTaskInput): string {
    const taskId = newId('task');
    store.append({
      task_id: taskId,
      type: 'task.created',
      payload: {
        title: input.title,
        requirement_raw: input.requirementRaw,
        base_branch: input.baseBranch,
      },
      actor: 'human',
    });
    return taskId;
  }

  /**
   * 取消任务（幂等、可解释、状态不悬挂）。
   *
   * 语义：
   *  - 未知任务抛错（HTTP 层据此返回 404），绝不静默成功；
   *  - 已是终态（completed / failed / cancelled）时**不写入任何事件**，原样返回状态（幂等，
   *    重复点击取消不会制造垃圾事件）；
   *  - active 任务：逐个把 running / queued 节点写成 `node.cancelled`，再写 `task.cancelled`
   *    把任务落到明确的 cancelled 终态；
   *  - running 节点同时通知 runner 杀掉其进程组（`runner.cancel(runId)`，内部 SIGTERM → 3s → SIGKILL）。
   *    这一步是 fire-and-forget：不阻塞响应；内核状态只由事件决定，不依赖进程是否已死。
   *    不杀进程的"取消"会继续烧钱，等于没取消，故这里必须调。
   *  - 取消是**终态**：投影器对 cancelled 做粘滞处理，在途节点的迟到成功/失败不会翻转它；
   *    `runTask` 主循环遇到非 active 会丢弃待启动队列（见 runTask 内注释）。
   *
   * 已知边界（如实记录）：取消**不撤销**已发生的花费，也不清理已写入工作区的改动；
   * 在途节点自然收尾后仍会走既有的合并流程（与失败路径同）。
   */
  function cancel(taskId: string): TaskState {
    const events = store.readTask(taskId);
    if (events.length === 0) throw new Error(`找不到任务：${taskId}`);

    const state = project(events);
    if (state.status !== 'active') return state;

    for (const node of Object.values(state.nodes)) {
      if (node.status !== 'running' && node.status !== 'queued') continue;
      if (node.status === 'running' && node.runId !== null) {
        void deps.runner.cancel(node.runId).catch(() => {
          // 进程可能已经退出：取消失败不改变取消语义，状态仍由事件决定
        });
      }
      store.append({
        task_id: taskId,
        type: 'node.cancelled',
        payload: { node_id: node.nodeId, run_id: node.runId, reason: '任务被取消' },
        actor: 'human',
      });
    }

    store.append({
      task_id: taskId,
      type: 'task.cancelled',
      payload: { reason: '任务被用户取消' },
      actor: 'human',
    });
    return project(store.readTask(taskId));
  }

  async function runTask(taskId: string): Promise<TaskState> {
    let steps = 0;
    // Task 10：全局并发上限首次被消费。未显式配置时缺省为 1（串行），保证既有行为不变。
    const concurrencyLimit = Math.max(1, deps.globalConcurrency ?? 1);
    // 本批次待启动节点（保持决策给出的顺序）与本批次生效的并发上限。
    // 批次之间会重新赋值：`serialize` 策略把该批次上限降为 1（改为串行）。
    let queue: { nodeId: string; edge: EdgeEvaluation | null }[] = [];
    let batchLimit = concurrencyLimit;
    // 本批次是否**强制隔离**（Task 11.1 的触发条件）：批次数 ≥2 且本批次生效上限 ≥2 才可能真并发，
    // 并发节点必须各跑在自己的 worktree 里，否则会互相覆盖工作树。
    let batchAutoIsolate = false;
    // 在途节点：nodeId → 其 runNode 的「结束即自我移除」包装 promise
    const running = new Map<string, Promise<void>>();
    // 本批次已结束、待合并/回收的结果；批次全部干净后一次性处理（见 finishBatch）
    let batchResults: NodeRunResult[] = [];
    // 本任务全部在途工作区，供异常提前返回时兜底回收（避免残留 worktree）
    const liveWorkspaces = new Set<Workspace>();

    /** 启动一个就绪节点；其 runNode 结束后自动从在途集合移除（成功/失败都移除） */
    function launch(item: { nodeId: string; edge: EdgeEvaluation | null }): void {
      const autoIsolate = batchAutoIsolate;
      const tracked = runNode(taskId, item.nodeId, item.edge, autoIsolate, (ws) =>
        liveWorkspaces.add(ws),
      ).then(
        (result) => {
          if (result) batchResults.push(result);
          running.delete(item.nodeId);
        },
        () => {
          running.delete(item.nodeId);
        },
      );
      running.set(item.nodeId, tracked);
    }

    /**
     * 批次全部结束：按 `owns` 归属把各节点改动**确定性合并**回主工作区，随后回收全部工作区（Task 11.2）。
     *
     * 必须在求解下一批次**之前**完成：下一批的 worktree 是基于「合并后的主工作区」创建的，
     * 这样下游节点才看得到上游产物。
     */
    function finishBatch(): void {
      const results = batchResults;
      batchResults = [];

      const isolated = results.filter((r) => r.workspace.isolated);
      if (isolated.length > 0) {
        const outcomes = mergeBatchChanges({
          repoPath: deps.repoPath,
          nodes: isolated.map((r) => ({
            nodeId: r.nodeId,
            workspacePath: r.workspace.path,
            changedPaths: r.changedPaths,
            owns: r.owns,
            succeeded: r.succeeded,
          })),
        });
        // 合并结论落库：`wp.merged` 此前全仓无生产者，此处复用既有事件类型记录"改动来自哪个节点、是否已合并"。
        for (const outcome of outcomes) {
          store.append({
            task_id: taskId,
            type: 'wp.merged',
            payload: {
              node_id: outcome.nodeId,
              merged_paths: outcome.mergedPaths,
              skipped_paths: outcome.skippedPaths,
              reason: outcome.reason,
            },
            actor: 'kernel',
          });
        }
      }

      for (const result of results) {
        releaseWorkspace(result.workspace, deps.repoPath);
        liveWorkspaces.delete(result.workspace);
      }
    }

    try {
      for (;;) {
        if (steps >= deps.maxSteps) {
          store.append({
            task_id: taskId,
            type: 'task.failed',
            payload: {
              reason: `超过最大步数 ${deps.maxSteps}，判定为死循环`,
              reason_category: 'other',
              reason_label: FAILURE_REASON_LABELS.other,
            },
            actor: 'kernel',
          });
          return getState(taskId);
        }
        steps += 1;

        // 1) 就绪节点入队后按上限尽量多启动；超限的留在队列里排队，等有空位再启动。
        //    任务已离开 active（例如被 cancel）：**丢弃待启动队列**，不再启动新节点——取消的意义
        //    就是停止继续花钱。这里刻意不提前 return：在途节点仍需自然收尾（其工作区不能在被
        //    finally 回收时还在被写入），收尾后由下面的「非 active → return」统一结束。
        if (queue.length > 0 && getState(taskId).status !== 'active') {
          queue = [];
        }
        while (queue.length > 0 && running.size < batchLimit) {
          launch(queue.shift()!);
        }

        // 2) 有在途节点：等至少一个结束再重新评估。
        //    这正是 **join 语义**的实现——上游未全部进入终态前，主循环不会去求解下一批次，
        //    因此 join 节点不会在任一上游仍在运行时被启动。
        if (running.size > 0) {
          await Promise.race(running.values());
          continue;
        }

        // 本批次已全部结束：**先把改动合并回主工作区并回收工作区**，再求解下一批次。
        // 顺序很重要——下一批的 worktree 基于合并后的主工作区创建，下游才看得到上游产物（Task 11.2）。
        if (batchResults.length > 0) {
          finishBatch();
        }

        // 3) 无在途、无待启动：求解下一批次（`decideNext` 在无运行节点时才会给出 start/end）
        const state = getState(taskId);
        if (state.status !== 'active') {
          return state;
        }

        const facts = buildFacts({ state, workflow, roles });
        const decision = decideNext({ workflow, state, facts });

        if (decision.kind === 'wait') {
          return state;
        }
        if (decision.kind === 'end') {
          const payload: Record<string, unknown> = { reason: decision.reason };
          // 失败时把**分类化原因**（稳定枚举 + 中文说明）与结构化解释一并落库，
          // 界面无需解析 CLI 原始文本即可展示根因；`reason` 仍保留原有中文说明文本。
          if (decision.failure) {
            payload['reason_category'] = decision.failure.category;
            payload['reason_label'] = FAILURE_REASON_LABELS[decision.failure.category];
            payload['unmet_conditions'] = decision.failure.unmetConditions;
            payload['artifact_statuses'] = decision.failure.artifactStatuses;
          }
          store.append({
            task_id: taskId,
            type: decision.status === 'completed' ? 'task.completed' : 'task.failed',
            payload,
            actor: 'kernel',
          });
          return getState(taskId);
        }

        // Task 8：占用检查必须在**批次启动之前**执行（fan-out 后批次可含多个节点）。
        // 这道闸不可绕过：重叠时按配置改为串行（本批次上限降为 1）或拒绝该批次。
        const batchNodes = decision.nodeIds.map((id) => {
          const node = workflow.nodes.find((n) => n.id === id);
          const batchRole = node ? roles.get(node.role) : undefined;
          return { nodeId: id, owns: batchRole?.owns ?? [] };
        });
        const guard = checkBatchOwns(batchNodes, deps.batchConflictPolicy ?? 'serialize');
        if (guard.mode === 'reject') {
          // 拒绝该批次：在启动这些节点之前就把原因写清楚（哪两个节点、哪段路径重叠）
          store.append({
            task_id: taskId,
            type: 'task.failed',
            payload: {
              reason: guard.reason,
              reason_category: 'other' satisfies FailureReason,
              reason_label: FAILURE_REASON_LABELS.other,
              owns_overlaps: guard.overlaps,
            },
            actor: 'kernel',
          });
          return getState(taskId);
        }

        batchLimit = guard.mode === 'serialize' ? 1 : concurrencyLimit;
        // Task 11.1 隔离触发：节点显式 isolate=true，或本批次可能真并发（批次数 ≥2 且生效上限 ≥2）。
        batchAutoIsolate = batchLimit > 1 && decision.nodeIds.length > 1;
        queue = decision.nodeIds.map((id, i) => ({
          nodeId: id,
          edge: decision.selectedEdges[i] ?? null,
        }));
      }
    } finally {
      // 异常/提前返回时兜底回收仍在途的工作区，避免残留 worktree
      for (const ws of liveWorkspaces) {
        releaseWorkspace(ws, deps.repoPath);
      }
    }
  }

  async function runNode(
    taskId: string,
    nodeId: string,
    selectedEdge: EdgeEvaluation | null,
    autoIsolate: boolean,
    trackWorkspace: (ws: Workspace) => void,
  ): Promise<NodeRunResult | null> {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: {
          reason: `节点 ${nodeId} 不在工作流定义中`,
          reason_category: 'other' satisfies FailureReason,
          reason_label: FAILURE_REASON_LABELS.other,
        },
        actor: 'kernel',
      });
      return null;
    }

    const role = roles.get(node.role);
    if (!role) {
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: {
          reason: `节点 ${nodeId} 引用了未注册的角色 ${node.role}`,
          reason_category: 'other',
          reason_label: FAILURE_REASON_LABELS.other,
        },
        actor: 'kernel',
      });
      return null;
    }

    const stateBefore = getState(taskId);

    // 收窄后的角色可写范围（供嵌套函数 result 使用，避免闭包内再判空）
    const roleOwns = role.owns;

    // Task 11.1 隔离触发条件：节点显式 `isolate: true`，或本批次可能真并发（批次数 ≥2 且生效上限 ≥2）。
    // 只有"可能并发"时才必须隔离（并发节点共用一棵工作树会互相覆盖）；串行批次不隔离，
    // 从而保持既有串行行为（simple_dev 三节点直线、全 isolate:false）完全不变。
    const isolate = node.isolate || autoIsolate;
    let ws: Workspace;
    try {
      ws = prepareWorkspace({
        workspaceRoot: deps.workspaceRoot,
        repoPath: deps.repoPath,
        isolate,
        taskId,
        nodeId,
      });
    } catch (error) {
      // 工作区创建失败必须有明确失败路径（不静默继续）
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: {
          reason: `节点 ${nodeId} 的工作区创建失败：${(error as Error).message}`,
          reason_category: 'other' satisfies FailureReason,
          reason_label: FAILURE_REASON_LABELS.other,
        },
        actor: 'kernel',
      });
      return null;
    }
    // 登记在途工作区：runTask 的 finally 会在异常提前返回时兜底回收，避免残留 worktree
    trackWorkspace(ws);

    const previousVisit = stateBefore.visitCounts[nodeId] ?? 0;

    // 转移记录必须是可解释的：所用边、条件表达式原文、该表达式的人类可读说明（直接取自边配置的
    // description，不在引擎里另造）、以及判定依据（相关产物的实际状态）。
    // `from` 取自**本次激活所用的边**（而非"上一条转移的目标"）：并发批次内的多个节点由同一条
    // 上游节点扇出，若读上一条转移目标会相互串味（第二个节点会误记为第一个节点扇出）。
    // 单节点串行时两者恒等，故不改动既有转移序列。
    store.append({
      task_id: taskId,
      type: 'transfer.decided',
      payload: {
        from: selectedEdge?.from ?? '',
        to: nodeId,
        reason: selectedEdge?.reason ?? '任务开始，进入起始节点',
        decided_by: 'rule',
        edge: selectedEdge ? { from: selectedEdge.from, to: selectedEdge.to } : null,
        when: selectedEdge ? selectedEdge.when : null,
        edge_description: selectedEdge ? selectedEdge.description : null,
        artifact_statuses: stateBefore.artifacts.map((a) => ({ type: a.type, status: a.status })),
      },
      actor: 'kernel',
    });

    store.append({
      task_id: taskId,
      type: 'node.queued',
      payload: {
        node_id: nodeId,
        role_id: role.id,
        run_id: ws.runId,
        attempt: previousVisit + 1,
        // Task 11.3 可追溯：工作区标识（隔离时为 worktree 路径，否则即主工作区）
        worktree_path: ws.path,
        isolated: ws.isolated,
        worktree_created: ws.createdWorktree,
      },
      actor: 'kernel',
    });

    const assembled = assemblePrompt({
      role,
      node,
      state: stateBefore,
      worktreePath: ws.path,
      maxPromptTokens: deps.maxPromptTokens,
    });

    // log_ref 只由 deps.logDir 与 ws.runId 决定，不依赖 runner 的任何输出。
    // 因此必须在 node.started 落库前算出并写进载荷：否则运行中的节点没有日志引用，
    // 管理台在“最需要看日志”的时刻反而看不到日志（旧实现只在节点结束事件里写 log_ref）。
    const logRef = join(deps.logDir.replace(/^\.\//, ''), 'runs', `${ws.runId}.jsonl`);

    store.append({
      task_id: taskId,
      type: 'node.started',
      payload: {
        node_id: nodeId,
        role_id: role.id,
        run_id: ws.runId,
        attempt: previousVisit + 1,
        log_ref: logRef,
        worktree_path: ws.path,
        isolated: ws.isolated,
        worktree_created: ws.createdWorktree,
      },
      actor: `role:${role.id}`,
    });

    let artifactRaw: unknown;
    let hasArtifact = false;
    let exitCode: number | null = null;
    const errorLines: string[] = [];
    // runner 层已分类的失败信号（最后一条为准，即终止性失败）；detail 保留原始文本
    let failureReason: FailureReason | null = null;
    let failureDetail: string | null = null;

    const readOnly = role.owns.length === 0;

    // Task 7：节点启动前记录工作区的变更基线。非隔离节点共用主工作区，若只看节点结束后的
    // 全量快照，会把"启动前就存在的脏文件"算到本节点头上（误报）；用前后快照差即只算本节点新增的变更。
    const changesBefore = new Set(collectChangedPaths(ws.path));

    try {
      for await (const event of deps.runner.run({
        runId: ws.runId,
        prompt: assembled.prompt,
        systemPrompt: assembled.systemPrompt,
        workdir: ws.path,
        model: role.model,
        outputSchema: jsonSchemaForArtifact(node.produces as ArtifactType),
        artifactType: node.produces as ArtifactType,
        readOnly,
        wallTimeMs: role.maxWallTimeMs,
        // 停滞自动停止：节点子进程连续无输出达阈值即被 runner 强制终止（未配置/0 = 不启用）
        stallTimeoutMs: deps.nodeStallTimeoutMs,
      })) {
        handleEvent(event);
      }
    } catch (error) {
      errorLines.push(`runner 抛出异常：${(error as Error).message}`);
      exitCode = -1;
    }

    function handleEvent(event: RunnerEvent): void {
      switch (event.kind) {
        case 'usage':
          store.append({
            task_id: taskId,
            type: 'node.usage_recorded',
            payload: {
              node_id: nodeId,
              run_id: ws.runId,
              tokens_in: event.tokensIn,
              tokens_out: event.tokensOut,
              cost_usd: event.costUsd,
            },
            actor: 'kernel',
          });
          store.append({
            task_id: taskId,
            type: 'budget.consumed',
            payload: { run_id: ws.runId, cost_usd: event.costUsd },
            actor: 'kernel',
          });
          break;
        case 'artifact':
          artifactRaw = event.raw;
          hasArtifact = true;
          break;
        case 'log':
          if (errorLines.length < 20 && /错误|失败|error|failed/i.test(event.chunk)) {
            errorLines.push(event.chunk.slice(0, 500));
          }
          break;
        case 'failure':
          failureReason = event.reason;
          failureDetail = event.detail;
          break;
        case 'exited':
          exitCode = event.code;
          break;
        case 'started':
          break;
        default: {
          const exhaustive: never = event;
          throw new Error(`未处理的 RunnerEvent：${JSON.stringify(exhaustive)}`);
        }
      }
    }

    // Task 7：节点结束后、回收工作区之前采集实际变更路径（worktree 一旦回收就再也读不到）。
    // `git status --porcelain` 覆盖未跟踪的新文件——端到端实测的越界（README.md / scripts/hello.sh）
    // 恰恰是未跟踪新文件，`git diff --name-only` 会漏掉它们。
    const changesAfter = collectChangedPaths(ws.path);
    // 平台自身运行时产物（日志/事件库/工作区）不属于任何节点的改动：先于基线求差与越界核对剔除，
    // 使越界核对、合并与事件载荷（changed_paths）都只看到**节点真正写出的路径**。
    const changedPaths = changesAfter
      .filter((path) => !changesBefore.has(path))
      .filter((path) => !isUnderPrefix(path, runtimePrefixes));
    const outOfBoundsPaths = findOwnViolations(changedPaths, role.owns, runtimePrefixes);
    // 越界路径清单会随所有失败落库（即便节点因别的原因失败，也不把越界这件事丢掉）
    const violationExtra: Record<string, unknown> =
      outOfBoundsPaths.length > 0
        ? { out_of_bounds_paths: outOfBoundsPaths, changed_paths: changedPaths }
        : {};

    // Task 11：工作区**不在此处回收**——批次结束后由 runTask 的 finishBatch 统一「先合并、再回收」。
    // 若仍在此回收，隔离节点写进 worktree 的改动会在合并之前被删掉（这正是 Task 11 要让其可达的核心前提）。

    // Task 11.3 可追溯：把「改动路径清单 + 工作区标识」写进每个节点的终态事件，
    // 使"这次改动来自哪个节点、落在哪个工作区"可追溯。
    const workspaceExtra: Record<string, unknown> = {
      changed_paths: changedPaths,
      worktree_path: ws.path,
      isolated: ws.isolated,
      worktree_created: ws.createdWorktree,
    };

    /** 收尾结果：succeeded=false 的节点改动不会被合并 */
    function result(succeeded: boolean): NodeRunResult {
      return { nodeId, runId: ws.runId, workspace: ws, owns: roleOwns, changedPaths, succeeded };
    }

    /**
     * 统一的失败落库：node.failed 与 task.failed 各写一条，均带**稳定分类枚举 + 中文说明**，
     * 原始文本保留在 error/raw 字段里（不丢原文，便于排查 CLI 细节）。
     * `extra` 用于携带附加事实（如 Task 7 的越界路径清单）。
     */
    function failNode(
      category: FailureReason,
      rawError: string,
      taskReason: string,
      extra: Record<string, unknown> = {},
    ): NodeRunResult {
      store.append({
        task_id: taskId,
        type: 'node.failed',
        payload: {
          node_id: nodeId,
          run_id: ws.runId,
          error: rawError,
          reason_category: category,
          reason_label: FAILURE_REASON_LABELS[category],
          log_ref: logRef,
          ...workspaceExtra,
          ...extra,
        },
        actor: 'kernel',
      });
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: {
          reason: taskReason,
          reason_category: category,
          reason_label: FAILURE_REASON_LABELS[category],
          raw: rawError,
          ...extra,
        },
        actor: 'kernel',
      });
      return result(false);
    }

    if (exitCode !== 0) {
      // 原始 CLI 文本一并保留：errorLines 已含日志中的错误行，failureDetail 是 runner 归一化的失败原文
      const detailParts = [...errorLines];
      if (failureDetail !== null && !detailParts.includes(failureDetail)) {
        detailParts.push(failureDetail);
      }
      const rawError = `CLI 退出码 ${exitCode}${detailParts.length > 0 ? `：${detailParts.join(' / ')}` : ''}`;
      // 分类来自 runner 层对 CLI subtype 的映射；runner 未给出分类时归入 other
      return failNode(failureReason ?? 'other', rawError, `节点 ${nodeId} 执行失败`, violationExtra);
    }

    if (!hasArtifact) {
      const rawError = `未产出任何结构化结果（期望类型 ${node.produces}）`;
      return failNode(
        failureReason ?? 'other',
        rawError,
        `节点 ${nodeId} 未产出结构化结果`,
        violationExtra,
      );
    }

    let parsed: ParsedArtifactPayload;
    try {
      parsed = parseArtifactPayload(node.produces as ArtifactType, artifactRaw);
    } catch (error) {
      return failNode(
        'invalid_payload',
        (error as Error).message,
        `节点 ${nodeId} 产出载荷不合规`,
        violationExtra,
      );
    }

    const artifactId = newId('art');
    store.append({
      task_id: taskId,
      type: 'artifact.created',
      payload: {
        artifact_id: artifactId,
        run_id: ws.runId,
        node_id: nodeId,
        type: node.produces,
        // status 由模型在结构化输出里给出（payload schema 内嵌 status 字段），内核消费它；
        // 修复前这里写死 'ok'，会让工作流边条件 all(artifacts.*.status == 'ok') 永远放行，
        // 模型的 blocked / needs_changes 判断被静默吃掉（2026-09-19 契约修复）。
        status: parsed.status,
        schema_version: 1,
        payload: parsed.payload,
        refs: [],
        summary: buildSummary(node.produces as ArtifactType, parsed.payload),
      },
      actor: `role:${role.id}`,
    });

    // Task 7：越界写必须被检出，且**不得静默继续**。
    // 语义选择：节点判 `failed` 并带分类化原因（复用稳定枚举 `permission_denied` = 权限被拒），
    // 刚产出的产物随即以 `artifact.invalidated` 作废（复用既有事件类型，此前全仓无生产者）。
    // 理由见 impl-task7-8-report.md：越界意味着产物本身不可信，若只告警却继续流转，
    // 下游会在被污染的产物上继续工作，正是"数据混乱"的来源。
    if (outOfBoundsPaths.length > 0) {
      store.append({
        task_id: taskId,
        type: 'artifact.invalidated',
        payload: {
          artifact_id: artifactId,
          run_id: ws.runId,
          node_id: nodeId,
          reason: `节点写入超出 owns 允许范围（允许写入：${role.owns.length > 0 ? role.owns.join(', ') : '（空，只读角色）'}）`,
          out_of_bounds_paths: outOfBoundsPaths,
          changed_paths: changedPaths,
        },
        actor: 'kernel',
      });
      return failNode(
        'permission_denied',
        `越界写入 ${outOfBoundsPaths.length} 个路径：${outOfBoundsPaths.join(', ')}`,
        `节点 ${nodeId} 越界写入（超出 owns 允许范围）`,
        violationExtra,
      );
    }

    store.append({
      task_id: taskId,
      type: 'node.succeeded',
      payload: { node_id: nodeId, run_id: ws.runId, log_ref: logRef, ...workspaceExtra },
      actor: 'kernel',
    });
    return result(true);
  }

  return { startTask, getState, getEvents, runTask, cancel };
}

/** 从载荷里抽取一段短摘要，作为唯一进入下游 prompt 的产物内容 */
function buildSummary(type: ArtifactType, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  if (type === 'requirement') {
    const goals = Array.isArray(p['goals']) ? (p['goals'] as string[]) : [];
    return `问题：${String(p['problem'] ?? '')}；目标：${goals.join('；')}`.slice(0, 1500);
  }
  if (type === 'code_diff') {
    const files = Array.isArray(p['files_changed']) ? (p['files_changed'] as string[]) : [];
    return `分支 ${String(p['branch'] ?? '')}，改动 ${files.length} 个文件，自测：${String(p['self_test_result'] ?? '')}`.slice(0, 1500);
  }
  if (type === 'test_report') {
    return `通过 ${String(p['passed'] ?? 0)}，失败 ${String(p['failed'] ?? 0)}`.slice(0, 1500);
  }
  return JSON.stringify(payload).slice(0, 1500);
}