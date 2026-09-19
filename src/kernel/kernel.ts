import { join } from 'node:path';
import { jsonSchemaForArtifact, parseArtifactPayload, type ArtifactType } from '../shared/artifacts.js';
import { newId } from '../shared/ids.js';
import type { KernelEvent } from '../shared/events.js';
import type { RoleDef, WorkflowDef } from '../shared/domain.js';
import type { AgentRunner, RunnerEvent } from '../runner/types.js';
import { assemblePrompt } from './context-assembler.js';
import type { EventStore } from './event-store.js';
import { buildFacts } from './facts.js';
import { project, type TaskState } from './projector.js';
import { prepareWorkspace, releaseWorkspace } from './scheduler.js';
import { decideNext } from './state-machine.js';

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
          payload: { reason: `超过最大步数 ${deps.maxSteps}，判定为死循环` },
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
        store.append({
          task_id: taskId,
          type: decision.status === 'completed' ? 'task.completed' : 'task.failed',
          payload: { reason: decision.reason },
          actor: 'kernel',
        });
        return getState(taskId);
      }

      await runNode(taskId, decision.nodeId, decision.reason);
    }
  }

  async function runNode(taskId: string, nodeId: string, reason: string): Promise<void> {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: { reason: `节点 ${nodeId} 不在工作流定义中` },
        actor: 'kernel',
      });
      return;
    }

    const role = roles.get(node.role);
    if (!role) {
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: { reason: `节点 ${nodeId} 引用了未注册的角色 ${node.role}` },
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

    store.append({
      task_id: taskId,
      type: 'transfer.decided',
      payload: { from: stateBefore.transfers.at(-1)?.to ?? '', to: nodeId, reason, decided_by: 'rule' },
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

    store.append({
      task_id: taskId,
      type: 'node.started',
      payload: { node_id: nodeId, role_id: role.id, run_id: ws.runId, attempt: previousVisit + 1 },
      actor: `role:${role.id}`,
    });

    const logRef = join(deps.logDir.replace(/^\.\//, ''), 'runs', `${ws.runId}.jsonl`);

    let artifactRaw: unknown;
    let hasArtifact = false;
    let exitCode: number | null = null;
    const errorLines: string[] = [];

    const readOnly = role.owns.length === 0;

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

    releaseWorkspace(ws, deps.repoPath);

    if (exitCode !== 0) {
      store.append({
        task_id: taskId,
        type: 'node.failed',
        payload: {
          node_id: nodeId,
          run_id: ws.runId,
          error: `CLI 退出码 ${exitCode}${errorLines.length > 0 ? `：${errorLines.join(' / ')}` : ''}`,
          log_ref: logRef,
        },
        actor: 'kernel',
      });
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: { reason: `节点 ${nodeId} 执行失败` },
        actor: 'kernel',
      });
      return;
    }

    if (!hasArtifact) {
      store.append({
        task_id: taskId,
        type: 'node.failed',
        payload: {
          node_id: nodeId,
          run_id: ws.runId,
          error: `未产出任何结构化结果（期望类型 ${node.produces}）`,
          log_ref: logRef,
        },
        actor: 'kernel',
      });
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: { reason: `节点 ${nodeId} 未产出结构化结果` },
        actor: 'kernel',
      });
      return;
    }

    let payload: unknown;
    try {
      payload = parseArtifactPayload(node.produces as ArtifactType, artifactRaw);
    } catch (error) {
      store.append({
        task_id: taskId,
        type: 'node.failed',
        payload: {
          node_id: nodeId,
          run_id: ws.runId,
          error: (error as Error).message,
          log_ref: logRef,
        },
        actor: 'kernel',
      });
      store.append({
        task_id: taskId,
        type: 'task.failed',
        payload: { reason: `节点 ${nodeId} 产出载荷不合规` },
        actor: 'kernel',
      });
      return;
    }

    store.append({
      task_id: taskId,
      type: 'artifact.created',
      payload: {
        artifact_id: newId('art'),
        run_id: ws.runId,
        node_id: nodeId,
        type: node.produces,
        status: 'ok',
        schema_version: 1,
        payload,
        refs: [],
        summary: buildSummary(node.produces as ArtifactType, payload),
      },
      actor: `role:${role.id}`,
    });

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