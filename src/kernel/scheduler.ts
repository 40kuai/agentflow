import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { newId } from '../shared/ids.js';
import { collectChangedPaths } from './path-guard.js';

export type Workspace = {
  runId: string;
  path: string;
  /** 是否为该节点新建的 git worktree */
  createdWorktree: boolean;
  /**
   * 该工作区是否与主工作区隔离。true 表示节点改动落在独立目录里，
   * 批次结束后必须由内核**合并回主工作区**（否则改动会随 worktree 回收而丢失）。
   */
  isolated: boolean;
  /** 为本工作区创建的临时分支名；非 git worktree（退化为独立目录）时为 null */
  branch: string | null;
};

/** child 是否位于 parent 目录之内（或等于 parent）。用于排除 worktree 自身所在目录 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || !rel.startsWith('..');
}

/**
 * 把主工作区**当前未提交**的改动同步进新建的 worktree。
 *
 * 为什么必须做：`git worktree add ... HEAD` 只基于**已提交状态**创建工作树，
 * 而上一批次合并回主工作区的产物仍是**未提交的工作区改动**（本平台不替用户提交）。
 * 不同步的话，本批次节点看不到最新上游产物，与 spec「worktree 必须基于当前主工作区的状态创建」相违。
 *
 * 失败即抛错（不静默）：某个路径同步失败会让节点看到过期状态，必须让调用方明确失败。
 */
function overlayWorkingTreeChanges(input: {
  repoPath: string;
  worktreePath: string;
  workspaceRoot: string;
}): void {
  const rootAbs = resolve(input.workspaceRoot);
  for (const rel of collectChangedPaths(input.repoPath)) {
    const source = resolve(input.repoPath, rel);
    const target = resolve(input.worktreePath, rel);
    // worktree 本身位于 workspaceRoot 之下；若 workspaceRoot 在仓库内，git status 会把其中的
    // 文件列为未跟踪改动，必须跳过这些项以免把工作区复制进它自己（target 恒在 worktree 内，不能据此判断）。
    if (isInside(rootAbs, source)) continue;
    try {
      if (existsSync(source) && statSync(source).isFile()) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      } else if (!existsSync(source) && existsSync(target)) {
        // 主工作区已删除该路径 → worktree 中同步删除，保持"看到的是当前状态"
        rmSync(target, { recursive: true, force: true });
      }
    } catch (error) {
      throw new Error(
        `同步主工作区改动到 worktree 失败：${rel} —— ${(error as Error).message}`,
      );
    }
  }
}

/**
 * 为一次节点执行准备工作区。
 * isolate=true 时优先创建 git worktree，并把主工作区当前未提交的改动叠加进去；
 * 仓库不可用（非 git 仓库、无提交）时退化为运行目录下的独立子目录（仍保持隔离语义，结束时会回收）。
 */
export function prepareWorkspace(input: {
  workspaceRoot: string;
  repoPath: string;
  isolate: boolean;
  taskId: string;
  nodeId: string;
}): Workspace {
  const runId = newId('run');
  mkdirSync(input.workspaceRoot, { recursive: true });

  if (!input.isolate) {
    return { runId, path: input.repoPath, createdWorktree: false, isolated: false, branch: null };
  }

  const worktreePath = resolve(input.workspaceRoot, `${input.taskId}-${input.nodeId}-${runId}`);
  const branch = `agentflow/${input.taskId}/${input.nodeId}/${runId}`;

  let isGitRepo = false;
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: input.repoPath,
      stdio: 'pipe',
    });
    isGitRepo = true;
  } catch {
    isGitRepo = false;
  }

  if (!isGitRepo) {
    mkdirSync(worktreePath, { recursive: true });
    return { runId, path: worktreePath, createdWorktree: false, isolated: true, branch: null };
  }

  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], {
      cwd: input.repoPath,
      stdio: 'pipe',
    });
  } catch {
    // worktree 创建失败（例如仓库还没有任何提交）时退化为独立目录。
    // 这是有意的降级路径：调用方可通过事件的 worktree_created=false 观察到它，不是静默失败。
    mkdirSync(worktreePath, { recursive: true });
    return { runId, path: worktreePath, createdWorktree: false, isolated: true, branch: null };
  }

  overlayWorkingTreeChanges({
    repoPath: input.repoPath,
    worktreePath,
    workspaceRoot: input.workspaceRoot,
  });
  return { runId, path: worktreePath, createdWorktree: true, isolated: true, branch };
}

/**
 * 回收工作区：移除 worktree（必要时 `--force`，仅针对本平台自己创建的临时 worktree）、
 * 删除配套的临时分支、删除退化的隔离目录。失败不抛错，只返回 false。
 */
export function releaseWorkspace(ws: Workspace, repoPath: string): boolean {
  if (!ws.isolated) return true;
  if (!existsSync(ws.path)) return true;

  if (!ws.createdWorktree) {
    // 退化为独立目录的隔离工作区：目录由本平台创建，直接删除，避免残留
    try {
      rmSync(ws.path, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  try {
    execFileSync('git', ['worktree', 'remove', '--force', ws.path], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch {
    return false;
  }

  if (ws.branch !== null) {
    // 该分支由本平台为该 worktree 临时创建、其上没有任何本平台之外的提交，删除是安全的；
    // 删除失败不影响主流程（worktree 已移除，仅留下一个孤立引用）。
    try {
      execFileSync('git', ['branch', '-D', ws.branch], { cwd: repoPath, stdio: 'pipe' });
    } catch {
      // 忽略：孤立分支不改变工作区状态
    }
  }
  return true;
}