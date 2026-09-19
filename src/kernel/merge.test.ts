import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeBatchChanges, type MergeNodeInput } from './merge.js';

/** 造一个临时目录（仓库根 / 某个节点的工作区都用它） */
function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 在某个工作区里写一批文件（仓库相对路径 → 内容） */
function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function node(partial: Partial<MergeNodeInput> & Pick<MergeNodeInput, 'nodeId'>): MergeNodeInput {
  return {
    workspacePath: partial.workspacePath ?? '',
    changedPaths: partial.changedPaths ?? [],
    owns: partial.owns ?? [],
    succeeded: partial.succeeded ?? true,
    ...partial,
  };
}

describe('按 `owns` 归属的确定性合并（Task 11.2）', () => {
  it('各节点拥有互不相交的路径：改动全部落地，报告按 nodeId 升序', () => {
    const repo = makeDir('agentflow-merge-repo-');
    const wsB = makeDir('agentflow-merge-b-');
    const wsA = makeDir('agentflow-merge-a-');
    writeFiles(wsA, { 'src/dev_a/a.ts': '// a\n' });
    writeFiles(wsB, { 'src/dev_b/b.ts': '// b\n' });

    const outcomes = mergeBatchChanges({
      repoPath: repo,
      nodes: [
        node({ nodeId: 'dev_b', workspacePath: wsB, changedPaths: ['src/dev_b/b.ts'], owns: ['src/dev_b/**'] }),
        node({ nodeId: 'dev_a', workspacePath: wsA, changedPaths: ['src/dev_a/a.ts'], owns: ['src/dev_a/**'] }),
      ],
    });

    expect(readFileSync(join(repo, 'src/dev_a/a.ts'), 'utf8')).toBe('// a\n');
    expect(readFileSync(join(repo, 'src/dev_b/b.ts'), 'utf8')).toBe('// b\n');
    expect(outcomes.map((o) => o.nodeId)).toEqual(['dev_a', 'dev_b']);
    expect(outcomes.every((o) => o.reason === null)).toBe(true);
  });

  it('确定性：合并结果与节点处理顺序无关（正序与逆序得到同一棵工作树）', () => {
    const nodes = (repo: string, wsA: string, wsB: string): MergeNodeInput[] => [
      node({ nodeId: 'dev_a', workspacePath: wsA, changedPaths: ['src/dev_a/a.ts'], owns: ['src/dev_a/**'] }),
      node({ nodeId: 'dev_b', workspacePath: wsB, changedPaths: ['src/dev_b/b.ts'], owns: ['src/dev_b/**'] }),
    ];

    const repoForward = makeDir('agentflow-merge-f-');
    const repoBackward = makeDir('agentflow-merge-r-');
    const wsA1 = makeDir('agentflow-merge-wa1-');
    const wsB1 = makeDir('agentflow-merge-wb1-');
    const wsA2 = makeDir('agentflow-merge-wa2-');
    const wsB2 = makeDir('agentflow-merge-wb2-');
    writeFiles(wsA1, { 'src/dev_a/a.ts': '// a\n' });
    writeFiles(wsB1, { 'src/dev_b/b.ts': '// b\n' });
    writeFiles(wsA2, { 'src/dev_a/a.ts': '// a\n' });
    writeFiles(wsB2, { 'src/dev_b/b.ts': '// b\n' });

    const forward = mergeBatchChanges({ repoPath: repoForward, nodes: nodes(repoForward, wsA1, wsB1) });
    const backward = mergeBatchChanges({
      repoPath: repoBackward,
      nodes: nodes(repoBackward, wsA2, wsB2).reverse(),
    });

    expect(readFileSync(join(repoForward, 'src/dev_a/a.ts'), 'utf8')).toBe(
      readFileSync(join(repoBackward, 'src/dev_a/a.ts'), 'utf8'),
    );
    expect(readFileSync(join(repoForward, 'src/dev_b/b.ts'), 'utf8')).toBe(
      readFileSync(join(repoBackward, 'src/dev_b/b.ts'), 'utf8'),
    );
    // 报告也按 nodeId 归一排序，处理顺序不影响结论
    expect(forward).toEqual(backward);
  });

  it('失败节点的改动不被合并（失败产物不可信），报告给出原因', () => {
    const repo = makeDir('agentflow-merge-repo-');
    const wsB = makeDir('agentflow-merge-b-');
    const wsA = makeDir('agentflow-merge-a-');
    writeFiles(wsA, { 'src/dev_a/a.ts': '// a\n' });
    writeFiles(wsB, { 'src/dev_b/b.ts': '// b\n' });

    const outcomes = mergeBatchChanges({
      repoPath: repo,
      nodes: [
        node({ nodeId: 'dev_a', workspacePath: wsA, changedPaths: ['src/dev_a/a.ts'], owns: ['src/dev_a/**'] }),
        node({
          nodeId: 'dev_b',
          workspacePath: wsB,
          changedPaths: ['src/dev_b/b.ts'],
          owns: ['src/dev_b/**'],
          succeeded: false,
        }),
      ],
    });

    expect(existsSync(join(repo, 'src/dev_a/a.ts'))).toBe(true);
    expect(existsSync(join(repo, 'src/dev_b/b.ts'))).toBe(false);
    const devB = outcomes.find((o) => o.nodeId === 'dev_b')!;
    expect(devB.mergedPaths).toEqual([]);
    expect(devB.skippedPaths).toEqual(['src/dev_b/b.ts']);
    expect(devB.reason).toContain('失败');
  });

  it('越界路径即便出现在成功节点里也不合并（防御性），主工作区同名文件保持原样', () => {
    const repo = makeDir('agentflow-merge-repo-');
    const ws = makeDir('agentflow-merge-ws-');
    writeFiles(repo, { 'README.md': '# 原样\n' });
    writeFiles(ws, { 'src/dev_a/a.ts': '// a\n', 'README.md': '# 被越界改写\n' });

    const outcomes = mergeBatchChanges({
      repoPath: repo,
      nodes: [
        node({
          nodeId: 'dev_a',
          workspacePath: ws,
          changedPaths: ['src/dev_a/a.ts', 'README.md'],
          owns: ['src/dev_a/**'],
        }),
      ],
    });

    expect(readFileSync(join(repo, 'src/dev_a/a.ts'), 'utf8')).toBe('// a\n');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# 原样\n');
    expect(outcomes[0]!.mergedPaths).toEqual(['src/dev_a/a.ts']);
    expect(outcomes[0]!.skippedPaths).toEqual(['README.md']);
    expect(outcomes[0]!.reason).toContain('越界');
  });

  it('节点删除的路径在主工作区同步删除（源不存在即删除）', () => {
    const repo = makeDir('agentflow-merge-repo-');
    const ws = makeDir('agentflow-merge-ws-');
    writeFiles(repo, { 'src/dev_a/gone.ts': '// 旧文件\n' });

    mergeBatchChanges({
      repoPath: repo,
      nodes: [
        node({ nodeId: 'dev_a', workspacePath: ws, changedPaths: ['src/dev_a/gone.ts'], owns: ['src/dev_a/**'] }),
      ],
    });

    expect(existsSync(join(repo, 'src/dev_a/gone.ts'))).toBe(false);
  });
});