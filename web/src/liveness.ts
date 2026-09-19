/**
 * 运行中节点的活性诊断与任务级健康判定。
 *
 * 设计要点：
 *  - 「agent 是否还在干活」只能由真实数据回答：事件流给状态，日志文件的 mtime/size 给活性。
 *  - 解析一律容错：日志里有 stream_event 噪音、脏行、被截断的 JSON，任何解析失败都不得抛错。
 *  - 能力探测：后端 /api/health 声明 features；缺少前端所需能力时明确提示「后端版本落后」，
 *    绝不再把日志端点的 404 抹平为「日志不存在」。
 */

import { ApiError, getNodeLog, getRunLog, type HealthInfo, type LogTail } from './api';
import { asRecord, formatDuration } from './format';
import { buildConversation, parseLogLines, type ConvBlock } from './logparse';

/** 疑似停滞阈值（ms）：日志文件超过该时长没有新写入即判定「疑似停滞」 */
export const STAGNANT_THRESHOLD_MS = 120_000;

/** 拉取活日志的窗口行数：足够解析出最近动作，又不至于每次轮询浪费流量 */
export const LIVENESS_TAIL = 200;

export const FEATURE_LOG_BY_NODE = 'log-by-node';
export const FEATURE_LOG_BY_RUN = 'log-by-run';
export const FEATURE_LIVE_STATS = 'live-stats';

/** 前端运行所必需的后端能力 */
const REQUIRED_FEATURES: readonly string[] = [
  FEATURE_LOG_BY_NODE,
  FEATURE_LOG_BY_RUN,
  FEATURE_LIVE_STATS,
];

/** 后端健康探测状态（由 App 持有并在每次轮询时更新） */
export type BackendHealth =
  | { status: 'unknown' }
  | { status: 'down'; error: string }
  | { status: 'ok'; info: HealthInfo };

export type BackendCompatibility = {
  /** unknown=尚未探测；down=不可达；ok=能力齐全；stale=可达但缺能力（版本落后） */
  kind: 'unknown' | 'down' | 'ok' | 'stale';
  /** stale 时缺失的能力列表 */
  missing: string[];
};

/** 后端是否具备前端所需能力。`features` 整段缺失（旧后端只返回 {ok:true}）视为全部缺失。 */
export function backendCompatibility(health: BackendHealth): BackendCompatibility {
  if (health.status === 'unknown') return { kind: 'unknown', missing: [] };
  if (health.status === 'down') return { kind: 'down', missing: [] };
  const features = health.info.features;
  if (!Array.isArray(features)) return { kind: 'stale', missing: [...REQUIRED_FEATURES] };
  const missing = REQUIRED_FEATURES.filter((feature) => !features.includes(feature));
  return missing.length > 0 ? { kind: 'stale', missing } : { kind: 'ok', missing: [] };
}

// ---------------------------------------------------------------------------
// 日志错误归类（F 项）
// ---------------------------------------------------------------------------

export type LogErrorInfo = { status: number | null; code: string | null; message: string };

export function toLogErrorInfo(err: unknown): LogErrorInfo {
  if (err instanceof ApiError) return { status: err.status, code: err.code, message: err.message };
  return { status: null, code: null, message: err instanceof Error ? err.message : String(err) };
}

export type LogErrorDisplay = { title: string; message: string; hint: string };

