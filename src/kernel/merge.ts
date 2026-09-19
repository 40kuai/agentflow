import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { matchesOwns, normalizeRepoPath } from './path-guard.js';

/** 参与合并的一个节点：它的工作区路径、实际改动、允许写入范围与成败 */
export type MergeNodeInput = {
  nodeId: string;
  /** 该节点工作区绝对路径（隔离时为 git worktree / 独立目录） */
  workspacePath: string;
  /** 该节点工作区内的实际变更路径（仓库相对 POSIX，含未跟踪新文件） */
  changedPaths: string[];
  /** 该节点角色的允许写入范围（`owns`） */
  owns: string[];
  /** 节点是否成功；失败节点的改动**一律不合并** */
  succeeded: boolean;
};

export type MergeNodeOutcome = {
  nodeId: string;
  /** 已合并回主工作区的路径（升序、去重） */
  mergedPaths: string[];
  /** 被排除、未合并的路径（升序、去重） */
  skippedPaths: string[];
  /** 未合并原因（中文）；无任何跳过时为 null */
  reason: string | null;
};

/**
 * 把一批隔离节点的改动**按路径归属**合并回主工作区（Task 11.2）。
 *
 * 确定性论证：Task 8 的批次占用检查已保证同批次节点的 `owns` **两两不相交**，
 * 因此同一条路径最多只会被一个节点写出。合并只做「逐路径覆盖（或删除）」，不做三方合并、
 * 不比较时间戳，故最终内容只取决于「这段路径归谁所有」，与节点完成顺序、合并处理顺序**无关**。
 *
 * 排除规则（明确、不静默）：
 *  - **失败节点**整体不合并：失败意味着产物不可信（与 Task 7「越界产物作废」同源），
 *    把它的改动写回主工作区会污染下游工作区；
 *  - **越界路径**即便出现在成功节点里也不合并：越界产物已作废，这里再做一道防御性过滤。
 *
 * 合并写入失败即抛中文错误（不静默），避免"以为合并了其实没有"。
 */
export function mergeBatchChanges(input: {
  repoPath: string;
  nodes: MergeNodeInput[];
}): MergeNodeOutcome[] {
  const outcomes: MergeNodeOutcome[] = [];

  for (const node of input.nodes) {
    const changed = dedupeSorted(node.changedPaths);

    if (!node.succeeded) {
      outcomes.push({
        nodeId: node.nodeId,
        mergedPaths: [],
        skippedPaths: changed,
        reason: '节点失败，其改动不予合并（失败产物不可信）',
      });
      continue;
    }

    const owned = changed.filter((path) => matchesOwns(path, node.owns));
    const outOfBounds = changed.filter((path) => !matchesOwns(path, node.owns));

    for (const path of owned) {
      applyPath({ workspacePath: node.workspacePath, repoPath: input.repoPath, path, nodeId: node.nodeId });
    }

    outcomes.push({
      nodeId: node.nodeId,
      mergedPaths: owned,
      skippedPaths: outOfBounds,
      reason: outOfBounds.length > 0 ? `越界路径不予合并：${outOfBounds.join(', ')}` : null,
    });
  }

  // 结果按 nodeId 排序，使合并报告与处理顺序无关（配合「按路径归属」实现整体确定性）
  return outcomes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

/** 去空、规范化、去重、升序 */
function dedupeSorted(paths: string[]): string[] {
  const normalized = paths.map(normalizeRepoPath).filter((path) => path !== '');
  return [...new Set(normalized)].sort();
}

/** 单条路径落地：源存在即覆盖，源不存在（节点删除了它）即同步删除 */
function applyPath(input: {
  workspacePath: string;
  repoPath: string;
  path: string;
  nodeId: string;
}): void {
  const source = resolve(input.workspacePath, input.path);
  const target = resolve(input.repoPath, input.path);
  try {
    if (existsSync(source)) {
      if (!statSync(source).isFile()) return;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    } else if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
  } catch (error) {
    throw new Error(
      `合并节点 ${input.nodeId} 的路径 ${input.path} 失败：${(error as Error).message}`,
    );
  }
}