import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type AppEnv = {
  dbPath: string;
  logDir: string;
  workspaceDir: string;
  configDir: string;
  host: string;
  port: number;
  maxPromptTokens: number;
  globalConcurrency: number;
  /**
   * 并行批次内 `owns` 路径重叠时的处理策略：serialize=改为串行；reject=拒绝该批次。
   * 由环境变量 `AGENTFLOW_BATCH_CONFLICT_POLICY` 指定（默认 serialize）。
   */
  batchConflictPolicy: 'serialize' | 'reject';
  claudeBin: string;
  codexBin: string;
};

const DEFAULTS: AppEnv = {
  dbPath: './data/agentflow.sqlite',
  logDir: './logs',
  workspaceDir: './workspaces',
  configDir: './config',
  host: '127.0.0.1',
  port: 8787,
  maxPromptTokens: 30000,
  globalConcurrency: 4,
  batchConflictPolicy: 'serialize',
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
    host: readStr(merged, 'AGENTFLOW_HOST', DEFAULTS.host),
    port: readInt(merged, 'AGENTFLOW_PORT', DEFAULTS.port),
    maxPromptTokens: readInt(merged, 'AGENTFLOW_MAX_PROMPT_TOKENS', DEFAULTS.maxPromptTokens),
    globalConcurrency: readInt(merged, 'AGENTFLOW_GLOBAL_CONCURRENCY', DEFAULTS.globalConcurrency),
    batchConflictPolicy: readConflictPolicy(
      merged,
      'AGENTFLOW_BATCH_CONFLICT_POLICY',
      DEFAULTS.batchConflictPolicy,
    ),
    claudeBin: readStr(merged, 'AGENTFLOW_CLAUDE_BIN', DEFAULTS.claudeBin),
    codexBin: readStr(merged, 'AGENTFLOW_CODEX_BIN', DEFAULTS.codexBin),
  };
}