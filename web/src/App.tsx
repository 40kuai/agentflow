import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  createTask,
  getTask,
  listTasks,
  openEventSocket,
  type TaskStateDto,
  type TaskSummaryDto,
} from './api';

export function App() {
  const [tasks, setTasks] = useState<TaskSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskStateDto | null>(null);
  const [title, setTitle] = useState('');
  const [requirement, setRequirement] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const selectedRef = useRef<string | null>(null);

  selectedRef.current = selectedId;

  const refreshList = useCallback(async () => {
    setTasks(await listTasks());
  }, []);

  const refreshDetail = useCallback(async (taskId: string) => {
    setDetail(await getTask(taskId));
  }, []);

  useEffect(() => {
    void refreshList();
    const socket = openEventSocket((message) => {
      const msg = message as { type?: string; state?: TaskStateDto };
      void refreshList();
      if (msg.type === 'task_state' && msg.state && msg.state.taskId === selectedRef.current) {
        setDetail(msg.state);
      }
    });
    return () => socket.close();
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void refreshDetail(selectedId);
    const timer = setInterval(() => void refreshDetail(selectedId), 2000);
    return () => clearInterval(timer);
  }, [selectedId, refreshDetail]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!title.trim() || !requirement.trim()) return;
    setSubmitting(true);
    try {
      const { taskId } = await createTask({ title, requirementRaw: requirement });
      setTitle('');
      setRequirement('');
      await refreshList();
      setSelectedId(taskId);
    } finally {
      setSubmitting(false);
    }
  }

  const orderedNodes = detail
    ? Object.values(detail.nodes).sort((a, b) => {
        const ai = detail.completedNodeIds.indexOf(a.nodeId);
        const bi = detail.completedNodeIds.indexOf(b.nodeId);
        if (ai === -1 && bi === -1) return a.nodeId.localeCompare(b.nodeId);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      })
    : [];

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>AgentFlow 观测台</h1>

        <form className="create-form" onSubmit={handleSubmit}>
          <input
            placeholder="任务标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            placeholder="原始需求"
            rows={3}
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
          />
          <button type="submit" disabled={submitting}>
            {submitting ? '提交中…' : '创建任务'}
          </button>
        </form>

        {tasks.map((task) => (
          <div
            key={task.taskId}
            className={`task-card${task.taskId === selectedId ? ' active' : ''}`}
            onClick={() => setSelectedId(task.taskId)}
          >
            <div className="title">{task.title}</div>
            <div className="meta">
              {task.status} · {task.taskId.slice(0, 12)}…
            </div>
          </div>
        ))}
      </aside>

      <main className="detail">
        {!detail && <div className="empty">选择或创建一个任务</div>}

        {detail && (
          <>
            <h2>{detail.title}</h2>
            <div className="sub">
              状态 {detail.status} · 已消耗 ${detail.budgetUsedUsd.toFixed(4)} · 并行度{' '}
              {detail.currentNodeIds.length}（Phase 1 串行执行，并发调度属 Phase 2）
            </div>

            <div className="timeline">
              {orderedNodes.map((node) => {
                const artifacts = detail.artifacts.filter((a) =>
                  node.artifactIds.includes(a.artifact_id),
                );
                const transfer = detail.transfers.find((t) => t.to === node.nodeId);
                return (
                  <div key={node.nodeId} className={`node-row ${node.status}`}>
                    <div className="node-title">
                      {node.nodeId} · {node.roleId}
                    </div>
                    <div className={`node-status ${node.status === 'failed' ? 'failed' : ''}`}>
                      第 {node.attempt} 次 · {node.status}
                      {node.lastError ? ` · ${node.lastError}` : ''}
                    </div>
                    {transfer && <p className="transfer">进入理由：{transfer.reason}</p>}
                    {artifacts.map((a) => (
                      <div key={a.artifact_id} className="artifact">
                        <div className="type">
                          {a.type} · {a.status}
                        </div>
                        <pre>{a.summary}</pre>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>
    </div>
  );
}