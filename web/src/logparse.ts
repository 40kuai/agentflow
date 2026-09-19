/**
 * claude CLI 日志解析。
 *
 * 日志文件（logs/runs/<runId>.jsonl）每行是**外层包装**：
 *   { ts, kind: 'spawn' | 'stdout' | 'stderr' | 'timeout', chunk?, args?, cwd?, wallTimeMs? }
 * `chunk` 里才是真正的 stream-json 行，且**一个 chunk 可能包含多行**（CLI 按数据块写入）。
 * 因此解析必须两步走：先解析外层，再按 \n 拆 chunk、逐行解析内层。
 * 任何一步解析失败都优雅降级为纯文本，绝不抛错——日志是诊断的最后凭据，不能因为一行脏数据整页白屏。
 */

import { asNumber, asRecord, asString } from './format';
import type { KernelEvent } from './api';

export type OuterKind = 'spawn' | 'stdout' | 'stderr' | 'timeout' | 'unknown';

export type InnerKind =
  | 'assistant'
  | 'user'
  | 'system'
  | 'result'
  | 'stream_event'
  | 'spawn'
  | 'stderr'
  | 'timeout'
  | 'plain'
  | 'other';

/** 一条外层原始行（原始视图按此渲染，保留行号） */
export type RawLogLine = {
  /** 全局行号（1-based，相对整个文件而非本次 tail 窗口） */
  lineNo: number;
  kind: OuterKind;
  ts: number | null;
  text: string;
};

/** 一条内层 stream-json 条目（或降级后的纯文本） */
export type InnerEntry = {
  lineNo: number;
  ts: number | null;
  outerKind: OuterKind;
  kind: InnerKind;
  /** 内层 JSON 的 type 字段 */
  type: string | null;
  json: Record<string, unknown> | null;
  /** 纯文本 / stderr 内容（json 为 null 时使用） */
  text: string;
};

export type ParsedLog = {
  rawLines: RawLogLine[];
  entries: InnerEntry[];
  /** 内层解析失败的行数（降级为纯文本） */
  parseFailures: number;
};

export type ToolUseBlock = { name: string; input: unknown; id: string };

export type ResultInfo = {
  subtype: string;
  isError: boolean;
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  permissionDenials: unknown[];
  resultText: string | null;
  errors: string[];
};

export type ConvBlock =
  | { kind: 'assistant_text'; text: string; lineNo: number }
  | { kind: 'thinking'; text: string; lineNo: number }
  | { kind: 'tool_use'; tool: ToolUseBlock; lineNo: number }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean; lineNo: number }
  | { kind: 'user_text'; text: string; lineNo: number }
  | { kind: 'system'; text: string; json: Record<string, unknown>; lineNo: number }
  | { kind: 'result'; info: ResultInfo; lineNo: number }
  | { kind: 'spawn'; args: string[]; cwd: string; lineNo: number }
  | { kind: 'stderr'; text: string; lineNo: number }
  | { kind: 'timeout'; wallTimeMs: number | null; lineNo: number }
  | { kind: 'other'; type: string | null; json: Record<string, unknown> | null; text: string; lineNo: number };

export type Conversation = {
  blocks: ConvBlock[];
  /** 被折叠的 stream_event 增量事件条数（一次对话可达上万条，全部渲染会拖垮页面） */
  skippedStreamEvents: number;
};

/** 解析内层 stream-json 的 type → InnerKind */
function innerKindOf(type: string | null): InnerKind {
  switch (type) {
    case 'assistant':
      return 'assistant';
    case 'user':
      return 'user';
    case 'system':
      return 'system';
    case 'result':
      return 'result';
    case 'stream_event':
      return 'stream_event';
    default:
      return 'other';
  }
}

/**
 * 解析日志行。startLineNo 用于把 tail 窗口内的行号还原成全局行号。
 */
