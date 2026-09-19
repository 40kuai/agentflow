/**
 * 流程视图（DAG）的纯计算部分：分层布局 + join 等待关系。
 *
 * 为什么自己算而不用图形库：本页面只画一张最多十几节点的有向图，引入 dagre/elk 之类
 * 依赖（含大量传递依赖）不值当；且**前端不新增依赖**是硬约束。
 *
 * 分层口径：按拓扑深度取**最长路径**分层（layer(v) = max(layer(前置)+1)），
 * 这样 join 节点必然落在所有上游之后，视觉上"等谁"一目了然。
 */

export type FlowGraphNode = { id: string };
export type FlowGraphEdge = { from: string; to: string };

/** 节点方框与间距（px）。数值只影响展示，不参与语义 */
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 112;
export const COLUMN_GAP = 72;
export const ROW_GAP = 16;

export type LaidOutNode = {
  id: string;
  /** 列号（拓扑深度，0 起） */
  layer: number;
  /** 同列内的行号（0 起，按输入顺序稳定排列） */
  row: number;
  x: number;
  y: number;
};

export type FlowLayout = {
  nodes: LaidOutNode[];
  /** 每列的节点数，用于渲染列标题/占位 */
  layerSizes: number[];
  width: number;
  height: number;
};

/**
 * 计算分层布局。
 *
 * 容错口径（都必须成立，否则图会画歪或死循环）：
 *  - 边引用了不存在的节点 → 忽略该边（后端有拓扑兜底节点，但前端不假设一定完整）；
 *  - 存在环（工作流回边）→ 用**迭代上限**收敛（最多 n 轮松弛），不抛错、不冻结；
 *  - 孤立节点（无入无边）→ 落在第 0 列，仍会被渲染出来，不静默丢节点。
 */
export function layoutFlow(nodes: FlowGraphNode[], edges: FlowGraphEdge[]): FlowLayout {
  const ids = nodes.map((node) => node.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const layerOf = new Map<string, number>(ids.map((id) => [id, 0]));

  const valid = edges.filter((edge) => index.has(edge.from) && index.has(edge.to));
  // 松弛 n 轮：无环时最长路径在第 n 轮前必然收敛；有环时靠轮数上限兜底（不冻结界面）
  for (let round = 0; round < ids.length; round += 1) {
    let changed = false;
    for (const edge of valid) {
      const next = (layerOf.get(edge.from) ?? 0) + 1;
      if (next > (layerOf.get(edge.to) ?? 0)) {
        layerOf.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const layerSizes: number[] = [];
  const rowOf = new Map<string, number>();
  for (const id of ids) {
    const layer = layerOf.get(id) ?? 0;
    const row = layerSizes[layer] ?? 0;
    rowOf.set(id, row);
    layerSizes[layer] = row + 1;
  }

  const laidOut: LaidOutNode[] = ids.map((id) => {
    const layer = layerOf.get(id) ?? 0;
    const row = rowOf.get(id) ?? 0;
    return {
      id,
      layer,
      row,
      x: layer * (NODE_WIDTH + COLUMN_GAP),
      y: row * (NODE_HEIGHT + ROW_GAP),
    };
  });

  const columns = Math.max(1, layerSizes.length);
  const rows = Math.max(1, ...layerSizes, 0);
  return {
    nodes: laidOut,
    layerSizes,
    width: columns * NODE_WIDTH + (columns - 1) * COLUMN_GAP,
    height: rows * NODE_HEIGHT + (rows - 1) * ROW_GAP,
  };
}

/** 节点方框中心（用于画边） */
export function nodeAnchor(node: LaidOutNode, side: 'left' | 'right'): { x: number; y: number } {
  return {
    x: side === 'left' ? node.x : node.x + NODE_WIDTH,
    y: node.y + NODE_HEIGHT / 2,
  };
}

/**
 * SVG 边的路径：同列/回边用弧线，其余用三次贝塞尔（横向进出，避免穿过方框）。
 */
export function edgePath(from: LaidOutNode, to: LaidOutNode): string {
  const a = nodeAnchor(from, 'right');
  const b = nodeAnchor(to, 'left');
  if (to.layer <= from.layer) {
    // 回边（循环）或同列边：向下绕一圈，明确区别于前向边
    const drop = NODE_HEIGHT / 2 + 18;
    return `M ${a.x} ${a.y} C ${a.x + 40} ${a.y + drop}, ${b.x - 40} ${b.y + drop}, ${b.x} ${b.y}`;
  }
  const dx = Math.max(28, (b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** 节点是否处于「活动」：并发时可能多个同时为真 —— 这是并行度的直接可视表达 */
export function isActive(status: string): boolean {
  return status === 'running' || status === 'queued' || status === 'waiting_gate';
}

export type JoinWait = {
  /** 该节点是否为 join（入边 ≥ 2） */
  isJoin: boolean;
  /** 尚未成功完成的直接上游（按拓扑输入顺序） */
  waitingOn: string[];
};

/**
 * join 节点"在等谁"：入边 ≥2 且仍有上游未就绪时给出未就绪的上游 id。
 * 判定只用**直接上游**的节点状态（与内核「上游未全部进入终态前不启动 join」的语义一致），
 * 不做递归——递归会把"等谁"变成一长串，反而看不清。
 *
 * 「未就绪」= 未 succeeded 且**未 cancelled**：任务一旦被取消，就不存在"在等"这回事了
 * （join 永远不会再启动），继续显示"在等 XXX"是误导；此时节点回到"尚未进入"的陈述。
 */
export function joinWait(
  nodeId: string,
  nodes: { id: string; status: string }[],
  edges: FlowGraphEdge[],
): JoinWait {
  const upstream = edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from);
  const statusById = new Map(nodes.map((node) => [node.id, node.status]));
  const waitingOn = upstream.filter((id) => {
    const status = statusById.get(id);
    return status !== 'succeeded' && status !== 'cancelled';
  });
  return { isJoin: upstream.length >= 2, waitingOn };
}