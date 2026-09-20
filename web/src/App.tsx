/**
 * AgentFlow 内部管理台（三层信息架构）。
 *
 * 顶层只回答两个问题：「现在怎么样」「我该做什么」，原始数据全部降到二级 tab：
 *   左：任务列表（状态点 + 一句话摘要 + 当前阶段）
 *   中上：状态条（当前阶段 / 活跃节点 / 花费 / 耗时 / 分类化失败原因 / 取消）
 *   中中：流程视图（DAG：并发高亮、join 在等谁、失败原因直显）
 *   下：二级 tab（节点明细 / 角色 / 日志 / 产物 / 事件）
 *
 * 数据来源分工：
 *   - 列表与列表内的「当前阶段」：GET /api/tasks + 每个任务的 GET /api/tasks/:id/flow
 *   - 选中任务的阶段与 DAG：GET /api/tasks/:id/flow（2 秒轮询，终态后停）
 *   - 花费/耗时/节点级事实：事件流归集（aggregate.ts，复用既有实现）
 *   - 运行中节点的活性：日志文件 mtime/size（liveness.ts，复用既有实现）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelTask,
  createTask,
  getHealth,
  getTask,
  getTaskEvents,
  getTaskFlow,
  listTasks,
  openEventSocket,
  type CreateTaskInput,
  type FlowView,
  type KernelEvent,
  type TaskState,
  type TaskSummary,
} from './api';
import { aggregateTask, type NodeAggregate } from './aggregate';
import { ArtifactView } from './components/ArtifactView';
import { EventView } from './components/EventView';
import { FlowView as FlowGraph } from './components/FlowView';
import { LogViewer } from './components/LogViewer';
import { NodeCostView } from './components/NodeCostView';
import { RolePanel } from './components/RolePanel';
import { StatusBar } from './components/StatusBar';
import { TaskList } from './components/TaskList';
import { Collapsible, EmptyState, HealthBadge, PreBlock, StatusBadge } from './components/common';
import { formatAbsoluteTime, shortId } from './format';
import {
  backendCompatibility,
  computeTaskHealth,
  fetchNodeLiveness,
  type BackendHealth,
  type NodeLiveness,
} from './liveness';

/** 二级 tab：默认「节点明细」，其余为日志/产物/事件等原始数据 */
type TabId = 'nodes' | 'roles' | 'logs' | 'artifacts' | 'events';

const POLL_DETAIL_MS = 2000;
const POLL_LIST_MS = 5000;
/** 列表内批量取流转视图的上限：防止任务很多时把后端打爆（超出部分在列表里显示「—」） */
const LIST_FLOW_LIMIT = 20;

