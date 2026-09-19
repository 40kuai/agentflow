/** AgentFlow 内部管理台：诊断优先的运维控制台（三栏：任务列表 / 主区标签页） */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createTask,
  getHealth,
  getTask,
  getTaskEvents,
  listTasks,
  openEventSocket,
  type CreateTaskInput,
  type KernelEvent,
  type TaskState,
  type TaskSummary,
} from './api';
import { aggregateTask, type NodeAggregate } from './aggregate';
import { ArtifactView } from './components/ArtifactView';
import { EventView } from './components/EventView';
import { LogViewer } from './components/LogViewer';
import { NodeCostView } from './components/NodeCostView';
import { TaskList } from './components/TaskList';
import {
  Badge,
  Collapsible,
  EmptyState,
  HealthBadge,
  PreBlock,
  StatusBadge,
  TimeAgo,
} from './components/common';
import { formatAbsoluteTime, formatDuration, formatUsd, shortId } from './format';
import {
  backendCompatibility,
  computeTaskHealth,
  fetchNodeLiveness,
  type BackendHealth,
  type NodeLiveness,
} from './liveness';

type TabId = 'nodes' | 'logs' | 'artifacts' | 'events';

const POLL_DETAIL_MS = 2000;
const POLL_LIST_MS = 5000;

function isTerminal(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'failed';
}

