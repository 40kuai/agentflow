/** 左侧任务列表：搜索 / 状态过滤 / 创建任务 */

import { useState, type FormEvent } from 'react';
import type { CreateTaskInput, TaskSummary } from '../api';
import { formatUsd, shortId } from '../format';
import { StatusBadge, TimeAgo } from './common';

type Props = {
  tasks: TaskSummary[];
  selectedId: string | null;
  error: string | null;
  onSelect: (taskId: string) => void;
  onCreate: (input: CreateTaskInput) => Promise<void>;
};

const STATUS_FILTERS = ['all', 'active', 'completed', 'failed'] as const;

export function TaskList({ tasks, selectedId, error, onSelect, onCreate }: Props) {
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
        <span className="muted small">诊断优先 · Phase 1</span>
      </div>

      <form className="create-form" onSubmit={handleSubmit}>
        <input
          placeholder="任务标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          placeholder="需求原文（requirementRaw）"
          rows={3}
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
        />
        <input
          placeholder="baseBranch（可选，默认 main）"
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? '创建中…' : '创建任务'}
        </button>
        {createError && <div className="inline-error">创建失败：{createError}</div>}
      </form>

      <div className="list-controls">
        <input
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
          <button
            key={task.taskId}
            type="button"
            className={`task-card${task.taskId === selectedId ? ' active' : ''}`}
            onClick={() => onSelect(task.taskId)}
          >
            <div className="task-card-top">
              <span className="task-title">{task.title || '（无标题）'}</span>
              <StatusBadge status={task.status} />
            </div>
            <div className="task-card-meta">
              <span className="money">{formatUsd(task.budgetUsedUsd)}</span>
              <span className="muted">
                节点 {task.completedNodeCount ?? 0}/{task.nodeCount ?? 0}
              </span>
              <TimeAgo ts={task.updatedAt} />
            </div>
            <div className="task-card-id mono" title={task.taskId}>
              {shortId(task.taskId, 22)}
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}