import { describe, expect, it } from 'vitest';
import { loadAllRoles, loadWorkflow } from './loader.js';

const CONFIG_DIR = './config';

describe('仓库内的真实配置', () => {
  it('三个角色都能加载', () => {
    const roles = loadAllRoles(CONFIG_DIR);
    expect([...roles.keys()].sort()).toEqual(['backend_dev', 'pm', 'qa_engineer']);
    for (const role of roles.values()) {
      expect(role.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  it('simple_dev 工作流能加载且节点角色都存在', () => {
    const workflow = loadWorkflow(CONFIG_DIR, 'simple_dev');
    const roles = loadAllRoles(CONFIG_DIR);
    expect(workflow.nodes).toHaveLength(3);
    for (const node of workflow.nodes) {
      expect(roles.has(node.role)).toBe(true);
    }
  });

  it('simple_dev 所有节点 isolate 均为 false（Phase 1 硬约束护栏）', () => {
    // 硬约束理由：Phase 1 还没有"合并"能力。若某节点 isolate 为 true，
    // dev 会在 git worktree 里写代码，跑完 worktree 被回收，代码即丢失，
    // 随后在主工作区运行的 qa_verify 看不到任何改动，闭环就断了。
    // worktree 隔离必须与合并能力一起引入（Phase 2），故此处锁死 false。
    const workflow = loadWorkflow(CONFIG_DIR, 'simple_dev');
    for (const node of workflow.nodes) {
      expect(node.isolate).toBe(false);
    }
  });
});