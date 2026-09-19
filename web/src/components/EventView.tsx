/** 事件流浏览器：回答"系统做了什么判断"，transfer.decided 的 reason / decided_by 是重点 */

import { Fragment, useMemo, useState } from 'react';
import type { KernelEvent } from '../api';
import {
  asNumber,
  asRecord,
  asString,
  eventTime,
  formatClock,
  formatCount,
  formatRelativeTime,
  formatAbsoluteTime,
  formatUsd,
} from '../format';
import { Badge, EmptyState, JsonBlock, Section } from './common';

type Props = {
  events: KernelEvent[];
};

/** 事件类型 → 语义色（未知类型回落 muted，不崩） */
function eventTone(type: string): 'ok' | 'run' | 'fail' | 'warn' | 'muted' {
  switch (type) {
    case 'task.completed':
      return 'ok';
    case 'task.failed':
    case 'node.failed':
    case 'budget.exceeded':
      return 'fail';
    case 'node.started':
    case 'node.queued':
    case 'wp.started':
      return 'run';
    case 'transfer.decided':
    case 'artifact.invalidated':
    case 'node.cancelled':
      return 'warn';
    case 'artifact.created':
      return 'ok';
    default:
      return 'muted';
  }
}

/** 单行摘要：让表格本身就能回答"这条事件在说什么" */
function summarize(event: KernelEvent): string {
  const payload = event.payload ?? {};
  const nodeId = asString(payload['node_id']);
  switch (event.type) {
    case 'task.created':
      return `title=${asString(payload['title'])} · base_branch=${asString(payload['base_branch'])}`;
    case 'task.completed':
    case 'task.failed':
      return asString(payload['reason'], '（无 reason）');
    case 'node.queued':
    case 'node.started':
      return `${nodeId} · role=${asString(payload['role_id'])} · run=${asString(payload['run_id'])} · 第 ${payload['attempt'] ?? '?'} 次`;
    case 'node.succeeded':
    case 'node.cancelled':
      return `${nodeId} · run=${asString(payload['run_id'])}`;
    case 'node.failed':
      return `${nodeId} · ${asString(payload['error'], '（无 error）')}`;
    case 'node.usage_recorded': {
      // cost_usd / tokens_* 是数字型字段，必须走 asNumber，不能用 asString（对数字返回空串）
      const tokensIn = payload['tokens_in'];
      const tokensOut = payload['tokens_out'];
      return `${nodeId} · cost=${formatUsd(asNumber(payload['cost_usd']))} · in=${
        typeof tokensIn === 'number' ? formatCount(tokensIn) : '?'
      } out=${typeof tokensOut === 'number' ? formatCount(tokensOut) : '?'}`;
    }
    case 'budget.consumed':
      return `run=${asString(payload['run_id'])} · cost=${formatUsd(asNumber(payload['cost_usd']))}`;
    case 'budget.exceeded':
      return asString(payload['reason'], '（无 reason）');
    case 'artifact.created':
      return `${asString(payload['type'])} · status=${asString(payload['status'])} · node=${nodeId}`;
    case 'artifact.invalidated':
      return `artifact=${asString(payload['artifact_id'])}`;
    case 'transfer.decided':
      return `${asString(payload['from']) || '（起点）'} → ${asString(payload['to'])}`;
    default:
      return Object.keys(payload).length > 0 ? JSON.stringify(payload).slice(0, 120) : '（无 payload）';
  }
}

export function EventView({ events }: Props) {
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [onlyDecisions, setOnlyDecisions] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [events]);

  const filtered = useMemo(() => {
    let list = events;
    if (typeFilter !== 'all') list = list.filter((event) => event.type === typeFilter);
    if (onlyDecisions) list = list.filter((event) => event.type === 'transfer.decided');
    return list;
  }, [events, typeFilter, onlyDecisions]);

  function toggle(seq: number): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }

  if (events.length === 0) {
    return <EmptyState>该任务还没有事件。事件库为空通常意味着任务刚创建或事件读取失败。</EmptyState>;
  }

  return (
    <div className="event-view">
      <Section
        title={`事件（${events.length}）`}
        right={
          <button
            type="button"
            className={`tab-btn${onlyDecisions ? ' active' : ''}`}
            onClick={() => setOnlyDecisions((v) => !v)}
          >
            只看 transfer.decided
          </button>
        }
      >
        <div className="type-filter">
          <button
            type="button"
            className={`tab-btn${typeFilter === 'all' ? ' active' : ''}`}
            onClick={() => setTypeFilter('all')}
          >
            全部 {events.length}
          </button>
          {typeCounts.map(([type, count]) => (
            <button
              key={type}
              type="button"
              className={`tab-btn${typeFilter === type ? ' active' : ''}`}
              onClick={() => setTypeFilter(type)}
            >
              {type} {count}
            </button>
          ))}
        </div>

        <table className="event-table">
          <thead>
            <tr>
              <th className="num">seq</th>
              <th>类型</th>
              <th>actor</th>
              <th>时间</th>
              <th>摘要</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((event) => {
              const isOpen = expanded.has(event.seq);
              const time = eventTime(event);
              return (
                <Fragment key={event.seq}>
                  <tr
                    className={`event-row${isOpen ? ' open' : ''}`}
                    onClick={() => toggle(event.seq)}
                  >
                    <td className="num mono">{event.seq}</td>
                    <td>
                      <Badge tone={eventTone(event.type)}>{event.type}</Badge>
                    </td>
                    <td className="mono">{event.actor}</td>
                    <td
                      className="mono nowrap"
                      title={`${formatAbsoluteTime(time)} · ${formatClock(time)}`}
                    >
                      {formatRelativeTime(time)}
                    </td>
                    <td>{summarize(event)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="event-detail-row">
                      <td colSpan={5}>
                        {event.type === 'transfer.decided' && (
                          <div className="transfer-detail">
                            <div>
                              <span className="muted">from → to：</span>
                              <b>
                                {asString(asRecord(event.payload)?.['from']) || '（起点）'} →{' '}
                                {asString(asRecord(event.payload)?.['to'])}
                              </b>
                            </div>
                            <div>
                              <span className="muted">decidedBy：</span>
                              <Badge
                                tone={
                                  asString(asRecord(event.payload)?.['decided_by']) === 'rule'
                                    ? 'muted'
                                    : 'run'
                                }
                              >
                                {asString(asRecord(event.payload)?.['decided_by'], 'unknown')}
                              </Badge>
                            </div>
                            <div>
                              <span className="muted">reason：</span>
                              {asString(asRecord(event.payload)?.['reason'], '（未给出理由）')}
                            </div>
                          </div>
                        )}
                        <JsonBlock value={event.payload ?? {}} maxHeight={360} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        {filtered.length === 0 && <EmptyState>当前过滤条件下没有事件。</EmptyState>}
      </Section>
    </div>
  );
}