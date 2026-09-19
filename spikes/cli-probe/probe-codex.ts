import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(import.meta.dirname, 'out');
mkdirSync(outDir, { recursive: true });

const prompt = [
  '请读取当前目录下的 package.json，然后用 JSON 输出：',
  '{"summary": "<一句话说明项目配置了什么>", "files_read": ["<文件名>"]}',
  '只输出 JSON，不要输出任何其他文字。',
].join('\n');

const args = ['exec', '-s', 'read-only', '-C', process.cwd(), prompt];

const startedAt = Date.now();
const child = spawn('codex', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

const stdout: Buffer[] = [];
const stderr: Buffer[] = [];
child.stdout.on('data', (c: Buffer) => stdout.push(c));
child.stderr.on('data', (c: Buffer) => stderr.push(c));

child.on('close', (code) => {
  writeFileSync(resolve(outDir, 'codex.txt'), Buffer.concat(stdout));
  writeFileSync(resolve(outDir, 'codex-stderr.txt'), Buffer.concat(stderr));
  writeFileSync(
    resolve(outDir, 'meta-codex.json'),
    JSON.stringify({ exitCode: code, durationMs: Date.now() - startedAt, args }, null, 2),
  );
  console.log(`codex 探针结束，exitCode=${code}，耗时 ${Date.now() - startedAt}ms`);
});