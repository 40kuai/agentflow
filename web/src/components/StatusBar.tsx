/**
 * 状态条：回答"现在怎么样、该做什么"。
 *
 * 顶层只放**结论性**信息（当前阶段 / 活跃节点 / 花费 / 耗时 / 失败根因 / 可执行操作）；
 * 明细一律降到二级 tab。这是本次信息架构重构的核心——不再让使用者自己从日志里拼结论。
 */

import { useState } from 'react';
import type { FlowView } from '../api';
import type { TaskAggregate } from '../aggregate';
import { formatDuration, formatUsd } from '../format';
import { isActive } from '../flow';
import {
  STAGNANT_THRESHOLD_MS,
  autoStopText,
  stalledAgeMs,
  type BackendCompatibility,
  type NodeLiveness,
  type TaskHealth,
} from '../liveness';
import { Badge, HealthBadge } from './common';

type Props = {
  flow: FlowView | null;
  flowError: string | null;
  aggregate: TaskAggregate;
  compat: BackendCompatibility;
  taskHealth: TaskHealth | null;
  /** 运行中节点的活性快照：状态条据此把「疑似停滞」提到结论层，而不是留给用户去翻日志 */
  liveness: Record<string, NodeLiveness>;
  /** 后端生效的停滞自动停止阈值（ms）：0 = 已关闭；null = 后端未声明该能力 */
  stallTimeoutMs: number | null;
  /** 是否正在提交取消请求 */
  cancelling: boolean;
  /** 取消结果/失败提示（后端中文文案） */
  cancelNotice: string | null;
  cancelError: string | null;
  onCancel: () => void;
  onOpenLog: (nodeId: string) => void;
};

export function StatusBar({
  flow,
  flowError,
  aggregate,
  compat,
  taskHealth,
  liveness,
  stallTimeoutMs,
  cancelling,
  cancelNotice,
  cancelError,
  onCancel,
  onOpenLog,
}: Props) {
  const [confirming, setConfirming] = useState(false);

  const status = flow?.status ?? null;
  const activeNodes = (flow?.nodes ?? []).filter((node) => node.current || node.status === 'running');
  const queuedNodes = (flow?.nodes ?? []).filter((node) => node.status === 'queued');
  const failedNodes = (flow?.nodes ?? []).filter((node) => node.status === 'failed');

  // 疑似停滞的活跃节点：与 DAG 节点共用 stalledAgeMs 判据，两处结论必然一致
  const now = Date.now();
  const stalledNodes: { node: FlowView['nodes'][number]; ageMs: number }[] = [];
  for (const node of flow?.nodes ?? []) {
    const active = node.current || isActive(node.status);
    const ageMs = stalledAgeMs(active, liveness[node.id], now);
    if (ageMs !== null) stalledNodes.push({ node, ageMs });
  }

  const stage = currentStage(flow);
  const elapsed =
    aggregate.taskStartedAt !== null
      ? (aggregate.taskEndedAt ?? Date.now()) - aggregate.taskStartedAt
      : null;

  // 取消入口只在任务仍 active 时可用；后端版本落后时明确禁用并说明原因（而不是点了 404）
  const canCancel = status === 'active';
  const cancelBlocked = compat.kind === 'stale';

  return (
    <section className={`status-bar tone-edge-${stage.tone}`}>
      <div className="status-main">
        <div className="kv status-stage">
          <div className="kv-label">当前阶段</div>
          <div className={`kv-value tone-${stage.tone}`}>{stage.text}</div>
          {stage.detail && <div className="status-detail muted">{stage.detail}</div>}
        </div>

        <div className="kv">
          <div className="kv-label">活跃节点</div>
          <div className="kv-value">
            {activeNodes.length === 0 ? (
              <span className="muted">{status === 'active' ? '等待调度' : '无'}</span>
            ) : (
              <span className="status-chips">
                {activeNodes.length > 1 && (
                  <Badge tone="run" title="并发批次：这些节点正在同时推进">
                    并行 {activeNodes.length}
                  </Badge>
                )}
                {activeNodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    className="node-chip active"
                    onClick={() => onOpenLog(node.id)}
                    title="查看该节点日志"
                  >
                    {node.title || node.id}
                  </button>
                ))}
              </span>
            )}
            {queuedNodes.length > 0 && (
              <span className="muted small">· 排队 {queuedNodes.length} 个</span>
            )}
          </div>
        </div>

        <div className="kv">
          <div className="kv-label">已花 / 耗时</div>
          <div className="kv-value money">
            {formatUsd(flow?.budgetUsedUsd ?? aggregate.costFromEvents)}
            <span className="muted"> / {formatDuration(elapsed)}</span>
          </div>
        </div>

        <div className="kv">
          <div className="kv-label">流程健康</div>
          <div className="kv-value">
            <HealthBadge health={taskHealth} />
            {aggregate.nodes.length > 0 && (
              <span className="muted small">
                {' '}
                节点 {flow?.completedNodeIds.length ?? 0}/{flow?.nodes.length ?? aggregate.nodes.length}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="status-actions">
        {canCancel ? (
          confirming ? (
            <span className="confirm-row">
              <span className="tone-fail">确认取消？已花费用不会退回。</span>
              <button
                type="button"
                className="btn btn-xs btn-danger"
                disabled={cancelling || cancelBlocked}
                onClick={() => {
                  setConfirming(false);
                  onCancel();
                }}
              >
                确认取消
              </button>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setConfirming(false)}>
                算了
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-xs"
              disabled={cancelling || cancelBlocked}
              title={
                cancelBlocked
                  ? `后端缺少能力：${compat.missing.join(', ')}（版本落后），请重启服务后再试`
                  : '取消后任务进入 cancelled 终态；内核会终止在途 CLI 进程，但已花费用不退回'
              }
              onClick={() => setConfirming(true)}
            >
              {cancelling ? '取消中…' : '取消任务'}
            </button>
          )
        ) : (
          <span className="muted small" title="内核不提供原地重跑：重跑请用左侧「创建任务」新建一个任务（历史事件不会被覆盖）">
            重跑方式：新建任务
          </span>
        )}
      </div>

      {cancelNotice && <div className="status-note tone-warn">{cancelNotice}</div>}
      {cancelError && <div className="status-note tone-fail">取消失败：{cancelError}</div>}

      {/* 停滞处置：把"要不要我管"这个决策所需的全部事实放在结论层——
          哪个节点、多久没输出、系统会不会自动停、想立刻停该按哪儿。 */}
      {stalledNodes.length > 0 && (
        <div className="status-stall">
          <div className="status-stall-head">
            <b className="tone-warn">疑似停滞</b>
            {stalledNodes.map(({ node, ageMs }) => (
              <span key={node.id} className="status-stall-node">
                <button type="button" className="node-chip" onClick={() => onOpenLog(node.id)} title="查看该节点活日志">
                  {node.title || node.id}
                </button>
                <span className="muted small">已 {formatDuration(ageMs)} 无输出</span>
              </span>
            ))}
          </div>
          <div className="status-stall-body muted">
            {autoStopText(stallTimeoutMs)}（疑似停滞阈值 {STAGNANT_THRESHOLD_MS / 1000} 秒；判定依据是日志文件的
            最后写入时刻，不是"总耗时"——持续输出的长任务不会被误判）
          </div>
          {canCancel && (
            <div className="status-stall-actions">
              <button
                type="button"
                className="btn btn-xs btn-danger"
                disabled={cancelling || cancelBlocked}
                title={
                  cancelBlocked
                    ? `后端缺少能力：${compat.missing.join(', ')}（版本落后），请重启服务后再试`
                    : '内核只支持任务级取消：将终止整条流程的全部在途节点（已花费用不退回）'
                }
                onClick={() => setConfirming(true)}
              >
                {cancelling ? '停止中…' : '立即停止任务'}
              </button>
              <span className="muted small">想再等等就先不动：自动停止规则会按上面的阈值兜底。</span>
            </div>
          )}
        </div>
      )}

      {flowError && (
        <div className="status-note tone-warn">
          流转视图不可用（{flowError}）：下面的阶段与阻塞信息退化为事件流口径。
        </div>
      )}

      {(failedNodes.length > 0 || flow?.taskFailure) && (
        <div className="status-failure">
          <div className="status-failure-head">
            <b className="tone-fail">失败原因</b>
            {flow?.taskFailure?.label && <Badge tone="fail">{flow.taskFailure.label}</Badge>}
            {flow?.taskFailure?.category && (
              <code className="muted small">{flow.taskFailure.category}</code>
            )}
          </div>
          {flow?.taskFailure?.reason && (
            <div className="status-failure-body">{flow.taskFailure.reason}</div>
          )}
          {flow?.taskFailure && flow.taskFailure.unmetConditions.length > 0 && (
            <div className="status-failure-body muted">
              未满足条件：{flow.taskFailure.unmetConditions.join('；')}
            </div>
          )}
          {failedNodes.map((node) => (
            <div key={node.id} className="status-failure-node">
              <button type="button" className="node-chip" onClick={() => onOpenLog(node.id)}>
                {node.title || node.id}
              </button>
              <Badge tone="fail">{node.blockedReason?.label ?? '失败'}</Badge>
              <span className="node-error-inline" title={node.blockedReason?.error ?? ''}>
                {node.blockedReason?.error ?? node.enterReason?.reason ?? '（未记录原因）'}
              </span>
            </div>
          ))}
        </div>
      )}

      </section>
  );
}

