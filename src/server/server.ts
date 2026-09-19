import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { loadAllRoles, loadRole, loadWorkflow } from '../config/loader.js';
import { RoleFileSchema, type RoleFile } from '../config/schema.js';
import type { EventStore } from '../kernel/event-store.js';
import type { Kernel } from '../kernel/kernel.js';
import { project, type TaskState } from '../kernel/projector.js';
import type { RoleDef, WorkflowDef } from '../shared/domain.js';
import type { KernelEvent } from '../shared/events.js';

const CreateTaskSchema = z.object({
  title: z.string().min(1),
  requirementRaw: z.string().min(1),
  baseBranch: z.string().min(1).default('main'),
});

/** 日志尾行的默认条数 */
const DEFAULT_LOG_TAIL = 200;
/** 日志尾行下限 */
const MIN_LOG_TAIL = 1;
/** 日志尾行上限：单文件可达数 MB，2000 行是刻意的体积保护 */
const MAX_LOG_TAIL = 2000;

/** 进程启动时刻（ms）：用 uptime 反推，前端据此判断后端进程是否比前端代码旧 */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/**
 * 本服务对前端声明的能力集。
 * 前端缺少必需能力时应提示「后端版本落后于前端，请重启服务」，
 * 而不是把日志端点的 404 误读成「日志不存在」。
 */
const SERVER_FEATURES: readonly string[] = [
  'log-by-node',
  'log-by-run',
  'live-stats',
  'task-cancel',
];

/** claude 进程探测结果的缓存时长：health 会被前端高频轮询，避免每次都 spawn ps */
const CLAUDE_PROC_CACHE_MS = 3000;

/** claude 进程信息（E 项：孤儿进程可见） */
type ClaudeProcess = { pid: number; etimeMs: number; command: string };

export type ServerDeps = {
  kernel: Kernel;
  /** 事件库：列表聚合与任务存在性判据的数据源（不再依赖进程内存登记） */
  store: EventStore;
  /** 日志根目录：内核拼 log_ref 用的同一个值，日志端点据此做目录穿越校验 */
  logDir: string;
  host: string;
  port: number;
  /**
   * 配置根目录（含 roles/、workflows/、prompts/）：角色查询与编辑的数据源。
   * 未提供时角色 API 返回 503（本服务面向本机、生产入口 main.ts 始终会传）。
   */
  configDir?: string;
  /**
   * 内核实际使用的工作流定义：流转视图的拓扑来源（与运行中的任务一致）。
   * 未提供时流转视图返回 503。
   */
  workflow?: WorkflowDef;
  /**
   * 内核实际使用的角色表：任务角色使用情况的显示名/预算来源。
   * 未提供时回退到从 configDir 加载。
   */
  roles?: Map<string, RoleDef>;
};

export type AgentFlowServer = {
  app: FastifyInstance;
  close(): Promise<void>;
};

type PushSocket = { send(data: string): void; readyState: number };

/** 任务列表摘要：从事件库聚合出的持久化视图，服务重启后依然可见 */
type TaskSummary = {
  taskId: string;
  title: string;
  status: string;
  budgetUsedUsd: number;
  nodeCount: number;
  completedNodeCount: number;
  createdAt: number;
  updatedAt: number;
};

/* ------------------------------------------------------------------ *
 * Task 5 / Task 6：角色查询、任务角色使用情况、流转视图与角色编辑
 * ------------------------------------------------------------------ */

/** 角色标识格式：仅允许字母/数字/下划线/连字符，杜绝用 `../` 之类越界拼接文件路径 */
const ROLE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 角色编辑的请求体（camelCase；约束与配置文件 RoleFileSchema 一一对应，错误信息用中文）。
 * 这里做**输入层**校验（400）；写入前还会用生产加载路径做**配置层**校验（422），见 validateRoleCandidate。
 */
const RoleEditSchema = z.object({
  displayName: z.string().min(1, 'displayName（显示名）不能为空'),
  systemPromptRef: z.string().min(1, 'systemPromptRef（提示词文件引用）不能为空'),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()).min(1, 'outputs（产出类型）至少声明一个'),
  owns: z.array(z.string()),
  reads: z.array(z.string()),
  responsibilities: z
    .array(z.string().min(1, 'responsibilities（职责边界）的每一项都不得为空'))
    .min(1, 'responsibilities（职责边界）至少声明一条'),
  prohibitions: z
    .array(z.string().min(1, 'prohibitions（禁止事项）的每一项都不得为空'))
    .min(1, 'prohibitions（禁止事项）至少声明一条'),
  doneCriteria: z
    .array(z.string().min(1, 'done_criteria（完成判据）的每一项都不得为空'))
    .min(1, 'done_criteria（完成判据）至少声明一条'),
  model: z.string().min(1, 'model（模型）不能为空'),
  maxRetries: z.number().int().nonnegative('maxRetries（最大重试次数）不得为负').default(2),
  maxWallTimeMs: z.number().int().positive('maxWallTimeMs（最大墙钟时间）必须为正数'),
});

