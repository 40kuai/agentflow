/**
 * 流程视图（DAG）：回答"不够流程"——谁和谁在并行、谁在等谁、为什么失败。
 *
 * 渲染方式：SVG 画边（含箭头），HTML 绝对定位画节点方框。
 * 选这个组合而不是纯 SVG 的原因：节点里要放徽章/多行文本/按钮，HTML 的排版与可访问性
 * 都远好于 <text>；而边用 SVG 才能画平滑曲线与箭头。
 */

import { useState } from 'react';

import type { FlowNode, FlowView } from '../api';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  edgePath,
  isActive,
  joinWait,
  layoutFlow,
  type LaidOutNode,
} from '../flow';
import { formatDuration, formatUsd } from '../format';
import { STAGNANT_THRESHOLD_MS, autoStopText, stalledAgeMs, type NodeLiveness } from '../liveness';
import { Badge, EmptyState, LiveAgo, LiveSince } from './common';

type Props = {
  flow: FlowView | null;
  /** 流转视图不可用时的原因（404/503/网络）——如实显示，不伪装成"没有流程" */
  error: string | null;
  /** 运行中节点的活性快照（按 nodeId），来自日志文件的 mtime/size */
  liveness: Record<string, NodeLiveness>;
  /**
   * 后端生效的「停滞自动停止」阈值（ms）：0 = 已关闭；null = 后端未声明该能力（版本落后）。
   * 用于在停滞节点上如实说明"会不会自动停"，而不是只抛一句"疑似停滞"让用户去翻日志。
   */
  stallTimeoutMs: number | null;
  /** 是否正在提交取消请求（停止按钮据此禁用，避免重复点） */
  cancelling: boolean;
  /** 点击节点：跳到该节点的日志 */
  onOpenLog: (nodeId: string) => void;
  /**
   * 停止整个任务：内核只提供任务级取消（没有"只停单个节点"的语义），
   * 故按钮文案必须写明是「停止任务」，不能让人误以为只停这一个节点。
   */
  onCancelTask: () => void;
};