export function parseLogLines(lines: string[], startLineNo: number): ParsedLog {
  const rawLines: RawLogLine[] = [];
  const entries: InnerEntry[] = [];
  let parseFailures = 0;

  lines.forEach((line, index) => {
    const lineNo = startLineNo + index;
    let outer = asRecord(parseJson(line));

    if (!outer) {
      rawLines.push({ lineNo, kind: 'unknown', ts: null, text: line });
      entries.push({
        lineNo,
        ts: null,
        outerKind: 'unknown',
        kind: 'plain',
        type: null,
        json: null,
        text: line,
      });
      parseFailures += 1;
      return;
    }

    const rawKind = asString(outer['kind'], 'unknown');
    const kind: OuterKind =
      rawKind === 'spawn' || rawKind === 'stdout' || rawKind === 'stderr' || rawKind === 'timeout'
        ? rawKind
        : 'unknown';
    const ts = typeof outer['ts'] === 'number' ? (outer['ts'] as number) : null;
    rawLines.push({ lineNo, kind, ts, text: line });

    const chunk = outer['chunk'];

    if (kind === 'spawn') {
      entries.push({ lineNo, ts, outerKind: kind, kind: 'spawn', type: null, json: outer, text: '' });
      return;
    }
    if (kind === 'timeout') {
      entries.push({ lineNo, ts, outerKind: kind, kind: 'timeout', type: null, json: outer, text: '' });
      return;
    }
    if (kind === 'stderr') {
      const text = typeof chunk === 'string' ? chunk.replace(/\n+$/, '') : '';
      for (const part of splitNonEmpty(text)) {
        entries.push({ lineNo, ts, outerKind: kind, kind: 'stderr', type: null, json: null, text: part });
      }
      return;
    }
    if (kind === 'stdout' && typeof chunk === 'string') {
      for (const part of splitNonEmpty(chunk)) {
        const parsed = asRecord(parseJson(part));
        if (!parsed) {
          entries.push({
            lineNo,
            ts,
            outerKind: kind,
            kind: 'plain',
            type: null,
            json: null,
            text: part,
          });
          parseFailures += 1;
          continue;
        }
        const type = typeof parsed['type'] === 'string' ? (parsed['type'] as string) : null;
        entries.push({
          lineNo,
          ts,
          outerKind: kind,
          kind: innerKindOf(type),
          type,
          json: parsed,
          text: '',
        });
      }
      return;
    }

    // 外层结构可解析但 chunk 缺失（或 kind 未知）：当纯文本兜底
    const text = typeof chunk === 'string' ? chunk : line;
    entries.push({ lineNo, ts, outerKind: kind, kind: 'plain', type: null, json: null, text });
  });

  return { rawLines, entries, parseFailures };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function splitNonEmpty(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.replace(/\r$/, ''))
    .filter((s) => s.trim() !== '');
}

/** tool_result 的 content 可能是字符串、结构化块数组或任意对象，统一归一为可读文本 */
function normalizeResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        const record = asRecord(block);
        if (record && typeof record['text'] === 'string') return record['text'] as string;
        return safeStringify(block);
      })
      .join('\n');
  }
  return safeStringify(content);
}

export function safeStringify(value: unknown, space = 2): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, space) ?? String(value);
  } catch {
    return String(value);
  }
}

function buildResultInfo(json: Record<string, unknown>): ResultInfo {
  const rawResult = json['result'];
  const denials = json['permission_denials'];
  const errors = json['errors'];
  return {
    subtype: asString(json['subtype'], 'unknown'),
    isError: json['is_error'] === true,
    numTurns: typeof json['num_turns'] === 'number' ? (json['num_turns'] as number) : null,
    durationMs: typeof json['duration_ms'] === 'number' ? (json['duration_ms'] as number) : null,
    costUsd: typeof json['total_cost_usd'] === 'number' ? (json['total_cost_usd'] as number) : null,
    permissionDenials: Array.isArray(denials) ? denials : [],
    resultText:
      typeof rawResult === 'string'
        ? rawResult
        : rawResult === null || rawResult === undefined
          ? null
          : safeStringify(rawResult),
    errors: Array.isArray(errors) ? errors.filter((e): e is string => typeof e === 'string') : [],
  };
}