/** 角色详情/列表的返回结构：字段完整，供用户前端直接渲染，不需要再解析散文 */
type RoleView = {
  id: string;
  displayName: string;
  systemPromptRef: string;
  inputs: string[];
  outputs: string[];
  owns: string[];
  reads: string[];
  responsibilities: string[];
  prohibitions: string[];
  doneCriteria: string[];
  model: string;
  budget: { maxRetries: number; maxWallTimeMs: number };
};

/** 从解析后的角色文件构造返回结构（配置文件即数据源，编辑后立即可见） */
function roleView(file: RoleFile): RoleView {
  return {
    id: file.id,
    displayName: file.display_name,
    systemPromptRef: file.system_prompt_ref,
    inputs: file.inputs,
    outputs: file.outputs,
    owns: file.owns,
    reads: file.reads,
    responsibilities: file.responsibilities,
    prohibitions: file.prohibitions,
    doneCriteria: file.done_criteria,
    model: file.model,
    budget: { maxRetries: file.max_retries, maxWallTimeMs: file.max_wall_time_ms },
  };
}

/** 角色 YAML 文件路径 */
function roleFilePath(configDir: string, roleId: string): string {
  return resolve(configDir, 'roles', `${roleId}.yaml`);
}

/** 读取并校验单个角色文件；文件不存在返回 null，结构非法抛出中文错误 */
function readRoleFile(configDir: string, roleId: string): RoleFile | null {
  const filePath = roleFilePath(configDir, roleId);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const parsed = RoleFileSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    throw new Error(`角色配置校验失败：${filePath} —— ${parsed.error.message}`);
  }
  return parsed.data;
}

/** 列出 configDir 下全部角色文件（按文件名排序，结果确定） */
function listRoleFiles(configDir: string): RoleFile[] {
  const rolesDir = resolve(configDir, 'roles');
  let entries: string[];
  try {
    entries = readdirSync(rolesDir);
  } catch {
    throw new Error(`找不到角色目录：${rolesDir}`);
  }
  const files: RoleFile[] = [];
  for (const entry of entries.filter((e) => e.endsWith('.yaml')).sort()) {
    const file = readRoleFile(configDir, entry.replace(/\.yaml$/, ''));
    if (file) files.push(file);
  }
  return files;
}

/** 把角色对象序列化成 YAML 文本（键顺序与配置文件现状一致，便于人读与 diff） */
function roleFileToYaml(roleId: string, file: RoleFile): string {
  return stringifyYaml({
    id: roleId,
    display_name: file.display_name,
    system_prompt_ref: file.system_prompt_ref,
    inputs: file.inputs,
    outputs: file.outputs,
    owns: file.owns,
    reads: file.reads,
    responsibilities: file.responsibilities,
    prohibitions: file.prohibitions,
    done_criteria: file.done_criteria,
    model: file.model,
    max_retries: file.max_retries,
    max_wall_time_ms: file.max_wall_time_ms,
  });
}

/**
 * 编辑前的**加载期校验复用**：把整个 configDir 复制到临时目录，写入候选角色文件后
 * 用生产同一条加载路径（`loadAllRoles` + `loadWorkflow`）重新加载。
 * - 全部在临时目录内进行，失败不触及真实配置，满足「校验失败不产生任何写入」；
 * - `loadWorkflow` 会校验「角色 inputs/outputs 与节点 consumes/produces 的一致性」，
 *   故会破坏契约唯一来源的编辑（例如改掉 outputs）在这里就被拦下。
 */
function validateRoleCandidate(
  configDir: string,
  roleId: string,
  file: RoleFile,
  workflowId: string,
): void {
  const tmp = mkdtempSync(join(tmpdir(), 'agentflow-role-edit-'));
  try {
    cpSync(configDir, tmp, { recursive: true });
    writeFileSync(join(tmp, 'roles', `${roleId}.yaml`), roleFileToYaml(roleId, file), 'utf8');
    loadAllRoles(tmp);
    loadWorkflow(tmp, workflowId);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 原子写入：先写同目录临时文件再 `rename` 覆盖目标。
 * 同一文件系统内 `rename` 是原子操作，避免出现"写了一半"的残缺 YAML 被读走。
 */
function writeFileAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, target);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清理临时文件失败不应掩盖真正的写入错误
    }
    throw error;
  }
}

/** 宽松读值：只接受字符串，否则回退 */
function asStr(payload: Record<string, unknown>, key: string, fallback = ''): string {
  const v = payload[key];
  return typeof v === 'string' ? v : fallback;
}