function isTerminal(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [tasksError, setTasksError] = useState<string | null>(null);
  /** 列表内每个任务的流转视图（供任务列表显示「当前阶段」） */
  const [listFlows, setListFlows] = useState<Record<string, FlowView>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskState | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** 选中任务的流转视图：状态条与 DAG 的唯一数据源 */
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [events, setEvents] = useState<KernelEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendHealth>({ status: 'unknown' });
  const [liveness, setLiveness] = useState<Record<string, NodeLiveness>>({});
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [taskErrorMessage, setTaskErrorMessage] = useState<string | null>(null);
  // 二级 tab：「流程 / 状态」是主体，明细默认不抢占注意力，但仍可一键到达
  const [tab, setTab] = useState<TabId>('nodes');
  const [logFocusNodeId, setLogFocusNodeId] = useState<string | null>(null);
  const [listTick, setListTick] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

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

  /**
   * 刷新任务列表 + 列表内每个任务的流转视图（用于「当前阶段」）。
   * 流转视图**逐个失败不影响整体**：单个任务取不到就留空，界面显示「—」。
   */
  const refreshList = useCallback(async () => {
    try {
      const list = await listTasks();
      setTasks(list);
      setTasksError(null);

      const targets = list.slice(0, LIST_FLOW_LIMIT);
      const results = await Promise.all(
        targets.map(async (task) => {
          try {
            return [task.taskId, await getTaskFlow(task.taskId)] as const;
          } catch {
            return [task.taskId, null] as const;
          }
        }),
      );
      const next: Record<string, FlowView> = {};
      for (const [taskId, item] of results) {
        if (item) next[taskId] = item;
      }
      setListFlows(next);
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

  const refreshFlow = useCallback(async (taskId: string) => {
    try {
      setFlow(await getTaskFlow(taskId));
      setFlowError(null);
    } catch (err) {
      // 流转视图不可用（404/503/网络）如实上报，界面据此退化为事件流口径
      setFlowError((err as Error).message);
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

  // 每次列表轮询都重新探测后端能力
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
      setFlow(null);
      setEvents([]);
      setDetailError(null);
      setFlowError(null);
      setEventsError(null);
      return;
    }
    void refreshDetail(selectedId);
    void refreshFlow(selectedId);
    void refreshEvents(selectedId);
  }, [selectedId, refreshDetail, refreshFlow, refreshEvents]);

  // 运行中每 2 秒轮询；进入终态后停止
  const terminal = isTerminal(flow?.status ?? detail?.status);
  useEffect(() => {
    if (!selectedId || terminal) return;
    const timer = setInterval(() => {
      void refreshDetail(selectedId);
      void refreshFlow(selectedId);
      void refreshEvents(selectedId);
    }, POLL_DETAIL_MS);
    return () => clearInterval(timer);
  }, [selectedId, terminal, refreshDetail, refreshFlow, refreshEvents]);

  const aggregate = useMemo(() => aggregateTask(detail, events, Date.now()), [detail, events]);

  // 每次渲染都把最新节点列表交给 ref：轮询回调据此决定对哪些节点抓活性
  nodesRef.current = aggregate.nodes;

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

  const compat = useMemo(() => backendCompatibility(backend), [backend]);
  // 后端生效的停滞自动停止阈值（ms）：null = 后端未声明该能力（版本落后）；0 = 已关闭。
  // 前端据此**如实**说明"会不会自动停"，绝不把未启用说成会自动停。
  const stallTimeoutMs =
    backend.status === 'ok' ? (backend.info.nodeStallTimeoutMs ?? null) : null;
  const taskHealth = useMemo(
    () =>
      detail
        ? computeTaskHealth({
            status: flow?.status ?? detail.status,
            nodes: aggregate.nodes,
            liveness,
            compat,
            now: Date.now(),
          })
        : null,
    [detail, flow, aggregate.nodes, liveness, compat],
  );

  const handleSelect = useCallback((taskId: string) => {
    setSelectedId(taskId);
    setDetail(null);
    setFlow(null);
    setEvents([]);
    setDetailError(null);
    setFlowError(null);
    setEventsError(null);
    setTaskErrorMessage(null);
    setLogFocusNodeId(null);
    setLiveness({});
    setCancelNotice(null);
    setCancelError(null);
    // 切任务回到「节点明细」：不同任务的工作流可能不同，留在日志 tab 会看到空态造成误解
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

  const handleCancel = useCallback(async () => {
    if (!selectedId || cancelling) return;
    setCancelling(true);
    setCancelNotice(null);
    setCancelError(null);
    try {
      const result = await cancelTask(selectedId);
      // 用后端返回的权威状态覆盖本地，避免"界面说取消了、事件库里其实没取消"
      setDetail(result.state);
      setCancelNotice(
        result.cancelled
          ? '已取消：任务进入 cancelled 终态，内核已通知终止在途 CLI 进程（已花费用不退回）。'
          : (result.reason ?? '任务已在终态，未做任何改动。'),
      );
      await Promise.all([refreshFlow(selectedId), refreshEvents(selectedId), refreshList()]);
    } catch (err) {
      setCancelError((err as Error).message);
    } finally {
      setCancelling(false);
    }
  }, [selectedId, cancelling, refreshFlow, refreshEvents, refreshList]);

  const openLog = useCallback((nodeId: string) => {
    setLogFocusNodeId(nodeId);
    setTab('logs');
  }, []);

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

  const failedNodeIds = (flow?.nodes ?? []).filter((node) => node.status === 'failed').map((n) => n.id);

  return (
    <div className="layout">
      <TaskList
        tasks={tasks}
        flows={listFlows}
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
                <StatusBadge status={flow?.status ?? detail.status} />
                <HealthBadge health={taskHealth} />
                <span className="muted small">baseBranch {detail.baseBranch || 'main'}</span>
              </>
            ) : (
              <h2>{selectedId ? '正在加载任务…' : '未选择任务'}</h2>
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
            <span
              className={`health health-${wsStatus === 'open' ? 'ok' : wsStatus === 'closed' ? 'down' : 'unknown'}`}
            >
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

        {!selectedId && (
          <EmptyState>
            左侧选择一个任务，或填写标题 + 需求原文创建新任务。
            <br />
            选中后从上到下依次是：<b>状态条</b>（现在怎么样 / 卡在哪 / 分类化失败原因）、
            <b>流程视图</b>（谁在跑、谁在等谁、谁失败了）；日志 / 产物 / 事件等原始数据在下方二级
            tab 里。
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

            <StatusBar
              flow={flow}
              flowError={flowError}
              aggregate={aggregate}
              compat={compat}
              taskHealth={taskHealth}
              liveness={liveness}
              stallTimeoutMs={stallTimeoutMs}
              cancelling={cancelling}
              cancelNotice={cancelNotice}
              cancelError={cancelError}
              onCancel={() => void handleCancel()}
              onOpenLog={openLog}
            />

            <FlowGraph
              flow={flow}
              error={flowError}
              liveness={liveness}
              stallTimeoutMs={stallTimeoutMs}
              cancelling={cancelling}
              onOpenLog={openLog}
              onCancelTask={() => void handleCancel()}
            />

            {!detail && !detailError && !flow && <EmptyState>正在加载任务详情…</EmptyState>}

            {detail && (
              <>
                <nav className="tabs tabs-secondary">
                  <button
                    type="button"
                    className={`tab-btn${tab === 'nodes' ? ' active' : ''}`}
                    onClick={() => setTab('nodes')}
                  >
                    节点明细 {aggregate.nodes.length}
                  </button>
                  <button
                    type="button"
                    className={`tab-btn${tab === 'roles' ? ' active' : ''}`}
                    onClick={() => setTab('roles')}
                  >
                    角色与花费
                  </button>
                  <button
                    type="button"
                    className={`tab-btn${tab === 'logs' ? ' active' : ''}`}
                    onClick={() => setTab('logs')}
                  >
                    日志
                    {failedNodeIds.length > 0 && <span className="tab-dot fail" />}
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
                  <>
                    <Collapsible title={<span>原始需求（requirementRaw）</span>}>
                      <PreBlock text={detail.requirementRaw || '（空）'} maxHeight={240} />
                    </Collapsible>
                    <NodeCostView
                      state={detail}
                      aggregate={aggregate}
                      liveness={liveness}
                      compat={compat}
                      onOpenLog={openLog}
                      onOpenArtifacts={() => setTab('artifacts')}
                    />
                  </>
                )}

                {tab === 'roles' && (
                  <RolePanel taskId={detail.taskId} flow={flow} onOpenLog={openLog} />
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
          </>
        )}
      </main>
    </div>
  );
}