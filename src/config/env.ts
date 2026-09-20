import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type AppEnv = {
  dbPath: string;
  logDir: string;
  workspaceDir: string;
  configDir: string;
  /**
   * 启动时加载的工作流 id（对应 `config/workflows/<id>.yaml`）。
   * 由环境变量 `AGENTFLOW_WORKFLOW` 指定，默认 `simple_dev`（串行基线）。
   */
  workflowId: string;
  host: string;
  port: number;
  maxPromptTokens: number;
  globalConcurrency: number;
  /**
   * 并行批次内 `owns` 路径重叠时的处理策略：serialize=改为串行；reject=拒绝该批次。
   * 由环境变量 `AGENTFLOW_BATCH_CONFLICT_POLICY` 指定（默认 serialize）。
   */
  batchConflictPolicy: 'serialize' | 'reject';
  /**
   * 节点「停滞自动停止」阈值（ms）：某节点子进程连续该时长没有任何 stdout/stderr 输出，
   * 即判定为卡死，由 runner 强制终止（SIGKILL）并按失败处理。`0` 表示关闭该保护。
   * 由环境变量 `AGENTFLOW_NODE_STALL_TIMEOUT_MS` 指定（默认 600000 = 10 分钟）。
   * 与角色的 wall-clock 硬超时互补：后者只封顶总时长，对「进程活着但再也不输出」无效。
   */
  nodeStallTimeoutMs: number;
  claudeBin: string;
  codexBin: string;
};

const DEFAULTS: AppEnv = {
  dbPath: './data/agentflow.sqlite',
  logDir: './logs',
  workspaceDir: './workspaces',
  configDir: './config',
  workflowId: 'simple_dev',
  host: '127.0.0.1',
  port: 8787,
  maxPromptTokens: 30000,
  globalConcurrency: 4,
  batchConflictPolicy: 'serialize',
  nodeStallTimeoutMs: 600_000,
  claudeBin: 'claude',
  codexBin: 'codex',
};

/** 读取 .env 文件为键值对；文件不存在时返回空对象 */
export function readDotEnvFile(filePath = resolve(process.cwd(), '.env')): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function readInt(source: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`环境变量 ${key} 必须是正整数，实际为 "${raw}"`);
  }
  return n;
}

/**
 * 读取**非负整数**：与 readInt 的区别是允许 0——0 在这里是「关闭保护」的合法取值，
 * 不能沿用 readInt 的「必须是正整数」约束（那会让用户无法显式关闭自动停止）。
 */
function readNonNegInt(
  source: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`环境变量 ${key} 必须是非负整数（0 表示关闭），实际为 "${raw}"`);
  }
  return n;
}

function readStr(source: Record<string, string | undefined>, key: string, fallback: string): string {
  const raw = source[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** 批次冲突策略只接受 serialize / reject 两个取值；非法值显式报错，不静默回退 */
function readConflictPolicy(
  source: Record<string, string | undefined>,
  key: string,
  fallback: 'serialize' | 'reject',
): 'serialize' | 'reject' {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'serialize' || raw === 'reject') return raw;
  throw new Error(`环境变量 ${key} 只能是 serialize 或 reject，实际为 "${raw}"`);
}

/** 合并 .env 文件与显式传入的环境变量（后者优先），产出类型安全的配置 */
export function loadEnv(
  overrides: Record<string, string | undefined> = {},
  envFilePath = resolve(process.cwd(), '.env'),
): AppEnv {
  const merged = { ...readDotEnvFile(envFilePath), ...process.env, ...overrides };
  return {
    dbPath: readStr(merged, 'AGENTFLOW_DB_PATH', DEFAULTS.dbPath),
    logDir: readStr(merged, 'AGENTFLOW_LOG_DIR', DEFAULTS.logDir),
    workspaceDir: readStr(merged, 'AGENTFLOW_WORKSPACE_DIR', DEFAULTS.workspaceDir),
    configDir: readStr(merged, 'AGENTFLOW_CONFIG_DIR', DEFAULTS.configDir),
    workflowId: readStr(merged, 'AGENTFLOW_WORKFLOW', DEFAULTS.workflowId),
    host: readStr(merged, 'AGENTFLOW_HOST', DEFAULTS.host),
    port: readInt(merged, 'AGENTFLOW_PORT', DEFAULTS.port),
    maxPromptTokens: readInt(merged, 'AGENTFLOW_MAX_PROMPT_TOKENS', DEFAULTS.maxPromptTokens),
    globalConcurrency: readInt(merged, 'AGENTFLOW_GLOBAL_CONCURRENCY', DEFAULTS.globalConcurrency),
    batchConflictPolicy: readConflictPolicy(
      merged,
      'AGENTFLOW_BATCH_CONFLICT_POLICY',
      DEFAULTS.batchConflictPolicy,
    ),
    nodeStallTimeoutMs: readNonNegInt(
      merged,
      'AGENTFLOW_NODE_STALL_TIMEOUT_MS',
      DEFAULTS.nodeStallTimeoutMs,
    ),
    claudeBin: readStr(merged, 'AGENTFLOW_CLAUDE_BIN', DEFAULTS.claudeBin),
    codexBin: readStr(merged, 'AGENTFLOW_CODEX_BIN', DEFAULTS.codexBin),
  };
}