function asNum(payload: Record<string, unknown>, key: string, fallback = 0): number {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asStrOrNull(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' ? v : null;
}

/** 节点级运行时事实（从事件流聚合）：耗时、花费、产出、阻塞原因、改动路径 */
type NodeEventFacts = {
  startedAt: number | null;
  endedAt: number | null;
  costUsd: number;
  artifactTypes: string[];
  invalidatedArtifactTypes: string[];
  blocked: { category: string | null; label: string | null; error: string } | null;
  changedPaths: string[];
  worktreePath: string | null;
};

function emptyNodeFacts(): NodeEventFacts {
  return {
    startedAt: null,
    endedAt: null,
    costUsd: 0,
    artifactTypes: [],
    invalidatedArtifactTypes: [],
    blocked: null,
    changedPaths: [],
    worktreePath: null,
  };
}

function changedPathsOf(payload: Record<string, unknown>): string[] {
  const v = payload['changed_paths'];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * 从事件流聚合每个节点的事实。
 * 耗时取同一节点最后一次 `node.started` → 结束事件的 `created_at` 差（未结束为 null）；
 * 花费累加 `node.usage_recorded`；产出类型取 `artifact.created`，作废取 `artifact.invalidated`
 * （该事件只带 artifact_id，故用 created 时建立的 id→type 映射反查）。
 */
function collectNodeFacts(events: KernelEvent[]): Map<string, NodeEventFacts> {
  const map = new Map<string, NodeEventFacts>();
  const artifactTypeById = new Map<string, string>();
  const get = (nodeId: string): NodeEventFacts => {
    let facts = map.get(nodeId);
    if (!facts) {
      facts = emptyNodeFacts();
      map.set(nodeId, facts);
    }
    return facts;
  };

  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case 'node.started': {
        const facts = get(asStr(p, 'node_id'));
        facts.startedAt = event.created_at;
        facts.worktreePath = asStrOrNull(p, 'worktree_path') ?? facts.worktreePath;
        break;
      }
      case 'node.succeeded': {
        const facts = get(asStr(p, 'node_id'));
        facts.endedAt = event.created_at;
        const changed = changedPathsOf(p);
        if (changed.length > 0) facts.changedPaths = changed;
        break;
      }
      case 'node.failed': {
        const facts = get(asStr(p, 'node_id'));
        facts.endedAt = event.created_at;
        facts.blocked = {
          category: asStrOrNull(p, 'reason_category'),
          label: asStrOrNull(p, 'reason_label'),
          error: asStr(p, 'error'),
        };
        const changed = changedPathsOf(p);
        if (changed.length > 0) facts.changedPaths = changed;
        break;
      }
      case 'node.cancelled': {
        get(asStr(p, 'node_id')).endedAt = event.created_at;
        break;
      }
      case 'node.usage_recorded': {
        get(asStr(p, 'node_id')).costUsd += asNum(p, 'cost_usd');
        break;
      }
      case 'artifact.created': {
        const type = asStr(p, 'type');
        artifactTypeById.set(asStr(p, 'artifact_id'), type);
        get(asStr(p, 'node_id')).artifactTypes.push(type);
        break;
      }
      case 'artifact.invalidated': {
        const type = artifactTypeById.get(asStr(p, 'artifact_id'));
        if (type !== undefined) get(asStr(p, 'node_id')).invalidatedArtifactTypes.push(type);
        break;
      }
      default:
        // 其余事件与节点级事实无关，显式忽略
        break;
    }
  }
  return map;
}

function durationMsOf(facts: NodeEventFacts | undefined): number | null {
  if (!facts || facts.startedAt === null || facts.endedAt === null) return null;
  return Math.max(0, facts.endedAt - facts.startedAt);
}

/** 单个角色在某任务中的使用情况（Task 5 SubTask 5.2） */
type RoleUsageNode = {
  nodeId: string;
  status: string;
  produces: string | null;
  artifactTypes: string[];
  invalidatedArtifactTypes: string[];
  attempt: number;
  durationMs: number | null;
  costUsd: number;
};

type RoleUsage = {
  roleId: string;
  displayName: string | null;
  model: string | null;
  budget: { maxRetries: number; maxWallTimeMs: number } | null;
  nodes: RoleUsageNode[];
  totalDurationMs: number;
  totalCostUsd: number;
};

/**
 * 聚合「某任务用到哪些角色」：角色 ↔ 节点 ↔ 状态 ↔ 产出类型 ↔ 耗时 ↔ 花费。
 * 只统计**真正被调度过**的节点（state.nodes 里存在的）；拓扑中尚未运行的节点不参与。
 */
function buildRoleUsage(
  state: TaskState,
  events: KernelEvent[],
  workflow: WorkflowDef | undefined,
  roles: Map<string, RoleDef>,
): { taskId: string; roles: RoleUsage[]; totalCostUsd: number } {
  const facts = collectNodeFacts(events);
  const producedByNode = new Map<string, string>();
  const order: string[] = [];
  if (workflow) {
    for (const node of workflow.nodes) {
      producedByNode.set(node.id, node.produces);
      order.push(node.id);
    }
  }
  // 事件里出现过但不在拓扑中的节点：追加到末尾兜底，保证不丢数据
  for (const nodeId of Object.keys(state.nodes)) {
    if (!order.includes(nodeId)) order.push(nodeId);
  }

  const byRole = new Map<string, RoleUsage>();
  for (const nodeId of order) {
    const node = state.nodes[nodeId];
    if (!node) continue;
    let usage = byRole.get(node.roleId);
    if (!usage) {
      const roleDef = roles.get(node.roleId);
      usage = {
        roleId: node.roleId,
        displayName: roleDef?.displayName ?? null,
        model: roleDef?.model ?? null,
        budget: roleDef
          ? { maxRetries: roleDef.maxRetries, maxWallTimeMs: roleDef.maxWallTimeMs }
          : null,
        nodes: [],
        totalDurationMs: 0,
        totalCostUsd: 0,
      };
      byRole.set(node.roleId, usage);
    }
    const nodeFacts = facts.get(nodeId);
    const durationMs = durationMsOf(nodeFacts);
    usage.nodes.push({
      nodeId,
      status: node.status,
      produces: producedByNode.get(nodeId) ?? null,
      artifactTypes: nodeFacts?.artifactTypes ?? [],
      invalidatedArtifactTypes: nodeFacts?.invalidatedArtifactTypes ?? [],
      attempt: node.attempt,
      durationMs,
      costUsd: nodeFacts?.costUsd ?? 0,
    });
    usage.totalDurationMs += durationMs ?? 0;
    usage.totalCostUsd += nodeFacts?.costUsd ?? 0;
  }

  const roleList = [...byRole.values()].sort((a, b) => a.roleId.localeCompare(b.roleId));
  return {
    taskId: state.taskId,
    roles: roleList,
    totalCostUsd: roleList.reduce((sum, r) => sum + r.totalCostUsd, 0),
  };
}

