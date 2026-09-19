import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyResultLine, isStructuredOutputRetriesExhausted, parseStreamLine } from './claude-code-runner.js';

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

  it('真实归档样本：结构化输出重试耗尽必须被识别为「需降级重试」，既不是普通成功也不是普通失败', () => {
    // 逐字取自 2026-09-19 一次真实失败任务（logs/runs/run_46e7a5442100440da2ac.jsonl 的 result 行）。
    // 事实：5 次 StructuredOutput 工具调用每次都返回 "provided successfully"、键集合完全合规，
    // CLI 仍以 error_max_structured_output_retries 收场 → 零产出（result: undefined，$0.417）。
    // 这是 schema 通道的失败模式：必须由 runner 降级重试兜底，而不是当成普通成功/普通失败。
    const raw = readFileSync(
      resolve(import.meta.dirname, '../../tests/fixtures/claude-stream-maxretries-sample.jsonl'),
      'utf8',
    );
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    const resultLine = lines[0]!;

    const sample = JSON.parse(resultLine) as {
      subtype?: unknown;
      is_error?: unknown;
      errors?: unknown;
      result?: unknown;
    };
    // 前提守卫：期望值从样本自身推导，不写死
    expect(sample.subtype).toBe('error_max_structured_output_retries');
    expect(sample.is_error).toBe(true);
    expect(sample.result).toBeUndefined();
    expect(sample.errors).toEqual(['Failed to provide valid structured output after 5 attempts']);

    // 核心契约：必须被识别为需要降级重试
    expect(isStructuredOutputRetriesExhausted(resultLine)).toBe(true);

    // 解析层本身仍按 is_error 判失败（不产出 artifact）——降级由 runner 层负责
    const events = parseStreamLine(resultLine);
    expect(events.some((e) => e.kind === 'artifact')).toBe(false);
    expect(events.some((e) => e.kind === 'log')).toBe(true);
  });

  it('其他归档样本不得被误判为「需降级重试」', () => {
    for (const name of [
      'claude-stream-sample.jsonl',
      'claude-stream-structured-sample.jsonl',
      'claude-stream-plain-sample.jsonl',
    ]) {
      const raw = readFileSync(resolve(import.meta.dirname, `../../tests/fixtures/${name}`), 'utf8');
      for (const line of raw.split('\n').filter((l) => l.trim() !== '')) {
        expect(isStructuredOutputRetriesExhausted(line), `${name} 被误判`).toBe(false);
      }
    }
  });
});

describe('失败原因分类（Task 3）：subtype → 稳定枚举', () => {
  function fixtureLines(name: string): string[] {
    return readFileSync(resolve(import.meta.dirname, `../../tests/fixtures/${name}`), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
  }

  it('真实归档的重试耗尽样本被分类为 structured_output_retries_exhausted（与降级判据同源）', () => {
    const line = fixtureLines('claude-stream-maxretries-sample.jsonl')[0]!;
    expect(classifyResultLine(line)).toBe('structured_output_retries_exhausted');
  });

  it('真实归档的认证失败样本不属于任何已知 subtype，归入 null（内核侧落 other）', () => {
    const line = fixtureLines('claude-stream-sample.jsonl')[0]!;
    expect(JSON.parse(line).is_error).toBe(true);
    expect(classifyResultLine(line)).toBeNull();
  });

  it('非失败行（成功样本）不产生分类', () => {
    for (const name of ['claude-stream-plain-sample.jsonl', 'claude-stream-structured-sample.jsonl']) {
      for (const line of fixtureLines(name)) {
        expect(classifyResultLine(line)).toBeNull();
      }
    }
  });

  it('permission_denials 非空时分类为 permission_denied（判据取自 CLI 真实字段）', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: '部分完成',
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }],
    });
    expect(classifyResultLine(line)).toBe('permission_denied');
  });

  it('is_error 行同时产出「原始文本日志」与「已分类的失败信号」——原文不丢', () => {
    const line = fixtureLines('claude-stream-maxretries-sample.jsonl')[0]!;
    const events = parseStreamLine(line);
    expect(events.some((e) => e.kind === 'log' && e.chunk.includes('error_max_structured_output_retries'))).toBe(true);
    expect(events.find((e) => e.kind === 'failure')).toEqual({
      kind: 'failure',
      reason: 'structured_output_retries_exhausted',
      detail: expect.stringContaining('subtype=error_max_structured_output_retries'),
    });
  });
});