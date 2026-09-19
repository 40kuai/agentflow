import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(import.meta.dirname, 'out');
mkdirSync(outDir, { recursive: true });

// 探针要验证的核心问题：在有工具调用（Read/Grep）的场景下，
// --json-schema 是否仍能稳定返回符合 schema 的最终结构
const schema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files_read: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files_read'],
  additionalProperties: false,
};

const prompt = [
  '请先读取当前目录下的 package.json，再读取 tsconfig.json。',
  '然后返回结构化结果：',
  '- summary：一句话说明这个项目配置了什么',
  '- files_read：你实际读取过的文件名列表',
].join('\n');

const args = [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--json-schema', JSON.stringify(schema),
  '--max-budget-usd', '0.50',
  '--tools=Read,Grep,Glob',
];

const startedAt = Date.now();
const child = spawn('claude', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

const stdout: Buffer[] = [];
const stderr: Buffer[] = [];
child.stdout.on('data', (c: Buffer) => stdout.push(c));
child.stderr.on('data', (c: Buffer) => stderr.push(c));

child.on('close', (code) => {
  writeFileSync(resolve(outDir, 'claude-stream.jsonl'), Buffer.concat(stdout));
  writeFileSync(resolve(outDir, 'claude-stderr.txt'), Buffer.concat(stderr));
  writeFileSync(
    resolve(outDir, 'meta.json'),
    JSON.stringify({ exitCode: code, durationMs: Date.now() - startedAt, args }, null, 2),
  );
  console.log(`claude 探针结束，exitCode=${code}，耗时 ${Date.now() - startedAt}ms`);
});