/** 流转视图中的一个节点：拓扑信息 + 运行时事实（进入理由、状态、阻塞原因、耗时、花费） */
type FlowNodeView = {
  id: string;
  title: string;
  role: string;
  roleDisplayName: string | null;
  description: string | null;
  entryCondition: string | null;
  consumes: string[];
  produces: string | null;
  isolate: boolean | null;
  status: string;
  attempt: number;
  current: boolean;
  enterReason: {
    from: string;
    reason: string;
    edge: { from: string; to: string } | null;
    when: string | null;
    edgeDescription: string | null;
    artifactStatuses: { type: string; status: string }[];
  } | null;
  blockedReason: { category: string | null; label: string | null; error: string } | null;
  durationMs: number | null;
  costUsd: number;
  artifactTypes: string[];
  invalidatedArtifactTypes: string[];
  changedPaths: string[];
  worktreePath: string | null;
};

type FlowEdgeView = {
  from: string;
  to: string;
  when: string | null;
  description: string | null;
  onMissing: 'fail' | 'wait' | null;
};

/** 任务级失败的结构化原因（来自最后一个 task.failed 事件） */
type TaskFailureView = {
  reason: string;
  category: string | null;
  label: string | null;
  unmetConditions: string[];
  artifactStatuses: { type: string; status: string }[];
} | null;

/**
 * 组装「某任务的流转视图」：拓扑（节点 + 边 + 边的说明）+ 每个节点的
 * 进入理由（来自 transfer.decided）、状态、阻塞原因（来自 node.failed 的分类化原因）、耗时与花费。
 */
function buildFlowView(
  workflow: WorkflowDef,
  state: TaskState,
  events: KernelEvent[],
  roles: Map<string, RoleDef>,
): {
  taskId: string;
  title: string;
  status: string;
  currentNodeIds: string[];
  completedNodeIds: string[];
  budgetUsedUsd: number;
  nodes: FlowNodeView[];
  edges: FlowEdgeView[];
  transfers: TaskState['transfers'];
  taskFailure: TaskFailureView;
} {
  const facts = collectNodeFacts(events);
  const transfers = state.transfers;

  /** 取该节点最后一次转移记录（进入理由）；无则为 null（例如尚未进入的节点） */
  const transferFor = (nodeId: string): TaskState['transfers'][number] | null => {
    for (let i = transfers.length - 1; i >= 0; i -= 1) {
      const t = transfers[i]!;
      if (t.to === nodeId) return t;
    }
    return null;
  };

  const toView = (params: {
    id: string;
    title: string;
    role: string;
    description: string | null;
    entryCondition: string | null;
    consumes: string[];
    produces: string | null;
    isolate: boolean | null;
  }): FlowNodeView => {
    const nodeState = state.nodes[params.id];
    const nodeFacts = facts.get(params.id);
    const t = transferFor(params.id);
    return {
      ...params,
      roleDisplayName: params.role === '' ? null : (roles.get(params.role)?.displayName ?? null),
      status: nodeState?.status ?? 'not_started',
      attempt: nodeState?.attempt ?? 0,
      current: state.currentNodeIds.includes(params.id),
      enterReason: t
        ? {
            from: t.from,
            reason: t.reason,
            edge: t.edge ?? null,
            when: t.when ?? null,
            edgeDescription: t.edgeDescription ?? null,
            artifactStatuses: t.artifactStatuses ?? [],
          }
        : null,
      blockedReason: nodeFacts?.blocked ?? null,
      durationMs: durationMsOf(nodeFacts),
      costUsd: nodeFacts?.costUsd ?? 0,
      artifactTypes: nodeFacts?.artifactTypes ?? [],
      invalidatedArtifactTypes: nodeFacts?.invalidatedArtifactTypes ?? [],
      changedPaths: nodeFacts?.changedPaths ?? [],
      worktreePath: nodeFacts?.worktreePath ?? null,
    };
  };

  const nodes: FlowNodeView[] = workflow.nodes.map((node) =>
    toView({
      id: node.id,
      title: node.title,
      role: node.role,
      description: node.description ?? null,
      entryCondition: node.entryCondition ?? null,
      consumes: node.consumes,
      produces: node.produces,
      isolate: node.isolate,
    }),
  );

  // 防御性兜底：事件里出现过但不在拓扑中的节点也列出，避免"用了却没显示"
  const knownIds = new Set(workflow.nodes.map((n) => n.id));
  for (const nodeId of Object.keys(state.nodes)) {
    if (knownIds.has(nodeId)) continue;
    nodes.push(
      toView({
        id: nodeId,
        title: nodeId,
        role: state.nodes[nodeId]!.roleId,
        description: null,
        entryCondition: null,
        consumes: [],
        produces: null,
        isolate: null,
      }),
    );
  }

  const edges: FlowEdgeView[] = workflow.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    when: edge.when ?? null,
    description: edge.description ?? null,
    onMissing: edge.onMissing ?? null,
  }));

  let taskFailure: TaskFailureView = null;
  for (const event of events) {
    if (event.type !== 'task.failed') continue;
    const p = event.payload;
    const statusesRaw = p['artifact_statuses'];
    taskFailure = {
      reason: asStr(p, 'reason'),
      category: asStrOrNull(p, 'reason_category'),
      label: asStrOrNull(p, 'reason_label'),
      unmetConditions: Array.isArray(p['unmet_conditions'])
        ? p['unmet_conditions'].filter((x): x is string => typeof x === 'string')
        : [],
      artifactStatuses: Array.isArray(statusesRaw)
        ? statusesRaw
            .filter(
              (s): s is Record<string, unknown> =>
                typeof s === 'object' && s !== null && !Array.isArray(s),
            )
            .map((s) => ({ type: asStr(s, 'type'), status: asStr(s, 'status') }))
        : [],
    };
  }

  // 取消是终态：取消后到达的 task.failed 是"在途节点被终止"的余波，不是"为什么失败"。
  // 若照实透出，界面会同时显示"已取消"和"失败原因：xxx"，反而让人以为流程走错了。
  if (state.status === 'cancelled') taskFailure = null;

  return {
    taskId: state.taskId,
    title: state.title,
    status: state.status,
    currentNodeIds: state.currentNodeIds,
    completedNodeIds: state.completedNodeIds,
    budgetUsedUsd: state.budgetUsedUsd,
    nodes,
    edges,
    transfers,
    taskFailure,
  };
}