export function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskState | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [events, setEvents] = useState<KernelEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  // 后端健康探测结果：包含能力集，用于区分「后端版本落后」与「日志确实不存在」
  const [backend, setBackend] = useState<BackendHealth>({ status: 'unknown' });
  // 运行中节点的活性快照（日志文件 mtime/size），由轮询刷新
  const [liveness, setLiveness] = useState<Record<string, NodeLiveness>>({});
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [taskErrorMessage, setTaskErrorMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('nodes');
  const [logFocusNodeId, setLogFocusNodeId] = useState<string | null>(null);
  const [listTick, setListTick] = useState(0);

  // nodes / liveness 用 ref 读，避免把每轮新对象放进轮询 effect 的依赖里造成重复拉取
  const nodesRef = useRef<NodeAggregate[]>([]);
  const livenessRef = useRef<Record<string, NodeLiveness>>({});
  livenessRef.current = liveness;

  const probeHealth = useCallback(async () => {
    try {
      setBackend({ status: 'ok', info: await getHealth() });
    } catch (err) {
      setBackend({ status: 'down', error: (err as Error).message });
    }
  }, []);

  const refreshList = useCallback(async () => {
    try {
      setTasks(await listTasks());
      setTasksError(null);
    } catch (err) {
      // 容错：保留上次数据，下一轮自愈
      setTasksError((err as Error).message);
    }
  }, []);

  const refreshDetail = useCallback(async (taskId: string) => {
    try {
      setDetail(await getTask(taskId));
      setDetailError(null);
    } catch (err) {
      setDetailError((err as Error).message);
    }
  }, []);

  const refreshEvents = useCallback(async (taskId: string) => {
    try {
      setEvents(await getTaskEvents(taskId));
      setEventsError(null);
    } catch (err) {
      setEventsError((err as Error).message);
    }
  }, []);

  /**
   * 刷新运行中节点的活性：拉活日志、算 mtime/size 增量、解析当前动作。
   * 只对 running 节点发请求；无 running 节点时清空，避免展示过期活性。
   */
  const refreshLiveness = useCallback(async (taskId: string) => {
    const targets = nodesRef.current.filter((node) => node.status === 'running');
    if (targets.length === 0) {
      setLiveness({});
      return;
    }
    const results = await Promise.all(
      targets.map((node) =>
        fetchNodeLiveness(
          taskId,
          { nodeId: node.nodeId, runId: node.runId, lastLogRef: node.lastLogRef },
          livenessRef.current[node.nodeId],
        ),
      ),
    );
    const next: Record<string, NodeLiveness> = {};
    for (const item of results) next[item.nodeId] = item;
    setLiveness(next);
  }, []);

  // 列表轮询 + 健康检查 + WebSocket（WS 只是补充，不替代轮询）
  useEffect(() => {
    void refreshList();
    void probeHealth();

    const unsubscribe = openEventSocket(
      (message) => {
        if (message.type === 'task_state') {
          setDetail((current) =>
            current && message.state?.taskId === current.taskId ? message.state : current,
          );
          setListTick((v) => v + 1);
        } else if (message.type === 'task_error') {
          setTaskErrorMessage(`${message.taskId}：${message.message}`);
        }
      },
      (status) => setWsStatus(status),
    );

    return unsubscribe;
  }, [refreshList, probeHealth]);

  // WS 收到 task_state 时补一次列表刷新
  useEffect(() => {
    if (listTick === 0) return;
    void refreshList();
  }, [listTick, refreshList]);

  // 每次列表轮询都重新探测后端能力（A 项：启动与每次轮询都探测）
  useEffect(() => {
    const timer = setInterval(() => {
      void refreshList();
      void probeHealth();
    }, POLL_LIST_MS);
    return () => clearInterval(timer);
  }, [refreshList, probeHealth]);

  // 选中任务：先清空旧数据，避免把上一个任务的内容张冠李戴
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setEvents([]);
      setDetailError(null);
      setEventsError(null);
      return;
    }
    void refreshDetail(selectedId);
    void refreshEvents(selectedId);
  }, [selectedId, refreshDetail, refreshEvents]);

  // 运行中每 2 秒轮询；进入终态后停止
  const terminal = isTerminal(detail?.status);
  useEffect(() => {
    if (!selectedId || terminal) return;
    const timer = setInterval(() => {
      void refreshDetail(selectedId);
      void refreshEvents(selectedId);
    }, POLL_DETAIL_MS);
    return () => clearInterval(timer);
  }, [selectedId, terminal, refreshDetail, refreshEvents]);

  const aggregate = useMemo(() => aggregateTask(detail, events, Date.now()), [detail, events]);

  // 每次渲染都把最新节点列表交给 ref：轮询回调据此决定对哪些节点抓活性
  nodesRef.current = aggregate.nodes;

  const failedNodes = useMemo(
    () => aggregate.nodes.filter((node) => node.status === 'failed'),
    [aggregate.nodes],
  );

  // 运行中节点集合的稳定指纹：只有它变化时才重启活性轮询，避免每 2 秒重建定时器
  const runningKey = useMemo(
    () =>
      aggregate.nodes
        .filter((node) => node.status === 'running')
        .map((node) => `${node.nodeId}:${node.runId ?? ''}`)
        .join('|'),
    [aggregate.nodes],
  );

  // 活性轮询：与详情轮询同频（2 秒）；进入终态后停止
  useEffect(() => {
    if (!selectedId || terminal) return;
    void refreshLiveness(selectedId);
    const timer = setInterval(() => void refreshLiveness(selectedId), POLL_DETAIL_MS);
    return () => clearInterval(timer);
  }, [selectedId, terminal, runningKey, refreshLiveness]);

  // 后端能力兼容性（缺能力 → 版本落后）+ 任务级健康判定（D 项）
  const compat = useMemo(() => backendCompatibility(backend), [backend]);
  const taskHealth = useMemo(
    () =>
      detail
        ? computeTaskHealth({
            status: detail.status,
            nodes: aggregate.nodes,
            liveness,
            compat,
            now: Date.now(),
          })
        : null,
    [detail, aggregate.nodes, liveness, compat],
  );

  const handleSelect = useCallback((taskId: string) => {
    setSelectedId(taskId);
    setDetail(null);
    setEvents([]);
    setDetailError(null);
    setEventsError(null);
    setTaskErrorMessage(null);
    setLogFocusNodeId(null);
    setLiveness({});
    // 切任务回到「节点与成本」：新任务未必有日志，留在「日志」标签会看到空态造成误解
    setTab('nodes');
  }, []);

  const handleCreate = useCallback(
    async (input: CreateTaskInput) => {
      const { taskId } = await createTask(input);
      handleSelect(taskId);
      setTab('nodes');
      await refreshList();
    },
    [handleSelect, refreshList],
  );

  const openLog = useCallback((nodeId: string) => {
    setLogFocusNodeId(nodeId);
    setTab('logs');
  }, []);

  // 状态区派生值：后端可达性 + 能力兼容 + claude 进程（E 项）
  const claudeProcCount =
    backend.status === 'ok' ? (backend.info.claudeProcesses?.length ?? 0) : 0;
  const backendClass =
    backend.status === 'ok' ? 'ok' : backend.status === 'down' ? 'down' : 'unknown';
  const backendLabel =
    backend.status === 'ok'
      ? `正常${typeof backend.info.pid === 'number' ? ` · pid ${backend.info.pid}` : ''}`
      : backend.status === 'down'
        ? '不可达'
        : '检测中';
  const backendTitle =
    backend.status === 'ok'
      ? `后端 pid ${backend.info.pid ?? '?'}，启动于 ${formatAbsoluteTime(
          backend.info.startedAt,
        )}，能力：${(backend.info.features ?? []).join(', ') || '（未声明）'}`
      : backend.status === 'down'
        ? `后端不可达：${backend.error}`
        : '正在探测后端能力…';

  return (
    <div className="layout">
      <TaskList
        tasks={tasks}
        selectedId={selectedId}
        error={tasksError}
        onSelect={handleSelect}
        onCreate={handleCreate}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            {detail ? (
              <>
                <h2>{detail.title || '（无标题任务）'}</h2>
                <span className="mono muted" title={detail.taskId}>
                  {shortId(detail.taskId, 28)}
                </span>
                <StatusBadge status={detail.status} />
                <HealthBadge health={taskHealth} />
                <Badge tone="muted">baseBranch {detail.baseBranch || 'main'}</Badge>
              </>
            ) : (
              <h2>未选择任务</h2>
            )}
          </div>
          <div className="topbar-right">
            <span className={`health health-${backendClass}`} title={backendTitle}>
              API {backendLabel}
            </span>
            {compat.kind === 'stale' && (
              <span
                className="health health-down"
                title={`后端缺少能力：${compat.missing.join(
                  ', ',
                )}。后端版本落后于前端，请重启服务后再试。`}
              >
                后端版本落后
              </span>
            )}
            {claudeProcCount > 0 && (
              <span
                className="health health-warn"
                title="平台监听 127.0.0.1、面向 macOS 单机；内核不记录 spawn 的 PID，无法精确关联 PID↔runId。若当前没有运行中节点，这些进程基本可判定为孤儿残留（不会自动清理）。"
              >
                claude 进程 {claudeProcCount} · 可能有孤儿残留
              </span>
            )}
            <span className={`health health-${wsStatus === 'open' ? 'ok' : wsStatus === 'closed' ? 'down' : 'unknown'}`}>
              WS {wsStatus === 'open' ? '已连接' : wsStatus === 'closed' ? '已断开（自动重连）' : '连接中'}
            </span>
          </div>
        </header>

        {taskErrorMessage && (
          <div className="banner banner-fail">
            <b>内核上报任务异常：</b>
            <span>{taskErrorMessage}</span>
          </div>
        )}

        {taskHealth && (taskHealth.label === '疑似停滞' || taskHealth.label === '无法判断') && (
          <div className="banner banner-warn">
            <b>流程健康：{taskHealth.label}</b>
            <span>{taskHealth.reason}</span>
          </div>
        )}

        {!selectedId && (
          <EmptyState>
            左侧选择一个任务，或填写标题 + 需求原文创建新任务。
            <br />
            任务失败时优先看「日志」标签：对话视图能还原模型每一步，诊断视图会自动扫描权限拒绝、
            <code>is_error</code>、<code>subtype</code> 与终局 <code>result</code>。
          </EmptyState>
        )}

        {selectedId && (
          <>
            {detailError && (
              <div className="banner banner-fail">
                <b>任务详情获取失败：</b>
                <span>{detailError}</span>
                <span className="muted">（保留上次成功的数据，下一轮轮询自动重试）</span>
              </div>
            )}

            {detail && (
              <>
                <div className="summary-bar">
                  <div className="kv">
                    <div className="kv-label">总花费</div>
                    <div className="kv-value money">{formatUsd(detail.budgetUsedUsd)}</div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">节点进度</div>
                    <div className="kv-value">
                      {aggregate.nodes.filter((n) => n.status === 'succeeded').length}/
                      {aggregate.nodes.length === 0 ? Object.keys(detail.nodes ?? {}).length : aggregate.nodes.length}
                    </div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">任务状态</div>
                    <div className="kv-value">
                      <StatusBadge status={detail.status} />
                    </div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">开始时间</div>
                    <div className="kv-value">
                      <TimeAgo ts={aggregate.taskStartedAt ?? detail.artifacts[0]?.created_at} />
                    </div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">结束时间</div>
                    <div className="kv-value">
                      {aggregate.taskEndedAt ? <TimeAgo ts={aggregate.taskEndedAt} /> : <span className="muted">未结束</span>}
                    </div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">总耗时</div>
                    <div className="kv-value">
                      {formatDuration(
                        aggregate.taskStartedAt
                          ? (aggregate.taskEndedAt ?? Date.now()) - aggregate.taskStartedAt
                          : null,
                      )}
                    </div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">当前节点</div>
                    <div className="kv-value mono">
                      {detail.currentNodeIds?.length ? detail.currentNodeIds.join(', ') : '—'}
                    </div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">刷新方式</div>
                    <div className="kv-value">
                      {terminal ? (
                        <span className="muted">已进入终态，已停止轮询</span>
                      ) : (
                        <span className="tone-run">运行中 · 每 {POLL_DETAIL_MS / 1000} 秒轮询</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="notice">
                  <code>simple_dev</code> 为串行基线（同一时刻只有一个节点在跑）；内核已消费
                  <code>env.globalConcurrency</code>，并行批次超上限即排队。本页面暂不展示并行度指标。
                </div>

                {failedNodes.length > 0 && (
                  <div className="banner banner-fail">
                    <div className="banner-body">
                      <b>{failedNodes.length} 个节点失败</b>
                      {failedNodes.slice(0, 3).map((node) => (
                        <div key={node.nodeId} className="banner-detail">
                          <span className="mono">{node.nodeId}</span>
                          <span className="node-error-inline" title={node.lastError ?? ''}>
                            {node.lastError ?? '（无 lastError）'}
                          </span>
                          <button type="button" className="btn btn-xs" onClick={() => openLog(node.nodeId)}>
                            查看日志
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <Collapsible title={<span>原始需求（requirementRaw）</span>}>
                  <PreBlock text={detail.requirementRaw || '（空）'} maxHeight={280} />
                </Collapsible>

                <nav className="tabs">
                  <button
                    type="button"
                    className={`tab-btn${tab === 'nodes' ? ' active' : ''}`}
                    onClick={() => setTab('nodes')}
                  >
                    节点与成本 {aggregate.nodes.length}
                  </button>
                  <button
                    type="button"
                    className={`tab-btn${tab === 'logs' ? ' active' : ''}`}
                    onClick={() => setTab('logs')}
                  >
                    日志
                    {failedNodes.length > 0 && <span className="tab-dot fail" />}
                  </button>
                  <button
                    type="button"
                    className={`tab-btn${tab === 'artifacts' ? ' active' : ''}`}
                    onClick={() => setTab('artifacts')}
                  >
                    产物 {detail.artifacts?.length ?? 0}
                    {detail.artifacts?.some((a) => a.status !== 'ok') && <span className="tab-dot warn" />}
                  </button>
                  <button
                    type="button"
                    className={`tab-btn${tab === 'events' ? ' active' : ''}`}
                    onClick={() => setTab('events')}
                  >
                    事件 {events.length}
                  </button>
                </nav>

                {tab === 'nodes' && (
                  <NodeCostView
                    state={detail}
                    aggregate={aggregate}
                    liveness={liveness}
                    compat={compat}
                    onOpenLog={openLog}
                    onOpenArtifacts={() => setTab('artifacts')}
                  />
                )}

                {tab === 'logs' && (
                  <LogViewer
                    taskId={detail.taskId}
                    nodes={aggregate.nodes}
                    compat={compat}
                    focusNodeId={logFocusNodeId}
                  />
                )}

                {tab === 'artifacts' && <ArtifactView state={detail} aggregate={aggregate} />}

                {tab === 'events' && (
                  <>
                    {eventsError && (
                      <div className="banner banner-warn">
                        <b>事件流获取失败：</b>
                        <span>{eventsError}</span>
                      </div>
                    )}
                    <EventView events={events} />
                  </>
                )}
              </>
            )}

            {!detail && !detailError && <EmptyState>正在加载任务详情…</EmptyState>}
          </>
        )}
      </main>
    </div>
  );
}