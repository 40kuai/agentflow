import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkBatchOwns,
  collectChangedPaths,
  commonLiteralPrefix,
  detectOwnsOverlaps,
  findOwnViolations,
  matchesOwns,
  ownsPatternsIntersect,
  segmentsIntersect,
} from './path-guard.js';

/** 造一个真实的临时 git 仓库：`collectChangedPaths` 必须走真实 git 才有意义 */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-pathguard-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'tracked.txt'), 'v1\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: dir, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init'],
    { cwd: dir, stdio: 'pipe' },
  );
  return dir;
}

describe('owns 路径匹配与越界检出（Task 7）', () => {
  it('全部变更都在 owns 内时：不产生越界（不误报）', () => {
    expect(findOwnViolations(['src/a.ts', 'src/deep/b.ts'], ['src/**'])).toEqual([]);
  });

  it('存在 owns 之外的变更时：返回越界路径清单', () => {
    expect(findOwnViolations(['src/a.ts', 'README.md', 'scripts/hello.sh'], ['src/**'])).toEqual([
      'README.md',
      'scripts/hello.sh',
    ]);
  });

  it('不带越界时返回空数组', () => {
    expect(findOwnViolations(['tests/a.test.ts'], ['tests/**'])).toEqual([]);
  });

  it('通配前缀不越段：`src/**` 不匹配 `srcx/a.ts`', () => {
    expect(matchesOwns('srcx/a.ts', ['src/**'])).toBe(false);
    expect(findOwnViolations(['srcx/a.ts'], ['src/**'])).toEqual(['srcx/a.ts']);
  });

  it('owns 为空（只读角色）时：任何变更都是越界', () => {
    expect(findOwnViolations(['README.md'], [])).toEqual(['README.md']);
  });

  it('支持精确文件与段内通配', () => {
    expect(matchesOwns('README.md', ['README.md'])).toBe(true);
    expect(matchesOwns('src/a.ts', ['src/*.ts'])).toBe(true);
    expect(matchesOwns('src/a.js', ['src/*.ts'])).toBe(false);
  });

  it('同一越界路径去重并排序', () => {
    expect(findOwnViolations(['README.md', './README.md', 'a/b.txt'], ['src/**'])).toEqual([
      'README.md',
      'a/b.txt',
    ]);
  });
});

describe('工作区变更路径采集（Task 7）', () => {
  it('覆盖未跟踪的新文件（端到端越界的真实形态）', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# 新增\n');
    writeFileSync(join(repo, 'scripts', 'hello.sh'), 'echo hi\n');

    const changed = collectChangedPaths(repo);
    expect(changed).toContain('README.md');
    expect(changed).toContain('scripts/hello.sh');
  });

  it('覆盖已跟踪文件的修改，并忽略未变更的干净仓库', () => {
    const repo = makeGitRepo();
    expect(collectChangedPaths(repo)).toEqual([]);

    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    expect(collectChangedPaths(repo)).toEqual(['tracked.txt']);
  });

  it('非 git 工作区返回空数组（无法判定，不误报）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflow-nogit-'));
    writeFileSync(join(dir, 'x.txt'), 'x\n');
    expect(collectChangedPaths(dir)).toEqual([]);
  });
});

describe('owns 重叠判定（Task 8）', () => {
  it('覆盖通配前缀重叠：`src/**` 与 `src/foo/**` 重叠', () => {
    expect(ownsPatternsIntersect('src/**', 'src/foo/**')).toBe(true);
  });

  it('同层不同子目录不重叠：`src/a/**` 与 `src/b/**` 不重叠', () => {
    expect(ownsPatternsIntersect('src/a/**', 'src/b/**')).toBe(false);
  });

  it('顶层不同目录不重叠：`src/**` 与 `tests/**` 不重叠', () => {
    expect(ownsPatternsIntersect('src/**', 'tests/**')).toBe(false);
  });

  it('字面量相等重叠、不同不重叠', () => {
    expect(ownsPatternsIntersect('README.md', 'README.md')).toBe(true);
    expect(ownsPatternsIntersect('README.md', 'CHANGELOG.md')).toBe(false);
  });

  it('段内通配参与重叠判定：`src/*.ts` 与 `src/a.ts` 重叠，`src/*.ts` 与 `src/a.js` 不重叠', () => {
    expect(ownsPatternsIntersect('src/*.ts', 'src/a.ts')).toBe(true);
    expect(ownsPatternsIntersect('src/*.ts', 'src/a.js')).toBe(false);
  });

  it('`**` 与任意模式重叠（含零段语义）', () => {
    expect(ownsPatternsIntersect('**', 'src/a/**')).toBe(true);
  });

  it('段级通配匹配：同名段可直接相交', () => {
    expect(segmentsIntersect('*', 'a')).toBe(true);
    expect(segmentsIntersect('a?c', 'abc')).toBe(true);
    expect(segmentsIntersect('abc', 'xyz')).toBe(false);
  });

  it('重叠路径段的人类可读描述取字面量公共前缀', () => {
    expect(commonLiteralPrefix('src/**', 'src/foo/**')).toBe('src');
    expect(commonLiteralPrefix('src/**', 'tests/**')).toBe('(仓库根)');
  });
});

describe('批次启动前的占用检查（Task 8）', () => {
  it('重叠被挡：返回涉及的两个节点与重叠路径段，默认策略为串行', () => {
    const decision = checkBatchOwns([
      { nodeId: 'dev_web', owns: ['src/**'] },
      { nodeId: 'dev_api', owns: ['src/api/**'] },
    ]);
    expect(decision.mode).toBe('serialize');
    if (decision.mode !== 'parallel') {
      expect(decision.reason).toContain('dev_web');
      expect(decision.reason).toContain('dev_api');
      expect(decision.reason).toContain('src');
      expect(decision.overlaps[0]?.overlapAt).toBe('src');
    }
  });

  it('重叠被挡：策略为 reject 时拒绝该批次', () => {
    const decision = checkBatchOwns(
      [
        { nodeId: 'n1', owns: ['src/**'] },
        { nodeId: 'n2', owns: ['src/foo/**'] },
      ],
      'reject',
    );
    expect(decision.mode).toBe('reject');
    if (decision.mode !== 'parallel') {
      expect(decision.reason).toContain('拒绝该批次');
    }
  });

  it('不相交被允许：`src/a/**` 与 `src/b/**` 可并行', () => {
    const decision = checkBatchOwns([
      { nodeId: 'dev_a', owns: ['src/a/**'] },
      { nodeId: 'dev_b', owns: ['src/b/**'] },
    ]);
    expect(decision.mode).toBe('parallel');
    expect(detectOwnsOverlaps([
      { nodeId: 'dev_a', owns: ['src/a/**'] },
      { nodeId: 'dev_b', owns: ['src/b/**'] },
    ])).toEqual([]);
  });

  it('只读节点（owns 为空）不写任何路径，与任何人都不冲突', () => {
    const decision = checkBatchOwns([
      { nodeId: 'pm', owns: [] },
      { nodeId: 'dev', owns: ['src/**'] },
    ]);
    expect(decision.mode).toBe('parallel');
  });

  it('单节点批次无需检查', () => {
    expect(checkBatchOwns([{ nodeId: 'dev', owns: ['src/**'] }]).mode).toBe('parallel');
  });
});