export function FlowView({
  flow,
  error,
  liveness,
  stallTimeoutMs,
  cancelling,
  onOpenLog,
  onCancelTask,
}: Props) {
  if (error) {
    return (
      <div className="banner banner-warn">
        <div className="banner-body">
          <b>流程视图不可用</b>
          <span className="banner-detail">{error}</span>
          <span className="banner-detail muted">
            流程视图需要后端 <code>/api/tasks/:id/flow</code>；若后端版本落后，请重启服务。
          </span>
        </div>
      </div>
    );
  }
  if (!flow) return <EmptyState>正在加载流程视图…</EmptyState>;
  if (flow.nodes.length === 0) return <EmptyState>该任务的工作流没有节点。</EmptyState>;

  const layout = layoutFlow(
    flow.nodes.map((node) => ({ id: node.id })),
    flow.edges,
  );
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const positionById = new Map(layout.nodes.map((node) => [node.id, node]));
  const activeIds = flow.nodes.filter((node) => node.current || isActive(node.status)).map((n) => n.id);

  return (
    <section className="flow-section">
      <div className="flow-head">
        <h3>流程</h3>
        <span className="muted small">
          {flow.nodes.length} 个节点 · {flow.edges.length} 条边
        </span>
        {activeIds.length > 1 && (
          <Badge tone="run" title="内核按 globalConcurrency 同时推进多个节点（并行批次）">
            并行 {activeIds.length} 个节点同时活跃
          </Badge>
        )}
        {activeIds.length === 1 && <Badge tone="run">当前活跃：{label(byId.get(activeIds[0]!))}</Badge>}
        {activeIds.length === 0 && flow.status === 'active' && <Badge tone="muted">等待调度</Badge>}
        <span className="muted small">{flow.completedNodeIds.length} 个已完成</span>
      </div>

      <div className="dag-scroll">
        <div className="dag" style={{ width: layout.width, height: layout.height }}>
          <svg
            className="dag-edges"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <marker
                id="dag-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="dag-arrow-head" />
              </marker>
            </defs>
            {flow.edges.map((edge, i) => {
              const from = positionById.get(edge.from);
              const to = positionById.get(edge.to);
              if (!from || !to) return null;
              const title = [edge.when ? `条件：${edge.when}` : '无条件边', edge.description, edge.onMissing === 'wait' ? '不满足时：等待' : null]
                .filter(Boolean)
                .join('　|　');
              const taken = flow.transfers.some(
                (t) => t.from === edge.from && t.to === edge.to,
              );
              return (
                <path
                  key={`${edge.from}->${edge.to}-${i}`}
                  d={edgePath(from, to)}
                  className={`dag-edge${taken ? ' is-taken' : ''}`}
                  markerEnd="url(#dag-arrow)"
                >
                  <title>{`${edge.from} → ${edge.to}　${title}`}</title>
                </path>
              );
            })}
          </svg>

          {layout.nodes.map((position) => {
            const node = byId.get(position.id);
            if (!node) return null;
            return (
              <DagNodeBox
                key={node.id}
                node={node}
                position={position}
                edges={flow.edges}
                nodes={flow.nodes}
                liveness={liveness[node.id]}
                stallTimeoutMs={stallTimeoutMs}
                cancelling={cancelling}
                onOpenLog={onOpenLog}
                onCancelTask={onCancelTask}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function label(node: FlowNode | undefined): string {
  return node ? node.title || node.id : '—';
}

/**
 * 停滞节点的完整说明（hover 用）：把「无输出多久」与「系统会不会自动停」一次讲清，
 * 直接回答用户"要不要我手动去停"这个决策问题，而不是只丢一句"疑似停滞"。
 */
function stallDetail(stalledForMs: number | null, stallTimeoutMs: number | null): string {
  if (stalledForMs === null) return '';
  return `日志已 ${formatDuration(stalledForMs)} 没有新输出（疑似停滞阈值 ${
    STAGNANT_THRESHOLD_MS / 1000
  } 秒）。${autoStopText(stallTimeoutMs)}。`;
}

function DagNodeBox({
  node,
  position,
  nodes,
  edges,
  liveness,
  stallTimeoutMs,
  cancelling,
  onOpenLog,
  onCancelTask,
}: {
  node: FlowNode;
  position: LaidOutNode;
  nodes: FlowNode[];
  edges: FlowView['edges'];
  liveness: NodeLiveness | undefined;
  stallTimeoutMs: number | null;
  cancelling: boolean;
  onOpenLog: (nodeId: string) => void;
  onCancelTask: () => void;
}) {
  // 停止是**任务级**动作（内核没有"只停单个节点"的语义），必须先二次确认再提交，
  // 避免在密集的节点方框里误点一下就把整条流程杀掉。
  const [confirmStop, setConfirmStop] = useState(false);

  const active = node.current || isActive(node.status);
  const failed = node.status === 'failed';
  const cancelled = node.status === 'cancelled';
  const wait = joinWait(node.id, nodes, edges);
  // join 且自己尚未成功：显示"在等谁"。判定只看直接上游，与内核 join 语义一致。
  const waiting = wait.isJoin && node.status !== 'succeeded' && node.status !== 'running' && wait.waitingOn.length > 0;
  // 停滞判据与状态条共用（liveness.ts 的 stalledAgeMs），避免两处口径漂移
  const stalledFor = stalledAgeMs(active, liveness, Date.now());
  const stalled = stalledFor !== null;

  const classes = [
    'dag-node',
    active ? 'is-active' : '',
    failed ? 'is-failed' : '',
    cancelled ? 'is-cancelled' : '',
    node.status === 'succeeded' ? 'is-done' : '',
    waiting ? 'is-waiting' : '',
    stalled ? 'is-stalled' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
      title={node.description ?? node.id}
    >
      <div className="dag-node-head">
        <span className="dag-node-title">{node.title || node.id}</span>
        <span className={`badge tone-${toneOf(node.status)} dag-node-badge`}>{statusText(node.status)}</span>
      </div>

      <div className="dag-node-sub">
        <span className="dag-node-id mono">{node.id}</span>
        {node.roleDisplayName && <span className="muted">· {node.roleDisplayName}</span>}
        {node.attempt > 1 && <span className="tone-warn">· 第 {node.attempt} 次</span>}
        {wait.isJoin && (
          <span className="badge tone-muted dag-join-tag" title="入边 ≥2：所有上游就绪后才会启动（join）">
            join
          </span>
        )}
      </div>

      <div className="dag-node-metrics">
        {/* 运行中的节点没有 durationMs（要等结束才算得出），改显示**每秒自增**的已运行时长 */}
        {active && typeof node.startedAt === 'number' ? (
          <span title="本次尝试已运行时长（每秒刷新）">
            已运行 <LiveSince ts={node.startedAt} />
          </span>
        ) : (
          <span>{formatDuration(node.durationMs)}</span>
        )}
        <span className="money">{formatUsd(node.costUsd)}</span>
        {node.artifactTypes.length > 0 && <span className="muted">{node.artifactTypes.join(', ')}</span>}
      </div>

      {/* 四项"不用展开就能看到"的关键信息：失败原因 / 在等谁 / 停滞（含停止入口）/ 正常运行中 */}
      {failed ? (
        <div className="dag-strip dag-strip-fail" title={node.blockedReason?.error ?? node.enterReason?.reason ?? ''}>
          <b>{node.blockedReason?.label ?? '失败'}</b>
          <span className="ellipsis">{node.blockedReason?.error ?? node.enterReason?.reason ?? '（未记录原因）'}</span>
        </div>
      ) : waiting ? (
        <div className="dag-strip dag-strip-wait" title={`未就绪的上游：${wait.waitingOn.join('、')}`}>
          <b>在等</b>
          <span className="ellipsis">{wait.waitingOn.map((id) => nodes.find((n) => n.id === id)?.title || id).join('、')}</span>
        </div>
      ) : active && confirmStop ? (
        <div className="dag-strip dag-strip-stall">
          <b>停止整个任务？</b>
          <button
            type="button"
            className="btn btn-xs btn-danger"
            disabled={cancelling}
            onClick={() => {
              setConfirmStop(false);
              onCancelTask();
            }}
          >
            {cancelling ? '停止中…' : '确认'}
          </button>
          <button type="button" className="btn btn-xs btn-ghost" onClick={() => setConfirmStop(false)}>
            算了
          </button>
        </div>
      ) : active && stalled ? (
        <div className="dag-strip dag-strip-stall" title={stallDetail(stalledFor, stallTimeoutMs)}>
          <b>疑似停滞</b>
          {typeof liveness?.lastModifiedAt === 'number' ? (
            <LiveAgo ts={liveness.lastModifiedAt} staleAfterMs={STAGNANT_THRESHOLD_MS} prefix="日志 " />
          ) : (
            <span className="muted">日志已无更新</span>
          )}
          <button
            type="button"
            className="btn btn-xs btn-danger"
            disabled={cancelling}
            onClick={() => setConfirmStop(true)}
            title="内核只支持任务级取消：确认后将终止整条流程的全部在途节点（已花费用不退回）"
          >
            停止
          </button>
        </div>
      ) : active ? (
        <div className="dag-strip dag-strip-run">
          <b>{node.current ? '运行中' : '排队中'}</b>
          {typeof liveness?.lastModifiedAt === 'number' ? (
            <LiveAgo ts={liveness.lastModifiedAt} staleAfterMs={STAGNANT_THRESHOLD_MS} prefix="日志 " />
          ) : (
            <span className="muted">{node.current ? '等待日志…' : '等待上游'}</span>
          )}
        </div>
      ) : cancelled ? (
        <div className="dag-strip dag-strip-cancel">
          <b>已取消</b>
        </div>
      ) : (
        <div className="dag-strip dag-strip-idle">
          <span className="ellipsis muted" title={node.enterReason?.reason ?? ''}>
            {node.enterReason?.reason ?? node.entryCondition ?? '（尚未进入）'}
          </span>
        </div>
      )}

      {/* 当前动作行：直接回答"现在到底在做什么"，不必切到日志 tab 才知道。
          停滞时改为陈述"多久没输出 + 会不会自动停"，比重复一个已经过期的动作更有用。 */}
      {active && !waiting && (
        <div
          className={`dag-node-act${stalled ? ' is-stalled' : ''}`}
          title={stalled ? stallDetail(stalledFor, stallTimeoutMs) : (liveness?.action ?? '')}
        >
          {stalled ? (
            <span className="ellipsis">
              已 {formatDuration(stalledFor)} 无输出 · {autoStopText(stallTimeoutMs)}
            </span>
          ) : node.status === 'running' ? (
            <span className="ellipsis">{liveness?.action ?? '等待模型输出'}</span>
          ) : (
            <span className="ellipsis muted">等待调度启动</span>
          )}
        </div>
      )}

      <button
        type="button"
        className="btn btn-xs btn-ghost dag-node-action"
        onClick={() => onOpenLog(node.id)}
        title="查看该节点日志"
      >
        日志
      </button>
    </div>
  );
}

function toneOf(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'ok';
    case 'running':
      return 'run';
    case 'failed':
      return 'fail';
    case 'cancelled':
    case 'waiting_gate':
      return 'warn';
    default:
      return 'muted';
  }
}

function statusText(status: string): string {
  switch (status) {
    case 'not_started':
      return '未开始';
    case 'queued':
      return '排队中';
    case 'running':
      return '运行中';
    case 'succeeded':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'waiting_gate':
      return '等闸门';
    default:
      return status;
  }
}