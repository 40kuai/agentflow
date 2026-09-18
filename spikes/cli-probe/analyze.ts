import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(import.meta.dirname, 'out');

function analyzeClaude(): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(outDir, 'claude-stream.jsonl'), 'utf8');
  } catch {
    console.log('[claude] 未找到输出文件，请先运行 probe-claude.ts');
    return;
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const histogram = new Map<string, number>();
  const keysByType = new Map<string, Set<string>>();
  let parseFailures = 0;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const type = String(obj.type ?? '<no-type>');
      histogram.set(type, (histogram.get(type) ?? 0) + 1);
      const bucket = keysByType.get(type) ?? new Set<string>();
      for (const k of Object.keys(obj)) bucket.add(k);
      keysByType.set(type, bucket);
    } catch {
      parseFailures += 1;
    }
  }

  console.log(`[claude] 总行数=${lines.length}，JSON 解析失败=${parseFailures}`);
  console.log('[claude] 事件类型直方图：');
  for (const [type, count] of [...histogram.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type} × ${count}  keys=[${[...(keysByType.get(type) ?? [])].join(', ')}]`);
  }
  console.log('[claude] 结论要点：');
  console.log('  1) 是否存在 type=result 的最终事件？其内的 structured_output / result 字段是什么？');
  console.log('  2) usage 是否在流中出现？出现在哪个事件里？');
  console.log('  3) session_id 出现在哪条事件？可否用于 --resume？');
}

function analyzeCodex(): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(outDir, 'codex.txt'), 'utf8');
  } catch {
    console.log('[codex] 未找到输出文件，请先运行 probe-codex.ts');
    return;
  }
  console.log(`[codex] 输出总长度=${raw.length} 字符`);
  const jsonBlocks = raw.match(/\{[\s\S]*\}/g);
  console.log(`[codex] 可提取的 JSON 候选块数量=${jsonBlocks?.length ?? 0}`);
  if (jsonBlocks?.[0]) {
    try {
      JSON.parse(jsonBlocks[0]);
      console.log('[codex] 第一个候选块可被 JSON.parse 解析');
    } catch {
      console.log('[codex] 第一个候选块无法被 JSON.parse 解析（说明需要更宽松的提取策略）');
    }
  }
  console.log('[codex] 输出前 40 行预览：');
  console.log(raw.split('\n').slice(0, 40).join('\n'));
}

analyzeClaude();
analyzeCodex();