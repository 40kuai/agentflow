import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStreamLine } from './claude-code-runner.js';

describe('claude stream-json 契约回归', () => {
  it('真实归档样本的每一行都能被解析，且 result 行的处理与 is_error 一致', () => {
    const raw = readFileSync(
      resolve(import.meta.dirname, '../../tests/fixtures/claude-stream-sample.jsonl'),
      'utf8',
    );
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);

    // 每一行都必须能被解析且不抛错（解析层不做字段白名单，未知字段一律容忍）
    let sawUsage = false;
    const kinds: string[] = [];
    for (const line of lines) {
      for (const e of parseStreamLine(line)) {
        kinds.push(e.kind);
        if (e.kind === 'usage') sawUsage = true;
      }
    }

    expect(sawUsage).toBe(true);

    // 归档样本是 claude 额度耗尽时的认证失败 result（is_error: true）。
    // 期望值从样本自身推导，而不是写死——这样将来补录到成功样本时本测试依然正确。
    const resultLine = lines.find((l) => {
      try {
        return (JSON.parse(l) as { type?: unknown }).type === 'result';
      } catch {
        return false;
      }
    });
    expect(resultLine).toBeDefined();

    const resultObj = JSON.parse(resultLine!) as { is_error?: unknown };

    if (resultObj.is_error === true) {
      expect(kinds).not.toContain('artifact');
      expect(kinds).toContain('log');
    } else {
      expect(kinds).toContain('artifact');
    }
  });

  it('带 --json-schema 的真实成功样本：artifact 与样本自身的 structured_output 逐字相等', () => {
    // 样本逐字取自 2026-09-18 凭据恢复后的真实调用（createClaudeCodeRunner + useJsonSchema 默认开启），
    // 这是**生产路径**的形状：结构化对象在 structured_output。本样本的 result 实测是 ```json 代码块
    // （result 形状不固定，散文/代码块都出现过），故断言只依赖 structured_output。
    const raw = readFileSync(
      resolve(import.meta.dirname, '../../tests/fixtures/claude-stream-structured-sample.jsonl'),
      'utf8',
    );
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const resultLine = lines.find(
      (l) => (JSON.parse(l) as { type?: unknown }).type === 'result',
    );
    expect(resultLine).toBeDefined();

    const sample = JSON.parse(resultLine!) as {
      is_error: unknown;
      structured_output: unknown;
      result: unknown;
    };
    // 前提守卫：样本须为成功，且 result 为字符串、structured_output 为对象（**不校验 result 是否散文**）
    expect(sample.is_error).toBe(false);
    expect(typeof sample.result).toBe('string');
    expect(typeof sample.structured_output).toBe('object');

    const events = parseStreamLine(resultLine!);
    expect(events).toContainEqual({ kind: 'artifact', raw: sample.structured_output });
    // 反向确认：解析层没有被散文 result 带偏（旧实现会走到「无法解析」分支）
    const artifact = events.find((e) => e.kind === 'artifact');
    if (artifact && artifact.kind === 'artifact') {
      expect(artifact.raw).not.toBe(sample.result);
    }
  });
});