/**
 * 日志阅读器：本管理台的核心。
 * 三种视图：
 *  1. 对话视图 —— 把 stream-json 还原成 agent 轨迹（模型说了什么、调了什么工具、工具返回了什么）
 *  2. 原始视图 —— 逐行原文 + 全局行号
 *  3. 诊断视图 —— 自动扫描权限拒绝 / is_error / subtype / 终局 result / 工具统计，并可跳转到对应行
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, getNodeLog, getRunLog, type LogTail } from '../api';
import type { NodeAggregate } from '../aggregate';
import { formatClock, formatDuration, formatUsd, shortId, truncate } from '../format';
import {
  buildConversation,
  parseLogLines,
  safeStringify,
  scanDiagnostics,
  type Conversation,
  type ConvBlock,
  type DiagnosticSignal,
  type ParsedLog,
  type ResultInfo,
} from '../logparse';
import {
  Badge,
  Collapsible,
  CopyButton,
  EmptyState,
  ErrorBox,
  PreBlock,
  Section,
  statusTone,
} from './common';

const TAIL_OPTIONS = [100, 200, 500, 1000, 2000];
const TOOL_RESULT_PREVIEW = 2000;
const TEXT_PREVIEW = 1200;

type ViewMode = 'conversation' | 'raw' | 'diagnostic';

type Props = {
  taskId: string;
  nodes: NodeAggregate[];
  /** 外部（节点卡片「查看日志」）指定的聚焦节点 */
  focusNodeId: string | null;
};

/** 默认聚焦：优先失败节点 → 运行中节点 → 有日志的节点 → 第一个节点 */
function pickDefaultNode(nodes: NodeAggregate[]): string | null {
  if (nodes.length === 0) return null;
  return (
    nodes.find((n) => n.status === 'failed')?.nodeId ??
    nodes.find((n) => n.status === 'running')?.nodeId ??
    nodes.find((n) => n.lastLogRef)?.nodeId ??
    nodes[0]!.nodeId
  );
}