/** 当前阶段的判定顺序：取消（终态，优先于失败余波）→ 任务级失败 → 终态 → 活跃节点 → 等待调度 */
function currentStage(flow: FlowView | null): {
  text: string;
  tone: 'ok' | 'run' | 'fail' | 'warn' | 'muted';
  detail?: string;
} {
  if (!flow) return { text: '加载中…', tone: 'muted' };
  if (flow.status === 'cancelled') return { text: '已取消（终态）', tone: 'warn' };
  if (flow.taskFailure) {
    return {
      text: '已失败',
      tone: 'fail',
      detail: `分类：${flow.taskFailure.label ?? flow.taskFailure.category ?? '其他'}`,
    };
  }
  if (flow.status === 'completed') return { text: '已完成', tone: 'ok' };
  if (flow.status === 'cancelled') return { text: '已取消（终态）', tone: 'warn' };
  if (flow.status === 'failed') return { text: '已失败', tone: 'fail' };

  const current = flow.nodes.filter((node) => node.current || node.status === 'running');
  if (current.length > 1) {
    return {
      text: current.map((node) => node.title || node.id).join(' ＋ '),
      tone: 'run',
      detail: `${current.length} 个节点并行推进中（内核并发批次）`,
    };
  }
  if (current.length === 1) {
    const node = current[0]!;
    return {
      text: node.title || node.id,
      tone: 'run',
      detail: node.enterReason?.reason ?? node.entryCondition ?? undefined,
    };
  }
  const queued = flow.nodes.filter((node) => node.status === 'queued');
  if (queued.length > 0) {
    return { text: `等待启动：${queued.map((n) => n.title || n.id).join('、')}`, tone: 'warn' };
  }
  return { text: '等待调度', tone: 'muted' };
}