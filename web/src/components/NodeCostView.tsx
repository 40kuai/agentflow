/** 节点与成本视图：回答"钱花在哪、每个节点跑了多久、错在哪" */

import type { TaskAggregate, NodeAggregate } from '../aggregate';
import type { TaskState } from '../api';
import { formatAbsoluteTime, formatCount, formatDuration, formatUsd, shortId } from '../format';
import { ArtifactStatusBadge, Badge, EmptyState, KeyValue, Section, StatusBadge, TimeAgo } from './common';

type Props = {
  state: TaskState;
  aggregate: TaskAggregate;
  onOpenLog: (nodeId: string) => void;
  onOpenArtifacts: () => void;
};

export function NodeCostView({ state, aggregate, onOpenLog, onOpenArtifacts }: Props) {
  const artifactById = new Map(state.artifacts.map((a) => [a.artifact_id, a]));
  const now = Date.now();

  if (aggregate.nodes.length === 0) {
    return <EmptyState>该任务还没有任何节点。运行中的任务会在节点开始后出现在这里。</EmptyState>;
  }

  return (
    <div className="node-view">
      <Section title="任务级核算">
        <div className="kv-grid">
          <KeyValue label="开始时间">
            <span title={formatAbsoluteTime(aggregate.taskStartedAt)}>
              {formatAbsoluteTime(aggregate.taskStartedAt)}
            </span>
          </KeyValue>
          <KeyValue label="结束时间">
            {aggregate.taskEndedAt ? (
              <span title={formatAbsoluteTime(aggregate.taskEndedAt)}>
                {formatAbsoluteTime(aggregate.taskEndedAt)}
              </span>
            ) : (
              <span className="muted">未结束</span>
            )}
          </KeyValue>
          <KeyValue label="总耗时">
            {formatDuration(
              aggregate.taskStartedAt
                ? (aggregate.taskEndedAt ?? now) - aggregate.taskStartedAt
                : null,
            )}
          </KeyValue>
          <KeyValue label="budgetUsedUsd（TaskState）">{formatUsd(state.budgetUsedUsd)}</KeyValue>
          <KeyValue label="事件归集花费（node.usage_recorded 合计）">
            {formatUsd(aggregate.costFromUsageEvents)}
          </KeyValue>
          <KeyValue label="事件归集花费（budget.consumed 合计，仅核对）">
            {formatUsd(aggregate.costFromBudgetEvents)}
          </KeyValue>
          <KeyValue label="事件条数">{formatCount(aggregate.eventCount)}</KeyValue>
          <KeyValue label="工作流节点进度">
            {aggregate.nodes.filter((n) => n.status === 'succeeded').length} / {aggregate.nodes.length}
            <span className="muted">（completedNodeIds {state.completedNodeIds.length}）</span>
          </KeyValue>
        </div>
        <div className="notice">
          节点级花费由事件流归集：优先取 <code>node.usage_recorded</code>（payload 含 node_id + cost_usd），
          未覆盖的 <code>budget.consumed</code>（payload 只有 run_id）按 run_id → node_id 反查补记，避免同一笔花费被计两次。
        </div>
        <div className="notice">
          Phase 1 串行执行，<code>env.globalConcurrency</code> 暂无消费者，本页面不展示任何并行度指标；并发调度属 Phase 2。
        </div>
      </Section>

      <Section title={`节点（${aggregate.nodes.length}）`}>
        <div className="node-grid">
          {aggregate.nodes.map((node) => (
            <NodeCard
              key={node.nodeId}
              node={node}
              transfers={state.transfers.filter((t) => t.to === node.nodeId)}
              artifacts={node.artifactIds.map((id) => artifactById.get(id) ?? null)}
              onOpenLog={onOpenLog}
              onOpenArtifacts={onOpenArtifacts}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

function NodeCard({
  node,
  transfers,
  artifacts,
  onOpenLog,
  onOpenArtifacts,
}: {
  node: NodeAggregate;
  transfers: TaskState['transfers'];
  artifacts: (TaskState['artifacts'][number] | null)[];
  onOpenLog: (nodeId: string) => void;
  onOpenArtifacts: () => void;
}) {
  const lastTransfer = transfers.at(-1);
  const failed = node.status === 'failed';

  return (
    <div className={`node-card${failed ? ' is-failed' : ''}`}>
      <div className="node-card-head">
        <div className="node-card-title">
          <span className="node-name">{node.nodeId}</span>
          {node.roleId && <Badge tone="muted">{node.roleId}</Badge>}
        </div>
        <StatusBadge status={node.status} />
      </div>

      <div className="node-metrics">
        <div className="node-metric">
          <span className="label">尝试</span>
          <span className="value">第 {node.attempt} 次</span>
        </div>
        <div className="node-metric">
          <span className="label">耗时</span>
          <span className="value">{formatDuration(node.durationMs)}</span>
        </div>
        <div className="node-metric">
          <span className="label">花费</span>
          <span className="value money">{formatUsd(node.costUsd)}</span>
        </div>
        <div className="node-metric">
          <span className="label">tokens</span>
          <span className="value">
            {formatCount(node.tokensIn)}/{formatCount(node.tokensOut)}
          </span>
        </div>
        <div className="node-metric">
          <span className="label">产物</span>
          <span className="value">{node.artifactIds.length}</span>
        </div>
        <div className="node-metric">
          <span className="label">访问次数</span>
          <span className="value">{node.visitCount}</span>
        </div>
      </div>

      <div className="node-meta-row">
        <span className="muted">runId</span>
        <span className="mono">{node.runId ? shortId(node.runId, 18) : '—'}</span>
        {node.lastLogRef ? (
          <span className="mono muted ellipsis" title={node.lastLogRef}>
            {node.lastLogRef}
          </span>
        ) : (
          <span className="muted">无日志引用</span>
        )}
      </div>

      {lastTransfer && (
        <div className="transfer-line">
          <span className="muted">{lastTransfer.from || '（起点）'} → {lastTransfer.to}</span>
          <Badge tone={lastTransfer.decidedBy === 'rule' ? 'muted' : 'run'}>{lastTransfer.decidedBy}</Badge>
          <span className="transfer-reason">{lastTransfer.reason || '未给出理由'}</span>
        </div>
      )}

      {node.lastError && (
        <div className="node-error">
          <div className="node-error-title">lastError</div>
          <div className="node-error-body">{node.lastError}</div>
        </div>
      )}

      {node.runs.length > 0 && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>run</th>
              <th>开始</th>
              <th>状态</th>
              <th className="num">耗时</th>
              <th className="num">花费</th>
            </tr>
          </thead>
          <tbody>
            {node.runs.map((run) => (
              <tr key={run.runId}>
                <td className="mono" title={run.runId}>
                  {shortId(run.runId, 14)}
                </td>
                <td>
                  <TimeAgo ts={run.startedAt} />
                </td>
                <td>
                  <StatusBadge status={run.status} />
                </td>
                <td className="num">
                  {formatDuration(
                    run.startedAt !== null
                      ? (run.endedAt ?? (run.status === 'running' ? Date.now() : run.startedAt)) -
                          run.startedAt
                      : null,
                  )}
                </td>
                <td className="num money">{formatUsd(run.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {artifacts.length > 0 && (
        <div className="node-artifacts">
          {artifacts.map((artifact, index) =>
            artifact ? (
              <button
                key={artifact.artifact_id}
                type="button"
                className="artifact-chip"
                onClick={onOpenArtifacts}
                title={artifact.summary}
              >
                {artifact.type}
                <ArtifactStatusBadge status={artifact.status} />
              </button>
            ) : (
              <span key={`missing-${index}`} className="muted">
                （产物索引失效）
              </span>
            ),
          )}
        </div>
      )}

      <div className="node-actions">
        <button type="button" className="btn btn-xs btn-primary" onClick={() => onOpenLog(node.nodeId)}>
          查看日志
        </button>
      </div>
    </div>
  );
}