/**
 * 把 tail 查询参数钳制到 [1, 2000]、缺省或非数字回退默认值。
 * 采用"钳制"而非报错：日志端点的目的是尽力让用户看到诊断信息，非法参数不应成为阻碍。
 */
function normalizeTail(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LOG_TAIL;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LOG_TAIL;
  return Math.min(MAX_LOG_TAIL, Math.max(MIN_LOG_TAIL, Math.trunc(n)));
}

/** 按 task_id 分组事件（保持 seq 顺序） */
function groupByTask(events: KernelEvent[]): Map<string, KernelEvent[]> {
  const byTask = new Map<string, KernelEvent[]>();
  for (const event of events) {
    const bucket = byTask.get(event.task_id);
    if (bucket) bucket.push(event);
    else byTask.set(event.task_id, [event]);
  }
  return byTask;
}

/**
 * 目录穿越防护的唯一入口：把候选日志路径解析后校验是否落在日志根目录内。
 * 越界返回 null（调用方据此返回 400，且绝不读取任何文件内容）。
 * 所有依赖“数据驱动路径”的日志端点都必须走这里，不得另写一份更宽松的校验。
 */
function resolveWithinLogRoot(logDir: string, candidate: string): string | null {
  const resolvedRoot = resolve(logDir);
  const resolved = resolve(candidate);
  if (!resolved.startsWith(resolvedRoot + sep)) return null;
  return resolved;
}

/** 读取已通过穿越校验的日志文件的末 tail 行（原样返回字符串行，不做 JSON 解析） */
function readLogFileTail(
  resolved: string,
  rawTail: unknown,
): { totalLines: number; returnedLines: number; truncated: boolean; lines: string[] } {
  const raw = readFileSync(resolved, 'utf8');
  const allLines = raw.split('\n');
  // 丢弃文件末尾换行产生的空元素
  while (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

  const totalLines = allLines.length;
  const tail = normalizeTail(rawTail);
  const lines = totalLines <= tail ? allLines : allLines.slice(totalLines - tail);
  return { totalLines, returnedLines: lines.length, truncated: lines.length < totalLines, lines };
}

/** 解析 ps 的 etime（[[dd-]hh:]mm:ss）为毫秒；无法解析返回 -1 */
function parseEtimeMs(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return -1;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

let claudeProcCache: { at: number; value: ClaudeProcess[] } | null = null;

/**
 * 列出本机 claude 进程（E 项：孤儿进程可见）。
 *
 * 平台相关取舍：AgentFlow 只监听 127.0.0.1、面向 macOS 单机场景，因此直接使用 POSIX 的 ps；
 * Windows / 远程主机需另接 tasklist 或远端采集，本实现不做跨平台兼容。
 * 内核不记录 spawn 出的 PID，PID ↔ runId 无法精确关联，故这里只如实报告进程本身，
 * 绝不编造「该进程属于哪个 run」。
 */
function listClaudeProcesses(): ClaudeProcess[] {
  const now = Date.now();
  if (claudeProcCache && now - claudeProcCache.at < CLAUDE_PROC_CACHE_MS) {
    return claudeProcCache.value;
  }

  let value: ClaudeProcess[] = [];
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,etime=,command='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const command = m[3]!.trim();
      // 只认命令行里出现 claude 的进程；ps 自身的命令行不含 claude，不会自匹配。
      // 用子串而非精确匹配，是为兼容 `claude` 与 `<path>/claude-code/cli.js` 等多种启动形态。
      if (!/claude/i.test(command)) continue;
      value.push({ pid: Number(m[1]), etimeMs: parseEtimeMs(m[2]!), command });
    }
  } catch {
    // ps 不可用（非 POSIX 环境）时如实返回空列表，不抛错拖垮 health
    value = [];
  }
  claudeProcCache = { at: now, value };
  return value;
}

