import { resolve } from 'node:path';
import { loadEnv } from './config/env.js';
import { loadAllRoles, loadWorkflow } from './config/loader.js';
import { createEventStore } from './kernel/event-store.js';
import { createKernel } from './kernel/kernel.js';
import { createClaudeCodeRunner } from './runner/claude-code-runner.js';
import { createServer } from './server/server.js';

const env = loadEnv();

const roles = loadAllRoles(env.configDir);
const workflow = loadWorkflow(env.configDir, env.workflowId);
const store = createEventStore(resolve(env.dbPath));
const runner = createClaudeCodeRunner({
  binPath: env.claudeBin,
  logDir: resolve(env.logDir, 'runs'),
});

const kernel = createKernel({
  store,
  runner,
  workflow,
  roles,
  maxPromptTokens: env.maxPromptTokens,
  workspaceRoot: resolve(env.workspaceDir),
  logDir: resolve(env.logDir),
  repoPath: process.cwd(),
  // 事件库路径注入内核：用于在 `owns` 越界核对时排除平台自身的事件库目录（默认 ./data/）
  dbPath: resolve(env.dbPath),
  maxSteps: 50,
  batchConflictPolicy: env.batchConflictPolicy,
  globalConcurrency: env.globalConcurrency,
});

const server = createServer({
  kernel,
  store,
  logDir: resolve(env.logDir),
  host: env.host,
  port: env.port,
  // 角色查询/编辑 API 的数据源（配置文件）与流转视图的拓扑来源（内核实际使用的工作流/角色）
  configDir: resolve(env.configDir),
  workflow,
  roles,
});

await server.app.listen({ host: env.host, port: env.port });
console.log(`AgentFlow 已启动：http://${env.host}:${env.port}`);

const shutdown = async (): Promise<void> => {
  await server.close();
  store.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());