/** 把内层条目还原成可读的对话轨迹 */
export function buildConversation(entries: InnerEntry[]): Conversation {
  const blocks: ConvBlock[] = [];
  let skippedStreamEvents = 0;

  for (const entry of entries) {
    if (entry.kind === 'stream_event') {
      skippedStreamEvents += 1;
      continue;
    }
    if (entry.kind === 'spawn') {
      const args = Array.isArray(entry.json?.['args'])
        ? (entry.json?.['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
        : [];
      blocks.push({
        kind: 'spawn',
        args,
        cwd: asString(entry.json?.['cwd']),
        lineNo: entry.lineNo,
      });
      continue;
    }
    if (entry.kind === 'timeout') {
      blocks.push({
        kind: 'timeout',
        wallTimeMs: typeof entry.json?.['wallTimeMs'] === 'number' ? (entry.json['wallTimeMs'] as number) : null,
        lineNo: entry.lineNo,
      });
      continue;
    }
    if (entry.kind === 'stderr') {
      blocks.push({ kind: 'stderr', text: entry.text, lineNo: entry.lineNo });
      continue;
    }
    if (entry.kind === 'plain') {
      blocks.push({
        kind: 'other',
        type: null,
        json: null,
        text: entry.text,
        lineNo: entry.lineNo,
      });
      continue;
    }

    const json = entry.json;
    if (!json) {
      blocks.push({ kind: 'other', type: entry.type, json: null, text: entry.text, lineNo: entry.lineNo });
      continue;
    }

    if (entry.kind === 'system') {
      const tools = Array.isArray(json['tools'])
        ? (json['tools'] as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      const parts = [`init · 模型 ${asString(json['model'], '未知')} · 权限模式 ${asString(json['permissionMode'], '未知')}`];
      if (tools.length > 0) parts.push(`可用工具：${tools.join(', ')}`);
      const mcp = json['mcp_servers'];
      if (Array.isArray(mcp) && mcp.length > 0) {
        const names = mcp
          .map((m) => {
            const r = asRecord(m);
            return r ? `${asString(r['name'], '?')}(${asString(r['status'], '?')})` : '?';
          })
          .join(', ');
        parts.push(`MCP：${names}`);
      }
      blocks.push({
        kind: 'system',
        text: parts.join(' · '),
        json,
        lineNo: entry.lineNo,
      });
      continue;
    }

    if (entry.kind === 'result') {
      blocks.push({ kind: 'result', info: buildResultInfo(json), lineNo: entry.lineNo });
      continue;
    }

    if (entry.kind === 'assistant' || entry.kind === 'user') {
      const message = asRecord(json['message']);
      const content = message?.['content'];
      if (typeof content === 'string') {
        blocks.push({ kind: 'user_text', text: content, lineNo: entry.lineNo });
        continue;
      }
      if (!Array.isArray(content)) {
        blocks.push({ kind: 'other', type: entry.type, json, text: '', lineNo: entry.lineNo });
        continue;
      }
      for (const rawBlock of content) {
        const block = asRecord(rawBlock);
        if (!block) continue;
        const blockType = asString(block['type']);
        if (blockType === 'text') {
          blocks.push({
            kind: 'assistant_text',
            text: asString(block['text']),
            lineNo: entry.lineNo,
          });
        } else if (blockType === 'thinking') {
          blocks.push({
            kind: 'thinking',
            text: asString(block['thinking']),
            lineNo: entry.lineNo,
          });
        } else if (blockType === 'tool_use') {
          blocks.push({
            kind: 'tool_use',
            tool: {
              name: asString(block['name'], '未知工具'),
              input: block['input'],
              id: asString(block['id']),
            },
            lineNo: entry.lineNo,
          });
        } else if (blockType === 'tool_result') {
          blocks.push({
            kind: 'tool_result',
            toolUseId: asString(block['tool_use_id']),
            content: normalizeResultContent(block['content']),
            isError: block['is_error'] === true,
            lineNo: entry.lineNo,
          });
        } else {
          blocks.push({
            kind: 'other',
            type: blockType || entry.type,
            json: block,
            text: '',
            lineNo: entry.lineNo,
          });
        }
      }
      continue;
    }

    blocks.push({ kind: 'other', type: entry.type, json, text: entry.text, lineNo: entry.lineNo });
  }

  return { blocks, skippedStreamEvents };
}

// ---------------------------------------------------------------------------
// 诊断扫描
// ---------------------------------------------------------------------------

export type SignalSeverity = 'error' | 'warn' | 'info' | 'ok';

export type DiagnosticSignal = {
  id: string;
  label: string;
  severity: SignalSeverity;
  count: number;
  /** 命中的全局行号（去重、升序），供点击跳转 */
  lineNos: number[];
  detail: string;
};

export type LogDiagnostics = {
  signals: DiagnosticSignal[];
  toolCounts: { name: string; count: number }[];
  result: ResultInfo | null;
  skippedStreamEvents: number;
  totalEntries: number;
  parseFailures: number;
};

/** 权限被拒的 CLI 原文（本项目实测在工具返回里反复出现） */
const APPROVAL_PATTERN = /requires approval/i;
const ERROR_KEYWORD_PATTERN = /(error|failed|失败|错误)/i;

export function scanDiagnostics(parsed: ParsedLog): LogDiagnostics {
  const { entries, rawLines, parseFailures } = parsed;
  const approvalLines = new Set<number>();
  const toolErrorLines = new Set<number>();
  const stderrLines = new Set<number>();
  const timeoutLines = new Set<number>();
  const errorKeywordLines = new Set<number>();
  const isErrorLines = new Set<number>();
  const toolCounts = new Map<string, number>();
  let resultInfo: ResultInfo | null = null;
  let skippedStreamEvents = 0;

  for (const entry of entries) {
    if (entry.kind === 'stream_event') {
      skippedStreamEvents += 1;
      continue;
    }

    if (entry.kind === 'result' && entry.json) {
      const info = buildResultInfo(entry.json);
      // 保留最后一条 result（终局）
      resultInfo = info;
      if (info.isError) isErrorLines.add(entry.lineNo);
      if (info.permissionDenials.length > 0) isErrorLines.add(entry.lineNo);
      continue;
    }

    if (entry.kind === 'timeout') {
      timeoutLines.add(entry.lineNo);
      continue;
    }

    if (entry.kind === 'stderr' && entry.text.trim() !== '') {
      stderrLines.add(entry.lineNo);
    }

    if (entry.kind === 'assistant' && entry.json) {
      const message = asRecord(entry.json['message']);
      const content = message?.['content'];
      if (Array.isArray(content)) {
        for (const rawBlock of content) {
          const block = asRecord(rawBlock);
          if (block && block['type'] === 'tool_use') {
            const name = asString(block['name'], '未知工具');
            toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
          }
        }
      }
      continue;
    }

    if (entry.kind === 'user' && entry.json) {
      const message = asRecord(entry.json['message']);
      const content = message?.['content'];
      if (Array.isArray(content)) {
        for (const rawBlock of content) {
          const block = asRecord(rawBlock);
          if (!block || block['type'] !== 'tool_result') continue;
          if (block['is_error'] === true) toolErrorLines.add(entry.lineNo);
          const text = normalizeResultContent(block['content']);
          if (APPROVAL_PATTERN.test(text)) approvalLines.add(entry.lineNo);
        }
      }
      continue;
    }

    if (entry.kind === 'other' && entry.json && APPROVAL_PATTERN.test(safeStringify(entry.json, 0))) {
      approvalLines.add(entry.lineNo);
    }
  }

  // 原始行级别的扫描：覆盖不构成 stream-json 的文本（stderr / 降级行 / result 的 JSON 原文）
  for (const line of rawLines) {
    if (APPROVAL_PATTERN.test(line.text)) approvalLines.add(line.lineNo);
    if (/"is_error"\s*:\s*true/.test(line.text)) isErrorLines.add(line.lineNo);
    if (ERROR_KEYWORD_PATTERN.test(line.text) && line.kind !== 'spawn') {
      // 仅在外层不是纯 stdout 大块时记录，避免整块 JSON 噪音；仍作为弱信号
      errorKeywordLines.add(line.lineNo);
    }
  }

  const signals: DiagnosticSignal[] = [];

  signals.push({
    id: 'approval',
    label: '权限被拒（This command requires approval）',
    severity: approvalLines.size > 0 ? 'error' : 'ok',
    count: approvalLines.size,
    lineNos: [...approvalLines].sort((a, b) => a - b),
    detail:
      approvalLines.size > 0
        ? 'CLI 因权限模式拒绝了工具调用；这会让模型拿不到文件内容、进而反复重试甚至判定 blocked'
        : '未发现权限拒绝',
  });

  const subtypeEntries = entries.filter((e) => e.kind === 'result');
  const subtypes = subtypeEntries
    .map((e) => asString(e.json?.['subtype'], 'unknown'))
    .filter((s) => s !== 'unknown');
  const retriesExhausted = subtypes.filter((s) => s === 'error_max_structured_output_retries');
  signals.push({
    id: 'subtype',
    label: 'result.subtype',
    severity: retriesExhausted.length > 0 ? 'error' : subtypes.length > 0 ? 'info' : 'ok',
    // count 与 detail 口径对齐：都按"出现过的 subtype 次数"统计（此前只计 max-retries 子型，导致 count=0 但 detail 写"出现过 success"）
    count: subtypes.length,
    lineNos: subtypeEntries
      .filter((e) => asString(e.json?.['subtype'], 'unknown') !== 'unknown')
      .map((e) => e.lineNo),
    detail:
      subtypes.length > 0
        ? `出现过的 subtype（${subtypes.length} 条 result 行）：${[...new Set(subtypes)].join(', ')}`
        : '未出现 result 行',
  });

  signals.push({
    id: 'is_error',
    label: 'is_error: true',
    severity: isErrorLines.size > 0 ? 'error' : 'ok',
    count: isErrorLines.size,
    lineNos: [...isErrorLines].sort((a, b) => a - b),
    detail: '包含 result.is_error=true 与 tool_result.is_error=true 的行',
  });

  const denialCount = resultInfo?.permissionDenials.length ?? 0;
  signals.push({
    id: 'permission_denials',
    label: 'permission_denials 非空',
    severity: denialCount > 0 ? 'error' : 'ok',
    count: denialCount,
    lineNos: resultInfo && denialCount > 0 ? entries.filter((e) => e.kind === 'result').map((e) => e.lineNo) : [],
    detail: denialCount > 0 ? safeStringify(resultInfo?.permissionDenials, 0) : 'permission_denials 为空',
  });

  signals.push({
    id: 'tool_error',
    label: '工具返回 is_error',
    severity: toolErrorLines.size > 0 ? 'warn' : 'ok',
    count: toolErrorLines.size,
    lineNos: [...toolErrorLines].sort((a, b) => a - b),
    detail: 'tool_result 显式标记为错误',
  });

  signals.push({
    id: 'stderr',
    label: 'stderr 输出',
    severity: stderrLines.size > 0 ? 'warn' : 'ok',
    count: stderrLines.size,
    lineNos: [...stderrLines].sort((a, b) => a - b),
    detail: 'CLI 标准错误输出',
  });

  signals.push({
    id: 'timeout',
    label: 'wall-clock 超时',
    severity: timeoutLines.size > 0 ? 'error' : 'ok',
    count: timeoutLines.size,
    lineNos: [...timeoutLines].sort((a, b) => a - b),
    detail: '运行器强制终止标记（kind=timeout）',
  });

  signals.push({
    id: 'error_keyword',
    label: '含 error / 失败 字样的行',
    severity: 'info',
    count: errorKeywordLines.size,
    lineNos: [...errorKeywordLines].sort((a, b) => a - b),
    detail: '弱信号，仅供缩小排查范围',
  });

  signals.push({
    id: 'parse_failures',
    label: '解析失败（降级为纯文本）',
    severity: parseFailures > 0 ? 'info' : 'ok',
    count: parseFailures,
    lineNos: [],
    detail: '外层或内层 JSON 解析失败的行数',
  });

  return {
    signals,
    toolCounts: [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    result: resultInfo,
    skippedStreamEvents,
    totalEntries: entries.length,
    parseFailures,
  };
}

// ---------------------------------------------------------------------------
// 事件流辅助（节点级花费 / 耗时归集共用）
// ---------------------------------------------------------------------------

/** 从事件 payload 中安全读出 run_id → node_id 映射（budget.consumed 只有 run_id，必须靠它反查节点） */
export function runIdToNodeId(events: KernelEvent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const event of events) {
    const payload = event.payload ?? {};
    const runId = asString(payload['run_id']);
    const nodeId = asString(payload['node_id']);
    if (runId && nodeId && !map.has(runId)) map.set(runId, nodeId);
  }
  return map;
}

/** 事件里的字符串字段安全读取（供 aggregate 复用） */
export function payloadString(payload: Record<string, unknown> | undefined, key: string): string {
  return payload ? asString(payload[key]) : '';
}

/** 事件里的数字字段安全读取 */
export function payloadNumber(payload: Record<string, unknown> | undefined, key: string): number {
  return payload ? asNumber(payload[key]) : 0;
}