/** 日志文件活性：sizeBytes + 最后修改时间 + ageMs（判断 agent 是否还在干活的核心信号） */
function logFileFacts(st: Pick<Stats, 'size' | 'mtimeMs'>): {
  sizeBytes: number;
  lastModifiedAt: number;
  ageMs: number;
} {
  const lastModifiedAt = Math.round(st.mtimeMs);
  return { sizeBytes: st.size, lastModifiedAt, ageMs: Math.max(0, Date.now() - lastModifiedAt) };
}

/** 读取文件 stat；不存在或不是普通文件返回 null（调用方据此返回 404 + FILE_NOT_FOUND） */
function statLogFile(resolved: string): Stats | null {
  try {
    const st = statSync(resolved);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

export function createServer(deps: ServerDeps): AgentFlowServer {
  const app = Fastify({ logger: false });
  const sockets = new Set<PushSocket>();

  function broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  app.register(websocket);

  /**
   * 角色表解析：优先用内核实际使用的角色表（与运行中的任务一致），
   * 其次从 configDir 加载（供显示名/预算），都没有则空表。
   */
  function resolveRoles(): Map<string, RoleDef> {
    if (deps.roles) return deps.roles;
    if (deps.configDir) {
      try {
        return loadAllRoles(deps.configDir);
      } catch {
        return new Map();
      }
    }
    return new Map();
  }

  // 能力探测端点：前端据此判断「后端是否落后于前端代码」，从而不再把日志端点的 404 误读成
  // 「日志不存在」。pid / startedAt 用于诊断「前端热更新、后端正跑着旧代码」这类最常见误诊。
  app.get('/api/health', async () => {
    const now = Date.now();
    return {
      ok: true,
      pid: process.pid,
      startedAt: PROCESS_STARTED_AT,
      uptimeMs: Math.max(0, now - PROCESS_STARTED_AT),
      features: [...SERVER_FEATURES],
      claudeProcesses: listClaudeProcesses(),
    };
  });

  app.post('/api/tasks', async (request, reply) => {
    const parsed = CreateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: '请求体不合法', detail: parsed.error.message });
    }

    // task.created 已在 startTask 内同步落库，列表/详情接口无需任何内存登记即可立刻读到
    const taskId = deps.kernel.startTask(parsed.data);

    // 异步推进任务，不阻塞 HTTP 响应
    void deps.kernel
      .runTask(taskId)
      .then((state) => broadcast({ type: 'task_state', state }))
      .catch((error: unknown) => {
        broadcast({ type: 'task_error', taskId, message: (error as Error).message });
      });

    return reply.status(201).send({ taskId });
  });

  app.get('/api/tasks', async () => {
    // Phase 1 取舍：readAll() 是全量读事件库，任务/事件规模大了需要改为分页或专门的
    // 任务索引表；当前规模下可接受，换来"服务重启后列表不丢、内核直建任务也可见"的正确性。
    const summaries: TaskSummary[] = [];

    for (const [taskId, events] of groupByTask(deps.store.readAll())) {
      const state = project(events);
      let createdAt = events[0]!.created_at;
      let updatedAt = events[0]!.created_at;
      for (const event of events) {
        if (event.created_at < createdAt) createdAt = event.created_at;
        if (event.created_at > updatedAt) updatedAt = event.created_at;
      }
      summaries.push({
        taskId,
        title: state.title,
        status: state.status,
        budgetUsedUsd: state.budgetUsedUsd,
        nodeCount: Object.keys(state.nodes).length,
        completedNodeCount: state.completedNodeIds.length,
        createdAt,
        updatedAt,
      });
    }

    // 按 updatedAt 倒序：最新任务排最前
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return { tasks: summaries };
  });

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    // 判据改到事件库：有事件即可读，不再要求经 POST 登记
    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}` });
    }
    return deps.kernel.getState(taskId);
  });

  app.get('/api/tasks/:taskId/events', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}` });
    }
    return { events: deps.kernel.getEvents(taskId) };
  });

  // ---- Task 5：角色与流转的查询 API（只提供结构化数据，不碰前端）----

  // 角色列表：返回职责边界/禁止事项/完成判据/可写路径/可读路径/模型/预算，字段完整
  app.get('/api/roles', async (_request, reply) => {
    if (!deps.configDir) {
      return reply
        .status(503)
        .send({ error: '服务未配置 configDir，角色 API 不可用', code: 'CONFIG_DIR_MISSING' });
    }
    try {
      return { roles: listRoleFiles(deps.configDir).map(roleView) };
    } catch (error) {
      return reply.status(500).send({ error: (error as Error).message });
    }
  });

  // 角色详情：同上字段；未知角色 404，非法 id 400（防路径拼接）
  app.get('/api/roles/:roleId', async (request, reply) => {
    const { roleId } = request.params as { roleId: string };
    if (!deps.configDir) {
      return reply
        .status(503)
        .send({ error: '服务未配置 configDir，角色 API 不可用', code: 'CONFIG_DIR_MISSING' });
    }
    if (!ROLE_ID_PATTERN.test(roleId)) {
      return reply.status(400).send({ error: `角色 id 不合法：${roleId}`, code: 'INVALID_ROLE_ID' });
    }
    let file: RoleFile | null;
    try {
      file = readRoleFile(deps.configDir, roleId);
    } catch (error) {
      return reply.status(500).send({ error: (error as Error).message });
    }
    if (!file) {
      return reply.status(404).send({ error: `找不到角色：${roleId}`, code: 'ROLE_NOT_FOUND' });
    }
    return roleView(file);
  });

  // 某任务的角色使用情况：角色 ↔ 节点 ↔ 状态 ↔ 产出类型 ↔ 耗时 ↔ 花费
  app.get('/api/tasks/:taskId/roles', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}`, code: 'TASK_NOT_FOUND' });
    }
    const state = deps.kernel.getState(taskId);
    return buildRoleUsage(state, deps.kernel.getEvents(taskId), deps.workflow, resolveRoles());
  });

  // 某任务的流转视图：拓扑（节点 + 边 + 边的说明）+ 每个节点的进入理由、状态、阻塞原因、耗时与花费
  app.get('/api/tasks/:taskId/flow', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}`, code: 'TASK_NOT_FOUND' });
    }
    if (!deps.workflow) {
      return reply
        .status(503)
        .send({ error: '服务未配置工作流，流转视图不可用', code: 'WORKFLOW_MISSING' });
    }
    const state = deps.kernel.getState(taskId);
    return buildFlowView(deps.workflow, state, deps.kernel.getEvents(taskId), resolveRoles());
  });

  // ---- Task 6：角色编辑 API（校验通过才写回 YAML；失败不产生任何写入）----
  app.put('/api/roles/:roleId', async (request, reply) => {
    const { roleId } = request.params as { roleId: string };
    if (!deps.configDir) {
      return reply
        .status(503)
        .send({ error: '服务未配置 configDir，角色 API 不可用', code: 'CONFIG_DIR_MISSING' });
    }
    if (!ROLE_ID_PATTERN.test(roleId)) {
      return reply.status(400).send({ error: `角色 id 不合法：${roleId}`, code: 'INVALID_ROLE_ID' });
    }

    const parsed = RoleEditSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: '请求体不合法', detail: parsed.error.message });
    }
    const data = parsed.data;
    const target = roleFilePath(deps.configDir, roleId);

    // 编辑是"替换"而非"新建"：既有文件不存在则 404，绝不凭空创建
    let originalRaw: string;
    try {
      originalRaw = readFileSync(target, 'utf8');
    } catch {
      return reply.status(404).send({ error: `找不到角色：${roleId}`, code: 'ROLE_NOT_FOUND' });
    }

    // id 以 URL 为准，避免文件内 id 与文件名不一致（二者必须一致才能被加载器正确读取）
    const candidate: RoleFile = {
      id: roleId,
      display_name: data.displayName,
      system_prompt_ref: data.systemPromptRef,
      inputs: data.inputs,
      outputs: data.outputs,
      owns: data.owns,
      reads: data.reads,
      responsibilities: data.responsibilities,
      prohibitions: data.prohibitions,
      done_criteria: data.doneCriteria,
      model: data.model,
      max_retries: data.maxRetries,
      max_wall_time_ms: data.maxWallTimeMs,
    };

    // 写入前校验：在**临时目录副本**里跑生产加载路径（含角色 schema、提示词文件存在性、
    // 以及与工作流节点的契约一致性）。任何一步失败都在此处返回 422，真实配置文件一字未动。
    const workflowId = deps.workflow?.id ?? 'simple_dev';
    try {
      validateRoleCandidate(deps.configDir, roleId, candidate, workflowId);
    } catch (error) {
      return reply.status(422).send({
        error: `编辑被拒绝：${(error as Error).message}`,
        code: 'INVALID_ROLE_CONFIG',
      });
    }

    // 校验通过才写回；写入原子（临时文件 + rename）
    try {
      writeFileAtomic(target, roleFileToYaml(roleId, candidate));
    } catch (error) {
      return reply.status(500).send({ error: `写入角色文件失败：${(error as Error).message}` });
    }

    // 重新加载验证：落盘后必须能被生产加载器读回；否则回滚到编辑前内容，绝不残留半成品配置
    try {
      loadRole(deps.configDir, roleId);
    } catch (error) {
      try {
        writeFileAtomic(target, originalRaw);
      } catch {
        // 回滚也失败时（磁盘异常）仍返回明确错误，提示人工介入
      }
      return reply.status(500).send({
        error: `重新加载验证失败，已回滚到编辑前内容：${(error as Error).message}`,
        code: 'RELOAD_FAILED',
      });
    }

    const reloaded = readRoleFile(deps.configDir, roleId);
    if (!reloaded) {
      return reply
        .status(500)
        .send({ error: `写入后无法读回角色文件：${target}`, code: 'RELOAD_FAILED' });
    }
    return { role: roleView(reloaded), path: target };
  });

  // ---- 取消任务：内核已有 cancel 能力，此前没有 HTTP 入口（Task 12 遗留项）----
  //
  // 语义（与 kernel.cancel 一致）：
  //  - 未知任务 404（判据同其它端点：事件库里有事件才算存在）；
  //  - 已终态（completed/failed/cancelled）→ 200 且 `cancelled: false` + 中文 `reason`，
  //    幂等且**如实说明为什么没取消**，不伪装成"取消成功"；
  //  - active → 200 `cancelled: true`，`state.status === 'cancelled'`（明确的终态，不悬挂）；
  //    同时通知 runner 杀掉在途进程组，取消才真的停止花钱。
  app.post('/api/tasks/:taskId/cancel', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}`, code: 'TASK_NOT_FOUND' });
    }
    const before = deps.kernel.getState(taskId);
    const state = deps.kernel.cancel(taskId);
    const cancelled = before.status === 'active' && state.status === 'cancelled';
    return {
      cancelled,
      ...(cancelled ? {} : { reason: `任务已处于终态（${before.status}），无需取消` }),
      state,
    };
  });

  app.get('/api/tasks/:taskId/nodes/:nodeId/log', async (request, reply) => {
    const { taskId, nodeId } = request.params as { taskId: string; nodeId: string };
    const query = request.query as { tail?: string };

    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}`, code: 'TASK_NOT_FOUND' });
    }

    const state = deps.kernel.getState(taskId);
    const node = state.nodes[nodeId];
    if (!node) {
      return reply.status(404).send({ error: `找不到节点：${nodeId}`, code: 'NODE_NOT_FOUND' });
    }
    if (!node.lastLogRef) {
      return reply
        .status(404)
        .send({ error: `节点 ${nodeId} 没有日志引用`, code: 'NO_LOG_REF' });
    }

    // lastLogRef 来自事件库、属于数据驱动的路径：必须先做目录穿越校验，绝不能直接读任意文件。
    // 校验不通过时直接返回 400，且不读取任何文件内容。
    const resolved = resolveWithinLogRoot(deps.logDir, node.lastLogRef);
    if (!resolved) {
      return reply.status(400).send({
        error: `日志路径越界：不在允许的日志根目录内（${resolve(node.lastLogRef)}）`,
        code: 'OUT_OF_LOG_ROOT',
      });
    }

    const st = statLogFile(resolved);
    if (!st) {
      return reply
        .status(404)
        .send({ error: `日志文件不存在：${resolved}`, code: 'FILE_NOT_FOUND' });
    }

    // 只读、不修改任何文件。服务端不做 JSON 解析/格式化：原样返回字符串行，
    // 由前端决定如何展示 stream-json。tail 上限 2000 行是刻意的体积保护。
    // 同时带上文件活性（sizeBytes/lastModifiedAt/ageMs）：这是判断 agent 是否还在干活的核心信号。
    return {
      nodeId,
      logRef: resolved,
      ...readLogFileTail(resolved, query.tail),
      ...logFileFacts(st),
    };
  });

  // 运行中节点的回退日志端点：node.started 之前的老事件可能没有 log_ref，
  // 而日志文件其实早已在写入。此时按 runId 直接定位 logs/runs/<runId>.jsonl。
  app.get('/api/tasks/:taskId/runs/:runId/log', async (request, reply) => {
    const { taskId, runId } = request.params as { taskId: string; runId: string };
    const query = request.query as { tail?: string };

    if (deps.store.readTask(taskId).length === 0) {
      return reply.status(404).send({ error: `找不到任务：${taskId}`, code: 'TASK_NOT_FOUND' });
    }

    // runId 来自 URL，属于外部输入：拼接后同样要过“根目录内校验”，绝不能放宽。
    const candidate = join(deps.logDir, 'runs', `${runId}.jsonl`);
    const resolved = resolveWithinLogRoot(deps.logDir, candidate);
    if (!resolved) {
      return reply.status(400).send({
        error: `日志路径越界：不在允许的日志根目录内（${resolve(candidate)}）`,
        code: 'OUT_OF_LOG_ROOT',
      });
    }

    const st = statLogFile(resolved);
    if (!st) {
      return reply
        .status(404)
        .send({ error: `日志文件不存在：${resolved}`, code: 'FILE_NOT_FOUND' });
    }

    // 与节点端点一致：附上文件活性，运行中即可判断「还在写」还是「已停滞」。
    return {
      runId,
      logRef: resolved,
      ...readLogFileTail(resolved, query.tail),
      ...logFileFacts(st),
    };
  });

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      const s = socket as unknown as PushSocket;
      sockets.add(s);
      socket.on('close', () => sockets.delete(s));
    });
  });

  return {
    app,
    async close(): Promise<void> {
      await app.close();
    },
  };
}