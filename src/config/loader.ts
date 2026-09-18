import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RoleDef, WorkflowDef } from '../shared/domain.js';
import { RoleFileSchema, WorkflowFileSchema } from './schema.js';

function readYaml(filePath: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`找不到${label}文件：${filePath}`);
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
    model: file.model,
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

/** 加载工作流定义，并校验 start 与所有边引用真实存在的节点 */
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

  return {
    id: file.id,
    start: file.start,
    nodes: file.nodes,
    edges: file.edges,
  };
}

/** 读取 prompts 目录下的文件（供调试与测试用） */
export function readPromptFile(configDir: string, ref: string): string {
  return readFileSync(join(configDir, ref), 'utf8').trim();
}