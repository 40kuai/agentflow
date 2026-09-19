import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

// 这些测试必须与真实 .env 隔离：显式传入一个不存在的 env 文件路径，
// 否则开发者一旦创建了 .env，默认值断言就会失败。
const NO_ENV_FILE = '/nonexistent/agentflow-test.env';

describe('loadEnv', () => {
  it('未提供环境变量时使用默认值', () => {
    const env = loadEnv({}, NO_ENV_FILE);
    expect(env.host).toBe('127.0.0.1');
    expect(env.port).toBe(8787);
    expect(env.maxPromptTokens).toBe(30000);
    expect(env.globalConcurrency).toBe(4);
    expect(env.dbPath).toBe('./data/agentflow.sqlite');
  });

  it('环境变量覆盖默认值，且端口被解析为数字', () => {
    const env = loadEnv(
      { AGENTFLOW_PORT: '9999', AGENTFLOW_DB_PATH: '/tmp/x.sqlite' },
      NO_ENV_FILE,
    );
    expect(env.port).toBe(9999);
    expect(env.dbPath).toBe('/tmp/x.sqlite');
  });

  it('端口非法时抛错', () => {
    expect(() => loadEnv({ AGENTFLOW_PORT: 'abc' }, NO_ENV_FILE)).toThrow(/AGENTFLOW_PORT/);
  });

  it('env 文件不存在时静默使用默认值，不抛错', () => {
    expect(() => loadEnv({}, '/nonexistent/definitely-missing.env')).not.toThrow();
  });

  it('批次冲突策略默认 serialize，可由环境变量指定为 reject', () => {
    expect(loadEnv({}, NO_ENV_FILE).batchConflictPolicy).toBe('serialize');
    expect(
      loadEnv({ AGENTFLOW_BATCH_CONFLICT_POLICY: 'reject' }, NO_ENV_FILE).batchConflictPolicy,
    ).toBe('reject');
  });

  it('批次冲突策略非法时显式报错，不静默回退', () => {
    expect(() => loadEnv({ AGENTFLOW_BATCH_CONFLICT_POLICY: 'parallel' }, NO_ENV_FILE)).toThrow(
      /AGENTFLOW_BATCH_CONFLICT_POLICY/,
    );
  });
});