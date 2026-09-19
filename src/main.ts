import { resolve } from 'node:path';
import { loadEnv } from './config/env.js';
import { loadAllRoles, loadWorkflow } from './config/loader.js';
import { createEventStore } from './kernel/event-store.js';
import { createKernel } from './kernel/kernel.js';
import { createClaudeCodeRunner } from './runner/claude-code-runner.js';
import { createServer } from './server/server.js';

const env = loadEnv();

const roles = loadAllRoles(env.configDir);
const workflow = loadWorkflow(env.configDir, 'simple_dev');
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