export function LogViewer({ taskId, nodes, focusNodeId }: Props) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(focusNodeId);
  const [tail, setTail] = useState(200);
  const [view, setView] = useState<ViewMode>('conversation');
  const [data, setData] = useState<LogTail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ status: number | null; message: string } | null>(null);
  const [query, setQuery] = useState('');
  const [hitIndex, setHitIndex] = useState(0);
  const [highlightLine, setHighlightLine] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [wrapLines, setWrapLines] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // nodes 每次轮询都会是新数组：用 ref 读，避免把它放进 fetch 依赖里造成每 2 秒重拉日志
  const nodesRef = useRef<NodeAggregate[]>(nodes);
  nodesRef.current = nodes;

  // 外部聚焦：切换到指定节点
  useEffect(() => {
    if (focusNodeId) setSelectedNodeId(focusNodeId);
  }, [focusNodeId]);

  // 任务切换：清空旧日志；若当前选中节点仍在新任务里则保留（nodeId 是工作流节点 id，跨任务同名）
  useEffect(() => {
    setData(null);
    setError(null);
    setHighlightLine(null);
    setHitIndex(0);
    setSelectedNodeId((prev) => {
      const current = nodesRef.current;
      if (prev && current.some((n) => n.nodeId === prev)) return prev;
      return pickDefaultNode(current);
    });
  }, [taskId]);

  // 详情首次加载完成（nodes 从空变有）时补一个默认聚焦
  useEffect(() => {
    if (selectedNodeId !== null || nodes.length === 0) return;
    setSelectedNodeId(pickDefaultNode(nodes));
  }, [nodes, selectedNodeId]);

  useEffect(() => {
    if (!selectedNodeId) return;
    const node = nodesRef.current.find((n) => n.nodeId === selectedNodeId);
    const runId = node?.runId ?? null;
    // 既无日志引用、又无 runId 时才不发请求：直接展示本地事实，避免制造一条必然 404 的请求。
    // 若已有 runId（节点正在运行），走 runId 回退端点——此时日志文件其实已在写入。
    if (node && !node.lastLogRef && !runId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    // 切换节点 / tail 时先清空，避免把上一个节点的日志显示在新节点名下
    setData(null);
    setLoading(true);
    const request = node?.lastLogRef
      ? getNodeLog(taskId, selectedNodeId, tail)
      : getRunLog(taskId, runId!, tail);
    request
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        if (err instanceof ApiError) setError({ status: err.status, message: err.message });
        else setError({ status: null, message: (err as Error).message });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, selectedNodeId, tail, reloadToken]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.nodeId === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const startLineNo = data ? Math.max(1, data.totalLines - data.returnedLines + 1) : 1;

  const parsed = useMemo(() => parseLogLines(data?.lines ?? [], startLineNo), [data, startLineNo]);
  const conversation = useMemo(() => buildConversation(parsed.entries), [parsed]);
  const diagnostics = useMemo(() => scanDiagnostics(parsed), [parsed]);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return parsed.rawLines.filter((line) => line.text.toLowerCase().includes(q)).map((l) => l.lineNo);
  }, [parsed, query]);

  const jumpToLine = useCallback((lineNo: number) => {
    setView('raw');
    setHighlightLine(lineNo);
  }, []);

  // 跳转后滚动到目标行
  useEffect(() => {
    if (view !== 'raw' || highlightLine === null) return;
    const timer = window.setTimeout(() => {
      const el = containerRef.current?.querySelector<HTMLElement>(`#raw-line-${highlightLine}`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [view, highlightLine]);

  function stepHit(delta: number): void {
    if (hits.length === 0) return;
    const next = (hitIndex + delta + hits.length) % hits.length;
    setHitIndex(next);
    const lineNo = hits[next];
    if (lineNo !== undefined) jumpToLine(lineNo);
  }

  return (
    <div className="log-viewer" ref={containerRef}>
      <div className="log-toolbar">
        <div className="log-toolbar-row">
          <div className="node-chips">
            {nodes.length === 0 && <span className="muted">暂无节点</span>}
            {nodes.map((node) => (
              <button
                key={node.nodeId}
                type="button"
                className={`node-chip${node.nodeId === selectedNodeId ? ' active' : ''}`}
                onClick={() => setSelectedNodeId(node.nodeId)}
                title={
                  node.lastLogRef ??
                  (node.runId
                    ? `日志引用尚未落库，已按 runId 读取活日志（${node.runId}）`
                    : '该节点没有日志引用')
                }
              >
                <span className={`dot tone-${statusTone(node.status)}`} />
                {node.nodeId}
                {!node.lastLogRef && (
                  <span className="muted">{node.runId ? ' ·活日志' : ' ·无日志'}</span>
                )}
              </button>
            ))}
          </div>

          <div className="view-switch">
            <button
              type="button"
              className={`tab-btn${view === 'conversation' ? ' active' : ''}`}
              onClick={() => setView('conversation')}
            >
              对话视图
            </button>
            <button
              type="button"
              className={`tab-btn${view === 'raw' ? ' active' : ''}`}
              onClick={() => setView('raw')}
            >
              原始视图
            </button>
            <button
              type="button"
              className={`tab-btn${view === 'diagnostic' ? ' active' : ''}`}
              onClick={() => setView('diagnostic')}
            >
              诊断视图
            </button>
            {view === 'raw' && (
              <button
                type="button"
                className={`tab-btn${wrapLines ? ' active' : ''}`}
                onClick={() => setWrapLines((v) => !v)}
                title="折行可避免超长横向滚动"
              >
                折行 {wrapLines ? '开' : '关'}
              </button>
            )}
          </div>
        </div>

        <div className="log-toolbar-row">
          <label className="field">
            <span>tail</span>
            <select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
              {TAIL_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  最后 {n} 行
                </option>
              ))}
            </select>
          </label>

          <label className="field grow">
            <span>搜索</span>
            <input
              value={query}
              placeholder="在返回的日志行中搜索…"
              onChange={(e) => {
                setQuery(e.target.value);
                setHitIndex(0);
              }}
            />
          </label>
          <div className="search-actions">
            <span className="muted">{query.trim() ? `命中 ${hits.length} 行` : '未搜索'}</span>
            <button
              type="button"
              className="btn btn-xs"
              disabled={hits.length === 0}
              onClick={() => stepHit(-1)}
            >
              上一处
            </button>
            <button
              type="button"
              className="btn btn-xs"
              disabled={hits.length === 0}
              onClick={() => stepHit(1)}
            >
              下一处
            </button>
          </div>

          <button type="button" className="btn btn-xs" onClick={() => setReloadToken((v) => v + 1)}>
            重新拉取
          </button>
        </div>

        {data && (
          <div className="log-meta">
            <span className="mono">{data.logRef}</span>
            <span className="muted">
              显示最后 {data.returnedLines} 行 / 共 {data.totalLines} 行
              {data.truncated ? '（已截断）' : '（已含全部）'}
            </span>
            <span className="muted">本次窗口起始行号 {startLineNo}</span>
            {loading && <span className="muted">刷新中…</span>}
          </div>
        )}
      </div>

      {!selectedNodeId && <EmptyState>该任务还没有节点，暂无日志。</EmptyState>}

      {selectedNodeId && selectedNode && !selectedNode.lastLogRef && !selectedNode.runId && (
        <ErrorBox
          title="该节点没有日志引用"
          message={`节点 ${selectedNodeId} 的 lastLogRef 为空。可能原因（按可能性排序）：1) 节点正在运行，日志引用要等节点结束才会出现在事件里；2) 节点还在 queued（尚未真正执行）；3) 该次运行确实没有写出日志文件。`}
          hint="该节点没有 runId，尚未真正启动；可切到「节点与成本」查看状态与尝试次数。"
        />
      )}

      {selectedNode && !selectedNode.lastLogRef && selectedNode.runId && (
        <div className="notice">
          节点 {selectedNode.nodeId} 仍在运行：日志引用（lastLogRef）要等节点结束才会写入事件，但日志文件已在写入。
          已按 runId 直接读取活日志，文件位于{' '}
          <code className="mono">{data?.logRef ?? `logs/runs/${selectedNode.runId}.jsonl`}</code>；
          也可等节点结束后在界面查看。
        </div>
      )}

      {error && (
        <ErrorBox
          title={
            error.status === 400
              ? '日志端点返回 400（服务端拒绝读取）'
              : error.status === 404
                ? '日志端点返回 404'
                : '拉取日志失败'
          }
          message={error.message}
          hint={
            error.status === 400
              ? '服务端做了目录穿越校验：lastLogRef 指向了日志根目录之外。这是数据问题，需检查内核写入的 log_ref。'
              : error.status === 404
                ? '节点无日志引用，或日志文件已不存在。'
                : '网络或服务异常，可点「重新拉取」重试。'
          }
        />
      )}

      {loading && !data && !error && <EmptyState>正在拉取日志…</EmptyState>}

      {data && !error && view === 'conversation' && (
        <ConversationView conversation={conversation} onJump={jumpToLine} startLineNo={startLineNo} />
      )}

      {data && !error && view === 'raw' && (
        <RawView lines={parsed.rawLines} highlightLine={highlightLine} query={query} wrap={wrapLines} />
      )}

      {data && !error && view === 'diagnostic' && (
        <DiagnosticView
          signals={diagnostics.signals}
          toolCounts={diagnostics.toolCounts}
          result={diagnostics.result}
          skippedStreamEvents={diagnostics.skippedStreamEvents}
          parseFailures={diagnostics.parseFailures}
          totalEntries={diagnostics.totalEntries}
          windowLines={data.returnedLines}
          onJump={jumpToLine}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 对话视图
// ---------------------------------------------------------------------------

function LongText({ text, preview, mono }: { text: string; preview: number; mono?: boolean }) {
  const { truncated } = truncate(text, preview);
  if (!truncated) {
    return <div className={mono ? 'mono-text' : 'text'}>{text}</div>;
  }
  return (
    <Collapsible
      title={<span className="muted">{`内容过长，已折叠（共 ${text.length} 字符）`}</span>}
      right={<CopyButton text={text} />}
    >
      <div className={mono ? 'mono-text' : 'text'}>{text}</div>
    </Collapsible>
  );
}

function ConversationView({
  conversation,
  onJump,
  startLineNo,
}: {
  conversation: Conversation;
  onJump: (lineNo: number) => void;
  startLineNo: number;
}) {
  const { blocks, skippedStreamEvents } = conversation;

  if (blocks.length === 0) {
    return (
      <EmptyState>
        {`返回的行窗口（起始行 ${startLineNo}）中没有可还原的 stream-json 条目。`}
        {skippedStreamEvents > 0 ? '窗口内只有增量事件。' : '可切到「原始视图」查看原文。'}
      </EmptyState>
    );
  }

  return (
    <div className="conversation">
      {skippedStreamEvents > 0 && (
        <div className="notice">
          已折叠 {skippedStreamEvents} 条 <code>stream_event</code> 增量事件（逐 token 增量，噪音大）
        </div>
      )}

      {blocks.map((block, index) => (
        <ConvBlockView key={`${block.kind}-${block.lineNo}-${index}`} block={block} onJump={onJump} />
      ))}

      <div className="notice">
        已到返回窗口末尾（起始行 {startLineNo}）。要看更早的内容，把 tail 调到 2000 或重新拉取。
      </div>
    </div>
  );
}

function ConvBlockView({ block, onJump }: { block: ConvBlock; onJump: (lineNo: number) => void }) {
  const lineChip = (
    <button
      type="button"
      className="line-chip"
      onClick={() => onJump(block.lineNo)}
      title="跳到原始视图对应行"
    >
      L{block.lineNo}
    </button>
  );

  switch (block.kind) {
    case 'assistant_text':
      return (
        <div className="conv assistant">
          <div className="conv-head">
            <span className="speaker">模型</span>
            {lineChip}
          </div>
          <LongText text={block.text} preview={TEXT_PREVIEW} />
        </div>
      );

    case 'thinking':
      return (
        <div className="conv thinking">
          <Collapsible title={<span>思考（{block.text.length} 字符）</span>} right={lineChip}>
            <div className="text muted">{block.text}</div>
          </Collapsible>
        </div>
      );

    case 'tool_use':
      return (
        <div className="conv tool-use">
          <div className="conv-head">
            <span className="speaker">调用工具</span>
            <Badge tone="run">{block.tool.name}</Badge>
            {lineChip}
          </div>
          <Collapsible
            title={<code className="arg-preview">{previewArgs(block.tool.input)}</code>}
            right={<CopyButton text={safeStringify(block.tool.input)} />}
          >
            <PreBlock text={safeStringify(block.tool.input)} maxHeight={360} />
          </Collapsible>
        </div>
      );

    case 'tool_result':
      return (
        <div className={`conv tool-result${block.isError ? ' is-error' : ''}`}>
          <div className="conv-head">
            <span className="speaker">工具返回</span>
            {block.isError && <Badge tone="fail">is_error</Badge>}
            <span className="muted mono">{shortId(block.toolUseId, 16)}</span>
            <span className="muted">{block.content.length} 字符</span>
            {lineChip}
          </div>
          <LongText text={block.content} preview={TOOL_RESULT_PREVIEW} mono />
        </div>
      );

    case 'user_text':
      return (
        <div className="conv user">
          <div className="conv-head">
            <span className="speaker">用户 / 系统注入</span>
            {lineChip}
          </div>
          <LongText text={block.text} preview={TEXT_PREVIEW} />
        </div>
      );

    case 'system':
      return (
        <div className="conv system">
          <div className="conv-head">
            <span className="speaker">会话初始化</span>
            {lineChip}
          </div>
          <div className="muted">{block.text}</div>
          <Collapsible title={<span className="muted">原始 system.init</span>}>
            <PreBlock text={safeStringify(block.json)} maxHeight={320} />
          </Collapsible>
        </div>
      );

    case 'result':
      return <ResultBlock info={block.info} lineChip={lineChip} />;

    case 'spawn':
      return (
        <div className="conv spawn">
          <Collapsible
            title={
              <span>
                进程启动（{block.args.length} 个参数）· cwd {block.cwd || '未知'}
              </span>
            }
            right={lineChip}
          >
            <PreBlock text={block.args.map((a, i) => `[${i}] ${a}`).join('\n')} maxHeight={420} />
          </Collapsible>
        </div>
      );

    case 'stderr':
      return (
        <div className="conv stderr">
          <div className="conv-head">
            <Badge tone="warn">stderr</Badge>
            {lineChip}
          </div>
          <div className="mono-text">{block.text}</div>
        </div>
      );

    case 'timeout':
      return (
        <div className="conv timeout">
          <div className="conv-head">
            <Badge tone="fail">wall-clock 超时</Badge>
            <span className="muted">上限 {formatDuration(block.wallTimeMs)}</span>
            {lineChip}
          </div>
        </div>
      );

    case 'other':
    default:
      return (
        <div className="conv other">
          <div className="conv-head">
            <Badge tone="muted">{block.type ?? '未知条目'}</Badge>
            {lineChip}
          </div>
          {block.json ? (
            <Collapsible title={<span className="muted">展开 JSON</span>}>
              <PreBlock text={safeStringify(block.json)} maxHeight={360} />
            </Collapsible>
          ) : (
            <div className="mono-text">{block.text}</div>
          )}
        </div>
      );
  }
}

function previewArgs(input: unknown): string {
  const record =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  if (!record) return safeStringify(input, 0);
  const preferred = ['pattern', 'cmd', 'command', 'path', 'file_path', 'query', 'url'];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return `${key}: ${value}`;
  }
  const first = Object.entries(record)[0];
  if (!first) return '（无参数）';
  const [key, value] = first;
  const text = typeof value === 'string' ? value : safeStringify(value, 0);
  return `${key}: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`;
}

function ResultBlock({ info, lineChip }: { info: ResultInfo; lineChip: ReactNode }) {
  return (
    <div className={`conv result${info.isError ? ' is-error' : ''}`}>
      <div className="conv-head">
        <span className="speaker">终局 result</span>
        <Badge tone={info.isError ? 'fail' : 'ok'}>{info.subtype}</Badge>
        {info.isError && <Badge tone="fail">is_error: true</Badge>}
        {lineChip}
      </div>
      <div className="result-metrics">
        <Metric label="轮次 num_turns" value={info.numTurns === null ? '—' : String(info.numTurns)} />
        <Metric label="耗时 duration_ms" value={formatDuration(info.durationMs)} />
        <Metric label="花费 total_cost_usd" value={formatUsd(info.costUsd)} />
        <Metric
          label="permission_denials"
          value={String(info.permissionDenials.length)}
          tone={info.permissionDenials.length > 0 ? 'fail' : undefined}
        />
      </div>
      {info.permissionDenials.length > 0 && (
        <PreBlock text={safeStringify(info.permissionDenials)} maxHeight={200} />
      )}
      {info.errors.length > 0 && (
        <ul className="error-list">
          {info.errors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}
      {info.resultText && <LongText text={info.resultText} preview={TEXT_PREVIEW} mono />}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
  wide,
}: {
  label: string;
  value: string;
  tone?: string;
  wide?: boolean;
}) {
  return (
    <div className={`metric${wide ? ' wide' : ''}`}>
      <div className="metric-label">{label}</div>
      <div className={`metric-value${tone ? ` tone-${tone}` : ''}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 原始视图
// ---------------------------------------------------------------------------

function RawView({
  lines,
  highlightLine,
  query,
  wrap,
}: {
  lines: ParsedLog['rawLines'];
  highlightLine: number | null;
  query: string;
  wrap: boolean;
}) {
  if (lines.length === 0) return <EmptyState>没有返回任何日志行。</EmptyState>;
  const needle = query.trim().toLowerCase();

  return (
    <div className={`raw-view${wrap ? ' wrap' : ''}`}>
      {lines.map((line) => (
        <div
          key={line.lineNo}
          id={`raw-line-${line.lineNo}`}
          className={`raw-line${line.lineNo === highlightLine ? ' highlight' : ''} kind-${line.kind}`}
        >
          <span className="raw-no">{line.lineNo}</span>
          <span className="raw-kind">{line.kind}</span>
          <span className="raw-ts">{line.ts ? formatClock(line.ts) : ''}</span>
          <span className="raw-text">
            {needle && line.text.length < 20000 ? highlightText(line.text, needle) : line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function highlightText(text: string, needle: string): ReactNode[] {
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lower.indexOf(needle);
  let guard = 0;
  while (index !== -1 && guard < 200) {
    guard += 1;
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark key={`${index}-${guard}`} className="hit">
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
    index = lower.indexOf(needle, cursor);
  }
  parts.push(text.slice(cursor));
  return parts;
}

// ---------------------------------------------------------------------------
// 诊断视图
// ---------------------------------------------------------------------------

function DiagnosticView({
  signals,
  toolCounts,
  result,
  skippedStreamEvents,
  parseFailures,
  totalEntries,
  windowLines,
  onJump,
}: {
  signals: DiagnosticSignal[];
  toolCounts: { name: string; count: number }[];
  result: ResultInfo | null;
  skippedStreamEvents: number;
  parseFailures: number;
  totalEntries: number;
  /** 本窗口实际返回的日志行数（用于标注统计口径边界） */
  windowLines: number;
  onJump: (lineNo: number) => void;
}) {
  const toolTotal = toolCounts.reduce((sum, tool) => sum + tool.count, 0);

  return (
    <div className="diagnostic">
      <Section title="终局指标">
        {result ? (
          <div className="result-metrics">
            <Metric label="subtype" value={result.subtype} tone={result.isError ? 'fail' : 'ok'} wide />
            <Metric
              label="is_error"
              value={String(result.isError)}
              tone={result.isError ? 'fail' : 'ok'}
            />
            <Metric label="num_turns" value={result.numTurns === null ? '—' : String(result.numTurns)} />
            <Metric label="duration_ms" value={formatDuration(result.durationMs)} />
            <Metric label="total_cost_usd" value={formatUsd(result.costUsd)} />
            <Metric
              label="permission_denials"
              value={String(result.permissionDenials.length)}
              tone={result.permissionDenials.length > 0 ? 'fail' : undefined}
            />
          </div>
        ) : (
          <div className="muted">
            返回的日志窗口里没有 <code>result</code> 行——说明这次运行尚未结束，或终局行落在更早的位置（调大 tail 再试）。
          </div>
        )}
      </Section>

      <Section title="信号扫描">
        <table className="signal-table">
          <thead>
            <tr>
              <th>级别</th>
              <th>信号</th>
              <th className="num">次数</th>
              <th>说明 / 命中行（点击跳转）</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((signal) => (
              <tr key={signal.id} className={signal.severity === 'error' ? 'row-error' : ''}>
                <td>
                  <Badge
                    tone={
                      signal.severity === 'error'
                        ? 'fail'
                        : signal.severity === 'warn'
                          ? 'warn'
                          : signal.severity === 'ok'
                            ? 'ok'
                            : 'muted'
                    }
                  >
                    {signal.severity}
                  </Badge>
                </td>
                <td>{signal.label}</td>
                <td className="num">{signal.count}</td>
                <td>
                  <div className="muted">{signal.detail}</div>
                  {signal.lineNos.length > 0 && (
                    <div className="line-list">
                      {signal.lineNos.slice(0, 40).map((lineNo) => (
                        <button
                          key={lineNo}
                          type="button"
                          className="line-chip"
                          onClick={() => onJump(lineNo)}
                        >
                          L{lineNo}
                        </button>
                      ))}
                      {signal.lineNos.length > 40 && (
                        <span className="muted">…共 {signal.lineNos.length} 行</span>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={`工具调用统计（本窗口最后 ${windowLines} 行内，共 ${toolTotal} 次）`}>
        {toolCounts.length === 0 ? (
          <div className="muted">本窗口内未观察到 tool_use 调用。</div>
        ) : (
          <div className="tool-counts">
            {toolCounts.map((tool) => (
              <span key={tool.name} className="tool-count">
                <code>{tool.name}</code>
                <b>{tool.count}</b>
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title="窗口解析统计">
        <div className="muted">
          内层条目 {totalEntries} 条 · 被折叠的 stream_event {skippedStreamEvents} 条 · 解析失败降级为纯文本{' '}
          {parseFailures} 条
        </div>
      </Section>
    </div>
  );
}