/** 后端原因码 → 准确文案；不使用「节点无日志引用，或日志文件已不存在」这种抹平真相的说法 */
const REASON_TEXT: Record<string, { title: string; hint: string }> = {
  NO_LOG_REF: {
    title: '该节点没有日志引用（NO_LOG_REF）',
    hint: 'log_ref 由内核写入 node.started / node.succeeded / node.failed 事件。若节点正在运行，可改用 runId 端点读活日志。',
  },
  FILE_NOT_FOUND: {
    title: '日志文件不存在（FILE_NOT_FOUND）',
    hint: '事件里的 log_ref 指向的文件已不在磁盘：可能日志被清理，或该次运行尚未写出文件。',
  },
  OUT_OF_LOG_ROOT: {
    title: '日志路径越界（OUT_OF_LOG_ROOT）',
    hint: '服务端做了目录穿越校验：log_ref 指向了日志根目录之外。这是数据问题，需检查内核写入的 log_ref。',
  },
  TASK_NOT_FOUND: {
    title: '找不到任务（TASK_NOT_FOUND）',
    hint: '事件库里没有该任务的任何事件；可能是任务 id 错误。',
  },
  NODE_NOT_FOUND: {
    title: '找不到节点（NODE_NOT_FOUND）',
    hint: '任务投影里没有该 nodeId；可能是工作流版本与事件不一致。',
  },
};

/**
 * 按 F 项要求分类日志错误：
 *  1) 后端缺能力（版本落后）→ 明确提示「重启服务」，而非「日志不存在」
 *  2) 后端有该能力且给了原因码 → 展示准确文案
 *  3) 未知 code → 展示原始 error
 */
export function classifyLogError(err: LogErrorInfo, compat: BackendCompatibility): LogErrorDisplay {
  if (compat.kind === 'stale') {
    return {
      title: '后端版本落后于前端，请重启服务',
      message: err.message,
      hint: `当前后端缺少能力：${compat.missing.join(
        ', ',
      )}。日志端点很可能整体未注册，因此这个错误不代表「日志不存在」。请重启后端进程加载最新代码后再试。`,
    };
  }
  const reason = err.code ? REASON_TEXT[err.code] : undefined;
  if (reason) return { title: reason.title, message: err.message, hint: reason.hint };
  if (compat.kind === 'down') {
    return {
      title: '后端不可达',
      message: err.message,
      hint: '无法连接后端服务；请确认服务在运行，稍后重试。',
    };
  }
  if (err.status === 400) {
    return {
      title: '日志端点返回 400（服务端拒绝读取）',
      message: err.message,
      hint: '服务端校验未通过；请查看后端返回的原始原因。',
    };
  }
  if (err.status === 404) {
    return {
      title: '日志端点返回 404',
      message: err.message,
      hint:
        compat.kind === 'unknown'
          ? '后端能力尚未探测完成，无法判断是「后端落后」还是「确实没有日志」；稍后会自动重试。'
          : '后端未给出原因码，按原始 error 展示。',
    };
  }
  return { title: '拉取日志失败', message: err.message, hint: '网络或服务异常，可点「重新拉取」重试。' };
}

// ---------------------------------------------------------------------------
// 节点活性
// ---------------------------------------------------------------------------

export type NodeLiveness = {
  nodeId: string;
  runId: string | null;
  logRef: string | null;
  /** 是否成功取到日志文件（false 时看 error） */
  ok: boolean;
  sizeBytes: number | null;
  lastModifiedAt: number | null;
  /** 服务端上报的 ageMs 快照 */
  ageMs: number | null;
  /** 与上一次轮询相比的文件体积增量（字节）；首次或未知为 null */
  sizeDeltaBytes: number | null;
  /** 从活日志尾部解析出的「当前动作」 */
  action: string;
  /** 以下计数口径均为「本窗口内」（LIVENESS_TAIL 行），不是全程累计 */
  toolCallsInWindow: number;
  assistantMessagesInWindow: number;
  windowLines: number;
  error: LogErrorInfo | null;
  fetchedAt: number;
};

export type LivenessTarget = {
  nodeId: string;
  runId: string | null;
  lastLogRef: string | null;
};

/**
 * 由日志尾部解析「当前动作」。解析永远不抛错：无法判断时返回「等待模型输出」。
 * 取尾部最近一条"实质动作"：tool_use → 正在运行该工具；tool_result → 等模型；thinking → 正在思考。
 */
