import { join } from 'node:path';
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
  type BatchConflictPolicy,
} from './path-guard.js';
import { project, type TaskState } from './projector.js';
import { prepareWorkspace, releaseWorkspace } from './scheduler.js';
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
  maxSteps: number;
  /**
   * 并行批次内 `owns` 重叠时的处理策略：serialize=改为串行；reject=拒绝该批次。
   * 取自 `AGENTFLOW_BATCH_CONFLICT_POLICY`（默认 serialize）。属 Task 8 的「配置中可指定」。
   */
  batchConflictPolicy?: BatchConflictPolicy;
};

export type StartTaskInput = {
  title: string;
  requirementRaw: string;
  baseBranch: string;
};

export type Kernel = {
  startTask(input: StartTaskInput): string;
  getState(taskId: string): TaskState;
  getEvents(taskId: string): KernelEvent[];
  runTask(taskId: string): Promise<TaskState>;
};

export function createKernel(deps: KernelDeps): Kernel {
  const { store, workflow, roles } = deps;

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

  async function runTask(taskId: string): Promise<TaskState> {
    let steps = 0;

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

      // Task 8：占用检查必须在**批次启动之前**执行。当前决策恒激活 1 个节点（fan-out 属 Task 9），
      // 检查对单节点天然放行；代码路径已就绪，待多节点批次出现时即生效。
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

      // 串行消费**激活节点集合**：当前决策恒激活 1 个（fan-out 由后续任务引入），
      // 逐个 await 保证与改动前的单节点行为等价。`serialize` 策略下亦是此串行行为；
      // 真正的并发调度属 Task 10（`guard.mode === 'parallel'` 时才会并发）。
      for (let i = 0; i < decision.nodeIds.length; i += 1) {
        await runNode(taskId, decision.nodeIds[i]!, decision.selectedEdges[i] ?? null);
      }
    }
  }

  async function runNode(
    taskId: string,
    nodeId: string,
    selectedEdge: EdgeEvaluation | null,
  ): Promise<void> {
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
      return;
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
      return;
    }

    const stateBefore = getState(taskId);
    const ws = prepareWorkspace({
      workspaceRoot: deps.workspaceRoot,
      repoPath: deps.repoPath,
      isolate: node.isolate,
      taskId,
      nodeId,
    });

    const previousVisit = stateBefore.visitCounts[nodeId] ?? 0;

    // 转移记录必须是可解释的：所用边、条件表达式原文、该表达式的人类可读说明（直接取自边配置的
    // description，不在引擎里另造）、以及判定依据（相关产物的实际状态）。
    store.append({
      task_id: taskId,
      type: 'transfer.decided',
      payload: {
        from: stateBefore.transfers.at(-1)?.to ?? '',
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
      payload: { node_id: nodeId, role_id: role.id, run_id: ws.runId, attempt: previousVisit + 1 },
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
    const changedPaths = changesAfter.filter((path) => !changesBefore.has(path));
    const outOfBoundsPaths = findOwnViolations(changedPaths, role.owns);
    // 越界路径清单会随所有失败落库（即便节点因别的原因失败，也不把越界这件事丢掉）
    const violationExtra: Record<string, unknown> =
      outOfBoundsPaths.length > 0
        ? { out_of_bounds_paths: outOfBoundsPaths, changed_paths: changedPaths }
        : {};

    releaseWorkspace(ws, deps.repoPath);

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
    ): void {
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
    }

    if (exitCode !== 0) {
      // 原始 CLI 文本一并保留：errorLines 已含日志中的错误行，failureDetail 是 runner 归一化的失败原文
      const detailParts = [...errorLines];
      if (failureDetail !== null && !detailParts.includes(failureDetail)) {
        detailParts.push(failureDetail);
      }
      const rawError = `CLI 退出码 ${exitCode}${detailParts.length > 0 ? `：${detailParts.join(' / ')}` : ''}`;
      // 分类来自 runner 层对 CLI subtype 的映射；runner 未给出分类时归入 other
      failNode(failureReason ?? 'other', rawError, `节点 ${nodeId} 执行失败`, violationExtra);
      return;
    }

    if (!hasArtifact) {
      const rawError = `未产出任何结构化结果（期望类型 ${node.produces}）`;
      failNode(failureReason ?? 'other', rawError, `节点 ${nodeId} 未产出结构化结果`, violationExtra);
      return;
    }

    let parsed: ParsedArtifactPayload;
    try {
      parsed = parseArtifactPayload(node.produces as ArtifactType, artifactRaw);
    } catch (error) {
      failNode('invalid_payload', (error as Error).message, `节点 ${nodeId} 产出载荷不合规`, violationExtra);
      return;
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
      failNode(
        'permission_denied',
        `越界写入 ${outOfBoundsPaths.length} 个路径：${outOfBoundsPaths.join(', ')}`,
        `节点 ${nodeId} 越界写入（超出 owns 允许范围）`,
        violationExtra,
      );
      return;
    }

    store.append({
      task_id: taskId,
      type: 'node.succeeded',
      payload: { node_id: nodeId, run_id: ws.runId, log_ref: logRef },
      actor: 'kernel',
    });
  }

  return { startTask, getState, getEvents, runTask };
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