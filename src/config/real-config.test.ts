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
});