export function deriveCurrentAction(blocks: ConvBlock[]): string {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]!;
    if (block.kind === 'tool_use') {
      return `正在运行 ${block.tool.name}${toolInputSuffix(block.tool.input)}`;
    }
    if (block.kind === 'tool_result') return '等待模型输出';
    if (block.kind === 'thinking') return '正在思考';
    if (block.kind === 'assistant_text') return '正在输出文本';
  }
  return '等待模型输出';
}

function toolInputSuffix(input: unknown): string {
  const record = asRecord(input);
  if (!record) return '';
  for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return `：${truncateInline(value, 100)}`;
    }
  }
  const first = Object.entries(record).find(([, value]) => typeof value === 'string');
  return first ? `（${first[0]}：${truncateInline(String(first[1]), 80)}）` : '';
}

function truncateInline(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 抓取单个运行中节点的活性。任何失败都转成 error 字段，绝不抛错（不打断 2 秒轮询主路径）。
 * previous 用于计算「日志增长」（与上次轮询的 sizeBytes 差值）。
 */
export async function fetchNodeLiveness(
  taskId: string,
  target: LivenessTarget,
  previous: NodeLiveness | undefined,
): Promise<NodeLiveness> {
  const base: NodeLiveness = {
    nodeId: target.nodeId,
    runId: target.runId,
    logRef: target.lastLogRef,
    ok: false,
    sizeBytes: null,
    lastModifiedAt: null,
    ageMs: null,
    sizeDeltaBytes: null,
    action: '等待模型输出',
    toolCallsInWindow: 0,
    assistantMessagesInWindow: 0,
    windowLines: 0,
    error: null,
    fetchedAt: Date.now(),
  };

  // 既无日志引用、又无 runId：直接展示本地事实，避免制造一条必然会 404 的请求。
  if (!target.lastLogRef && !target.runId) {
    return { ...base, action: '节点已启动，但日志引用与 runId 尚未落库' };
  }

  try {
    const res: LogTail = target.lastLogRef
      ? await getNodeLog(taskId, target.nodeId, LIVENESS_TAIL)
      : await getRunLog(taskId, target.runId!, LIVENESS_TAIL);

    const startLineNo = Math.max(1, res.totalLines - res.returnedLines + 1);
    const parsed = parseLogLines(res.lines ?? [], startLineNo);
    const conversation = buildConversation(parsed.entries);

    let toolCalls = 0;
    for (const block of conversation.blocks) {
      if (block.kind === 'tool_use') toolCalls += 1;
    }
    const sizeBytes = typeof res.sizeBytes === 'number' ? res.sizeBytes : null;

    return {
      ...base,
      ok: true,
      logRef: res.logRef ?? target.lastLogRef,
      sizeBytes,
      lastModifiedAt: typeof res.lastModifiedAt === 'number' ? res.lastModifiedAt : null,
      ageMs: typeof res.ageMs === 'number' ? res.ageMs : null,
      sizeDeltaBytes:
        sizeBytes !== null && typeof previous?.sizeBytes === 'number'
          ? sizeBytes - previous.sizeBytes
          : null,
      action: deriveCurrentAction(conversation.blocks),
      toolCallsInWindow: toolCalls,
      assistantMessagesInWindow: parsed.entries.filter((entry) => entry.kind === 'assistant').length,
      windowLines: res.returnedLines,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    return { ...base, error: toLogErrorInfo(err) };
  }
}

/** 运行中节点的活性年龄（ms）：优先「现在 − 文件 mtime」，缺失时退回服务端 ageMs 快照 */
export function livenessAgeMs(liveness: NodeLiveness | undefined, now: number): number | null {
  if (!liveness || !liveness.ok) return null;
  if (typeof liveness.lastModifiedAt === 'number') return Math.max(0, now - liveness.lastModifiedAt);
  return typeof liveness.ageMs === 'number' ? liveness.ageMs : null;
}

// ---------------------------------------------------------------------------
// 任务级健康判定（D 项）
// ---------------------------------------------------------------------------

export type TaskHealthLabel = '健康' | '疑似停滞' | '已失败' | '已完成' | '已取消' | '等待中' | '无法判断';
export type TaskHealthTone = 'ok' | 'run' | 'fail' | 'warn' | 'muted' | 'blocked';
export type TaskHealth = { label: TaskHealthLabel; tone: TaskHealthTone; reason: string };

/**
 * 判定任务健康。全部基于真实数据：TaskState.status + 事件投影的节点状态 + 日志文件 mtime。
 * 顺序上有意先看权威终态（completed/failed），再谈活性——这正好修复「任务早已 completed、界面还在说运行中」。
 */
export function computeTaskHealth(args: {
  status: string | null | undefined;
  nodes: { nodeId: string; status: string }[];
  liveness: Record<string, NodeLiveness>;
  compat: BackendCompatibility;
  now: number;
}): TaskHealth {
  const { status, nodes, liveness, compat, now } = args;

  if (status === 'failed') {
    return { label: '已失败', tone: 'fail', reason: '任务状态为 failed。' };
  }
  if (status === 'completed') {
    return { label: '已完成', tone: 'ok', reason: '任务状态为 completed（已进入终态，已停止轮询）。' };
  }
  if (status === 'cancelled') {
    return {
      label: '已取消',
      tone: 'warn',
      reason: '任务已被人工取消（cancelled 终态）；在途节点的迟到结果不会翻转该状态。',
    };
  }

  if (compat.kind === 'down') {
    return {
      label: '无法判断',
      tone: 'muted',
      reason: '后端不可达，无法读取日志活性来判断是否还在推进。',
    };
  }
  if (compat.kind === 'stale') {
    return {
      label: '无法判断',
      tone: 'warn',
      reason: `后端缺少能力 ${compat.missing.join(
        ', ',
      )}：后端版本落后于前端，请重启服务。`,
    };
  }
  if (compat.kind === 'unknown') {
    return { label: '无法判断', tone: 'muted', reason: '正在探测后端能力，稍后自动重试。' };
  }

  const running = nodes.filter((node) => node.status === 'running');
  if (running.length > 0) {
    const ages = running.map((node) => livenessAgeMs(liveness[node.nodeId], now));
    const known = ages.filter((age): age is number => age !== null);

    if (known.length === 0) {
      return {
        label: '无法判断',
        tone: 'muted',
        reason: '有运行中节点，但尚未取到其日志文件的活性（正在采样）。',
      };
    }

    const stalledIndex = ages.findIndex((age) => (age ?? 0) >= STAGNANT_THRESHOLD_MS);
    if (stalledIndex >= 0) {
      const stalledNode = running[stalledIndex]!;
      const age = ages[stalledIndex] ?? 0;
      return {
        label: '疑似停滞',
        tone: 'warn',
        reason: `节点 ${stalledNode.nodeId} 的日志已 ${formatDuration(
          age,
        )} 未更新（阈值 ${STAGNANT_THRESHOLD_MS / 1000} 秒）。可能正在长时间思考、或已卡住；可查看活日志确认。`,
      };
    }

    if (known.length < running.length) {
      return {
        label: '无法判断',
        tone: 'muted',
        reason: '部分运行中节点尚未取到日志活性，无法整体判定。',
      };
    }

    return {
      label: '健康',
      tone: 'ok',
      reason: `运行中节点日志最近一次写入在 ${formatDuration(
        Math.min(...known),
      )} 内（低于停滞阈值 ${STAGNANT_THRESHOLD_MS / 1000} 秒）。`,
    };
  }

  if (nodes.some((node) => node.status === 'queued')) {
    return { label: '等待中', tone: 'muted', reason: '存在排队中的节点，且当前没有运行中节点。' };
  }

  return {
    label: '无法判断',
    tone: 'muted',
    reason: '当前没有运行中或排队中的节点，无法从日志活性判断。',
  };
}