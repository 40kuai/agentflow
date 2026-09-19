import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RoleDef, WorkflowDef, WorkflowNodeDef } from '../shared/domain.js';
import { RoleFileSchema, WorkflowFileSchema, type WorkflowFile } from './schema.js';

function readYaml(filePath: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    // 保留底层 errno 信息：EACCES / EISDIR 等不能一概报成"找不到"
    throw new Error(`读取${label}文件失败：${filePath} —— ${(error as Error).message}`);
  }
  try {
    return parseYaml(raw);
  } catch (error) {
    throw new Error(`${label}文件 YAML 解析失败：${filePath} —— ${(error as Error).message}`);
  }
}

/** 加载角色定义，并把 system prompt 文件内容内联进来 */
export function loadRole(configDir: string, roleId: string): RoleDef {
  const filePath = resolve(configDir, 'roles', `${roleId}.yaml`);
  const parsed = RoleFileSchema.safeParse(readYaml(filePath, '角色'));
  if (!parsed.success) {
    throw new Error(`角色配置校验失败：${filePath} —— ${parsed.error.message}`);
  }
  const file = parsed.data;

  const promptPath = resolve(configDir, file.system_prompt_ref);
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(promptPath, 'utf8').trim();
  } catch {
    throw new Error(`找不到角色提示词文件：${promptPath}`);
  }

  return {
    id: file.id,
    displayName: file.display_name,
    systemPrompt,
    inputs: file.inputs,
    outputs: file.outputs,
    owns: file.owns,
    reads: file.reads,
    responsibilities: file.responsibilities,
    prohibitions: file.prohibitions,
    doneCriteria: file.done_criteria,
    model: file.model,
    maxRetries: file.max_retries,
    maxWallTimeMs: file.max_wall_time_ms,
  };
}

/** 加载 config/roles 下全部角色 */
export function loadAllRoles(configDir: string): Map<string, RoleDef> {
  const rolesDir = resolve(configDir, 'roles');
  let entries: string[];
  try {
    entries = readdirSync(rolesDir);
  } catch {
    throw new Error(`找不到角色目录：${rolesDir}`);
  }
  const map = new Map<string, RoleDef>();
  for (const entry of entries.filter((e) => e.endsWith('.yaml')).sort()) {
    const roleId = entry.replace(/\.yaml$/, '');
    const role = loadRole(configDir, roleId);
    map.set(role.id, role);
  }
  return map;
}

/** 两个字符串数组按集合比较（顺序无关）：契约是集合语义，声明顺序不应造成误报 */
function sameStringMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * 校验节点声明的 consumes/produces 与其角色权威的 inputs/outputs 是否一致。
 * 冲突时报错并**指明角色 id、节点 id、冲突字段**，绝不静默采用任意一边。
 */
function assertNodeContractMatchesRole(
  workflowId: string,
  node: WorkflowFile['nodes'][number],
  role: RoleDef,
): void {
  if (!sameStringMultiset(node.consumes, role.inputs)) {
    throw new Error(
      `工作流 ${workflowId} 的节点 ${node.id} 与角色 ${role.id} 的契约冲突（字段 consumes/inputs）：` +
        `节点声明 consumes=[${node.consumes.join(', ')}]，角色权威值 inputs=[${role.inputs.join(', ')}]；` +
        '输入输出契约的唯一权威来源是角色的 inputs/outputs，请修正节点声明',
    );
  }
  if (role.outputs.length !== 1 || node.produces !== role.outputs[0]) {
    throw new Error(
      `工作流 ${workflowId} 的节点 ${node.id} 与角色 ${role.id} 的契约冲突（字段 produces/outputs）：` +
        `节点声明 produces=${node.produces}，角色权威值 outputs=[${role.outputs.join(', ')}]；` +
        '输入输出契约的唯一权威来源是角色的 inputs/outputs，请修正节点声明',
    );
  }
}

/**
 * 加载工作流定义，并校验 start 与所有边引用真实存在的节点。
 *
 * 契约唯一来源：角色的 `inputs`/`outputs` 为**权威**，节点的 `consumes`/`produces` 为**派生**。
 * 加载期逐个节点与角色核对，冲突即报错；一致时以角色值回填派生字段。
 */
export function loadWorkflow(configDir: string, workflowId: string): WorkflowDef {
  const filePath = resolve(configDir, 'workflows', `${workflowId}.yaml`);
  const parsed = WorkflowFileSchema.safeParse(readYaml(filePath, '工作流'));
  if (!parsed.success) {
    throw new Error(`工作流配置校验失败：${filePath} —— ${parsed.error.message}`);
  }
  const file = parsed.data;
  const nodeIds = new Set(file.nodes.map((n) => n.id));

  if (!nodeIds.has(file.start)) {
    throw new Error(`工作流 ${workflowId} 的 start 指向不存在的节点：${file.start}`);
  }
  for (const edge of file.edges) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(`工作流 ${workflowId} 的边起点不存在：${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`工作流 ${workflowId} 的边终点不存在：${edge.to}`);
    }
  }

  const roles = loadAllRoles(configDir);
  const nodes: WorkflowNodeDef[] = file.nodes.map((node) => {
    const role = roles.get(node.role);
    if (!role) {
      throw new Error(`工作流 ${workflowId} 的节点 ${node.id} 引用了未注册的角色：${node.role}`);
    }
    assertNodeContractMatchesRole(workflowId, node, role);
    return {
      id: node.id,
      title: node.title,
      role: node.role,
      // 派生字段以角色为权威来源回填，而不是沿用节点里的声明
      consumes: [...role.inputs],
      produces: role.outputs[0]!,
      isolate: node.isolate,
      ...(node.description !== undefined ? { description: node.description } : {}),
      ...(node.entry_condition !== undefined ? { entryCondition: node.entry_condition } : {}),
    };
  });

  return {
    id: file.id,
    start: file.start,
    nodes,
    edges: file.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      ...(edge.when !== undefined ? { when: edge.when } : {}),
      description: edge.description,
      onMissing: edge.on_missing,
    })),
  };
}

/** 读取 prompts 目录下的文件（供调试与测试用） */
export function readPromptFile(configDir: string, ref: string): string {
  return readFileSync(join(configDir, ref), 'utf8').trim();
}