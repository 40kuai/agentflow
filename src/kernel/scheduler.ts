import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId } from '../shared/ids.js';

export type Workspace = {
  runId: string;
  path: string;
  /** 是否为该节点新建的 git worktree */
  createdWorktree: boolean;
};

/**
 * 为一次节点执行准备工作区。
 * isolate=true 时优先创建 git worktree；仓库不可用（非 git 仓库、无提交）时退化为运行目录下的独立子目录。
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
    return { runId, path: input.repoPath, createdWorktree: false };
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
    return { runId, path: worktreePath, createdWorktree: false };
  }

  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], {
      cwd: input.repoPath,
      stdio: 'pipe',
    });
    return { runId, path: worktreePath, createdWorktree: true };
  } catch {
    // worktree 创建失败（例如仓库还没有任何提交）时退化为独立目录
    mkdirSync(worktreePath, { recursive: true });
    return { runId, path: worktreePath, createdWorktree: false };
  }
}

/** 回收 worktree；失败不抛错，只返回 false */
export function releaseWorkspace(ws: Workspace, repoPath: string): boolean {
  if (!ws.createdWorktree) return true;
  if (!existsSync(ws.path)) return true;
  try {
    execFileSync('git', ['worktree', 'remove', '--force', ws.path], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}