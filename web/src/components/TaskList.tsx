/**
 * 左侧任务列表（第一层）：一行回答"这个任务现在怎么样了"。
 *
 * 每项显示：状态点 + 标题 + 一句话摘要（进度/花费/耗时）+ 当前阶段。
 * 「当前阶段」来自流转视图（`/api/tasks/:id/flow`）——这是唯一能回答"卡在哪一步"的数据源，
 * 没有它列表只能给出"节点 1/3"这种没有语义的进度。
 */

import { useState, type FormEvent } from 'react';
import type { CreateTaskInput, FlowView, TaskSummary } from '../api';
import { formatDuration, formatUsd, shortId } from '../format';
import { StatusBadge, TimeAgo, statusTone } from './common';

type Props = {
  tasks: TaskSummary[];
  /** 按 taskId 索引的流转视图（列表轮询时一并刷新）；缺失表示尚未取到 */
  flows: Record<string, FlowView>;
  selectedId: string | null;
  error: string | null;
  onSelect: (taskId: string) => void;
  onCreate: (input: CreateTaskInput) => Promise<void>;
};

const STATUS_FILTERS = ['all', 'active', 'completed', 'failed', 'cancelled'] as const;

export function TaskList({ tasks, flows, selectedId, error, onSelect, onCreate }: Props) {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [requirement, setRequirement] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const filtered = tasks.filter((task) => {
    if (statusFilter !== 'all' && task.status !== statusFilter) return false;
    if (!needle) return true;
    return (
      (task.title ?? '').toLowerCase().includes(needle) ||
      (task.taskId ?? '').toLowerCase().includes(needle)
    );
  });

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!title.trim() || !requirement.trim() || submitting) return;
    setSubmitting(true);
    setCreateError(null);
    try {
      const input: CreateTaskInput = { title: title.trim(), requirementRaw: requirement.trim() };
      const branch = baseBranch.trim();
      if (branch) input.baseBranch = branch;
      await onCreate(input);
      setTitle('');
      setRequirement('');
      setBaseBranch('');
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h1>AgentFlow 管理台</h1>
        <span className="muted small">任务 → 状态 → 流程</span>
      </div>

      <form className="create-form" onSubmit={handleSubmit}>
        <input
          id="create-title"
          name="title"
          aria-label="任务标题"
          placeholder="任务标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          id="create-requirement"
          name="requirementRaw"
          aria-label="需求原文"
          placeholder="需求原文（requirementRaw）"
          rows={3}
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
        />
        <input
          id="create-base-branch"
          name="baseBranch"
          aria-label="baseBranch"
          placeholder="baseBranch（可选，默认 main）"
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? '创建中…' : '创建任务'}
        </button>
        <div className="muted small">
          创建即真实调用 claude 并产生费用，无法从界面取消花费。
        </div>
        {createError && <div className="inline-error">创建失败：{createError}</div>}
      </form>

      <div className="list-controls">
        <input
          id="task-search"
          name="taskSearch"
          aria-label="按标题或 ID 搜索任务"
          placeholder="按标题 / ID 搜索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="filters">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className={`tab-btn tiny${statusFilter === option ? ' active' : ''}`}
              onClick={() => setStatusFilter(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="inline-error">任务列表加载失败：{error}</div>}

      <div className="task-list">
        {filtered.length === 0 && (
          <div className="empty-state small">
            {tasks.length === 0 ? '还没有任务，先创建一个。' : '没有符合过滤条件的任务。'}
          </div>
        )}

        {filtered.map((task) => (
          <TaskCard
            key={task.taskId}
            task={task}
            flow={flows[task.taskId]}
            selected={task.taskId === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
}

function TaskCard({
  task,
  flow,
  selected,
  onSelect,
}: {
  task: TaskSummary;
  flow: FlowView | undefined;
  selected: boolean;
  onSelect: (taskId: string) => void;
}) {
  const elapsed =
    task.updatedAt && task.createdAt ? Math.max(0, task.updatedAt - task.createdAt) : null;

  return (
    <button
      type="button"
      className={`task-card${selected ? ' active' : ''}`}
      onClick={() => onSelect(task.taskId)}
    >
      <div className="task-card-top">
        <span className={`dot tone-${statusTone(task.status)}`} />
        <span className="task-title">{task.title || '（无标题）'}</span>
        <StatusBadge status={task.status} />
      </div>

      <div className="task-card-line">{oneLine(task, flow)}</div>

      <div className="task-card-stage" title="当前阶段来自流转视图 /api/tasks/:id/flow">
        <span className="muted small">当前阶段</span>
        <span className="stage-text">{stageOf(task, flow)}</span>
      </div>

      <div className="task-card-meta">
        <span className="money">{formatUsd(task.budgetUsedUsd)}</span>
        <span className="muted">
          节点 {task.completedNodeCount ?? 0}/{task.nodeCount ?? 0}
        </span>
        {elapsed !== null && <span className="muted">{formatDuration(elapsed)}</span>}
        <TimeAgo ts={task.updatedAt} />
      </div>
      <div className="task-card-id mono" title={task.taskId}>
        {shortId(task.taskId, 22)}
      </div>
    </button>
  );
}

/** 一句话摘要：由任务摘要字段派生，绝不编造流转视图里没有的状态 */
function oneLine(task: TaskSummary, flow: FlowView | undefined): string {
  const progress = `${task.completedNodeCount ?? 0}/${task.nodeCount ?? 0}`;
  if (flow?.taskFailure) {
    const where = flow.nodes.find((node) => node.status === 'failed');
    return `失败：${flow.taskFailure.label ?? '未分类'}${where ? `（${where.title || where.id}）` : ''} · 节点 ${progress}`;
  }
  switch (task.status) {
    case 'completed':
      return `已完成 · 节点 ${progress}`;
    case 'cancelled':
      return `已取消 · 节点 ${progress}`;
    case 'failed':
      return `已失败 · 节点 ${progress}`;
    default:
      return `运行中 · 节点 ${progress}`;
  }
}

function stageOf(task: TaskSummary, flow: FlowView | undefined): string {
  if (!flow) return task.status === 'active' ? '（流转视图加载中…）' : '—';
  if (flow.taskFailure) {
    const where = flow.nodes.find((node) => node.status === 'failed');
    return where ? `失败于 ${where.title || where.id}` : '已失败';
  }
  if (flow.status === 'completed') return '已完成（终态）';
  if (flow.status === 'cancelled') return '已取消（终态）';
  if (flow.status === 'failed') return '已失败（终态）';
  const current = flow.nodes.filter((node) => node.current || node.status === 'running');
  if (current.length > 0) {
    return current.map((node) => node.title || node.id).join(' ＋ ');
  }
  const queued = flow.nodes.filter((node) => node.status === 'queued');
  if (queued.length > 0) return `等待启动 ${queued.length} 个节点`;
  return '等待调度';
}