import { execFileSync } from 'node:child_process';

/**
 * 路径安全闸（Task 7 + Task 8）。
 *
 * 两个职责：
 *  1) **越界检出**：把节点工作区的实际变更路径与其 `owns`（允许写入的路径）比对，检出越界写。
 *  2) **占用检查**：判断同一并行批次内两个节点的 `owns` 是否**可能**落在同一条路径上，把冲突挡在启动之前。
 *
 * 除 `collectChangedPaths`（需要读 git）外均为纯函数，可脱离内核独立单测。
 *
 * glob 语义（`owns` 里每一项的取值）：
 *  - 仓库相对路径，`/` 为分隔符；
 *  - `**` 作为一个**整段**，匹配**零或多段**（`src/**` 既匹配 `src/a.ts` 也匹配 `src/a/b.ts`）；
 *  - `*` 段内任意（可空），`?` 段内单个字符；其余字符按字面量。
 *  - 不支持 `[...]` 字符类、`{a,b}` 花括号、`!` 取反——配置里未使用，如需支持须显式扩展并补测。
 */

/** 把仓库相对路径规整成 POSIX 形式：反斜杠转正斜杠、去前导 `/` 与 `./`、合并重复分隔符、去尾随 `/` */
export function normalizeRepoPath(path: string): string {
  let out = path.trim().replace(/\\/g, '/');
  out = out.replace(/^\.?\//, '');
  out = out.replace(/\/+/g, '/');
  out = out.replace(/\/$/, '');
  return out;
}

/** 把 glob 拆成段；空串得到空数组 */
function splitSegments(pattern: string): string[] {
  const normalized = normalizeRepoPath(pattern);
  return normalized === '' ? [] : normalized.split('/');
}

/** 单段 glob → 正则片段（段内 `*` 任意可空、`?` 单字符，其余转义为字面量） */
function segmentToRegExpSource(segment: string): string {
  let out = '';
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/** 段列表 → 正则源。`**` 匹配零或多段（与重叠判定使用同一语义，避免两处口径不一致） */
function globToRegExpSource(segments: string[]): string {
  let out = '';
  let needsSeparator = false;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment === '**') {
      if (i === 0) {
        // 前导 `**`：可吞任意层目录（含零层）
        out += segments.length === 1 ? '.*' : '(?:.*/)?';
        needsSeparator = false;
      } else if (i === segments.length - 1) {
        // 尾随 `**`：本层及其下任意深度（含零段）
        out += '(?:/.*)?';
        needsSeparator = false;
      } else {
        // 中间 `**`：零或多层目录
        out += '/(?:.*/)?';
        needsSeparator = false;
      }
    } else {
      if (needsSeparator) out += '/';
      out += segmentToRegExpSource(segment);
      needsSeparator = true;
    }
  }
  return out;
}

const regexpCache = new Map<string, RegExp>();

/** 单个 `owns` 模式编译为整串正则（带缓存） */
export function ownsPatternToRegExp(pattern: string): RegExp {
  const cached = regexpCache.get(pattern);
  if (cached) return cached;
  const compiled = new RegExp(`^${globToRegExpSource(splitSegments(pattern))}$`);
  regexpCache.set(pattern, compiled);
  return compiled;
}

/** 某个仓库相对路径是否落在允许写入的路径集合内 */
export function matchesOwns(path: string, owns: string[]): boolean {
  const normalized = normalizeRepoPath(path);
  if (normalized === '') return false;
  return owns.some((pattern) => ownsPatternToRegExp(pattern).test(normalized));
}

/**
 * 从实际变更路径里挑出**越界**的那些。
 * `owns` 为空表示该角色只读（不写任何路径）——此时任何变更都算越界。
 */
export function findOwnViolations(changedPaths: string[], owns: string[]): string[] {
  const violations = changedPaths
    .map(normalizeRepoPath)
    .filter((path) => path !== '')
    .filter((path) => !matchesOwns(path, owns));
  return [...new Set(violations)].sort();
}

/**
 * 采集工作区的实际变更路径（含**未跟踪的新文件**）。
 *
 * 用 `git status --porcelain --untracked-files=all`：`git diff --name-only` **不含**未跟踪文件，
 * 而端到端实测的那次越界（`README.md` / `scripts/hello.sh`）恰恰都是未跟踪新文件，故必须用 status。
 * 非 git 工作区或 git 不可用时返回空数组——无法判定时**宁可漏报也不误报**。
 */
export function collectChangedPaths(workdir: string): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length < 4) continue;
    // porcelain v1：前两列为状态码，第三列为空格；重命名/复制形如 `R  old -> new`
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    path = path.replace(/^"(.*)"$/, '$1');
    const normalized = normalizeRepoPath(path);
    if (normalized !== '') paths.push(normalized);
  }
  return [...new Set(paths)].sort();
}

/**
 * 两段「单段 glob」是否可能匹配**同一个字符串**（段内通配：`*` 任意可空、`?` 单字符、其余字面量）。
 *
 * 判据是标准的通配匹配 DP：`g(i,j)` = `a[i..]` 与 `b[j..]` 是否存在公共匹配串。
 * `*` 可吃掉零个或一个字符（吃掉一个字符时对方那一位必须也能产出该字符——字面量/`?`/`*` 都能）。
 * 复杂度 O(|a|·|b|)，带记忆化。
 */
export function segmentsIntersect(a: string, b: string): boolean {
  const memo = new Map<string, boolean>();
  const match = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i < a.length && a[i] === '*') {
      result = match(i + 1, j) || (j < b.length && match(i, j + 1));
    } else if (j < b.length && b[j] === '*') {
      result = match(i, j + 1) || (i < a.length && match(i + 1, j));
    } else if (i === a.length && j === b.length) {
      result = true;
    } else if (i === a.length || j === b.length) {
      result = false;
    } else {
      result = (a[i] === '?' || b[j] === '?' || a[i] === b[j]) && match(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

/**
 * 两段 `owns` 模式是否**可能相交**（存在一条同时被两者匹配的路径）。
 *
 * 按**段**做 DP：`f(i,j)` = `a[i..]` 与 `b[j..]` 是否存在公共路径。
 *  - `a[i] === '**'`：可匹配零段（`f(i+1,j)`）或多段（吃掉 `b[j]` 后 `f(i,j+1)`）；
 *  - `b[j] === '**'` 对称；
 *  - 其余情况要求两段本身可能相同（`segmentsIntersect`）且各自后续也相交。
 *
 * 边界与取舍：`**` 统一按「零或多段」处理（与 `ownsPatternToRegExp` 同口径）。
 * 这相对真实文件路径是**保守的超集近似**：例如 `src/*` 与 `src/a/**` 会被判为重叠
 * （真实路径里 `src/*` 只匹配直接子项，未必真的撞车）。**宁可多判重叠、退化为串行，
 * 也不放过可能写入同一路径的并行**——安全侧误报的代价只是少并行，危险侧漏报的代价是数据混乱。
 */
export function ownsPatternsIntersect(patternA: string, patternB: string): boolean {
  const a = splitSegments(patternA);
  const b = splitSegments(patternB);
  const memo = new Map<string, boolean>();
  const overlap = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i < a.length && a[i] === '**') {
      result = overlap(i + 1, j) || (j < b.length && overlap(i, j + 1));
    } else if (j < b.length && b[j] === '**') {
      result = overlap(i, j + 1) || (i < a.length && overlap(i + 1, j));
    } else if (i === a.length && j === b.length) {
      result = true;
    } else if (i === a.length || j === b.length) {
      result = false;
    } else {
      result = segmentsIntersect(a[i]!, b[j]!) && overlap(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return overlap(0, 0);
}

/** 两段 glob 的字面量公共前缀（供人类阅读"哪段路径重叠"）；无公共前缀返回 `(仓库根)` */
export function commonLiteralPrefix(patternA: string, patternB: string): string {
  const a = splitSegments(patternA);
  const b = splitSegments(patternB);
  const shared: string[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left === '**' || right === '**' || left !== right) break;
    shared.push(left);
  }
  return shared.length > 0 ? shared.join('/') : '(仓库根)';
}

/** 一个参与占用检查的节点：节点 id + 其角色的可写路径 */
export type BatchNodeOwns = { nodeId: string; owns: string[] };

/** 一处 `owns` 重叠：涉及哪两个节点、哪两段模式、在哪段路径上重叠 */
export type OwnsOverlap = {
  nodeA: string;
  nodeB: string;
  patternA: string;
  patternB: string;
  /** 两段模式的字面量公共前缀（人类可读的"重叠路径段"） */
  overlapAt: string;
};

/** 批次内冲突处理策略：serialize=改为串行执行；reject=拒绝该批次 */
export type BatchConflictPolicy = 'serialize' | 'reject';

/**
 * 找出批次内所有**可能重叠**的 `owns`（两两比对）。
 * 只读角色（`owns` 为空）不写任何路径，与任何节点都不冲突，直接跳过。
 */
export function detectOwnsOverlaps(nodes: BatchNodeOwns[]): OwnsOverlap[] {
  const overlaps: OwnsOverlap[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (a.owns.length === 0 || b.owns.length === 0) continue;
      for (const patternA of a.owns) {
        for (const patternB of b.owns) {
          if (ownsPatternsIntersect(patternA, patternB)) {
            overlaps.push({
              nodeA: a.nodeId,
              nodeB: b.nodeId,
              patternA,
              patternB,
              overlapAt: commonLiteralPrefix(patternA, patternB),
            });
          }
        }
      }
    }
  }
  return overlaps;
}

export type BatchGuardDecision =
  | { mode: 'parallel' }
  | { mode: BatchConflictPolicy; reason: string; overlaps: OwnsOverlap[] };

/**
 * 批次启动**之前**的占用检查：给出「能否并行 / 改为串行 / 拒绝」的决策。
 *
 *  - 无重叠（或批次不足两个节点）→ `parallel`；
 *  - 有重叠 → 按 `policy` 返回 `serialize` 或 `reject`，并在 `reason` 里写明
 *    **涉及哪两个节点、哪段路径重叠**。
 *
 * 注意：本函数只做「检查 + 决策 + 说明原因」，**不实现并发调度本身**（属 Task 10）。
 * 接入点：内核主循环在拿到决策的激活节点集合后、`await runNode(...)` 之前调用（见 `kernel.ts`）。
 */
export function checkBatchOwns(
  nodes: BatchNodeOwns[],
  policy: BatchConflictPolicy = 'serialize',
): BatchGuardDecision {
  if (nodes.length < 2) return { mode: 'parallel' };
  const overlaps = detectOwnsOverlaps(nodes);
  if (overlaps.length === 0) return { mode: 'parallel' };

  const detail = overlaps
    .map((o) => `节点 ${o.nodeA} 的 owns「${o.patternA}」与节点 ${o.nodeB} 的 owns「${o.patternB}」在路径「${o.overlapAt}」重叠`)
    .join('；');
  const handling = policy === 'reject' ? '拒绝该批次' : '改为串行执行';
  return {
    mode: policy,
    reason: `并行批次存在 ${overlaps.length} 处 owns 路径重叠：${detail}；按配置策略「${handling}」处理`,
    overlaps,
  };
}