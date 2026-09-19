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

  it('simple_dev 所有节点 isolate 均为 false（串行基线护栏）', () => {
    // 之所以锁死 false：simple_dev 是**串行等价性基线**，其行为不得改变。
    // Task 11 已引入 worktree 隔离与确定性合并（isolate: true 的节点变得可达），
    // 但并行示例工作流属 Task 12；simple_dev 保持非隔离，确保串行行为与既有单测逐字一致。
    const workflow = loadWorkflow(CONFIG_DIR, 'simple_dev');
    for (const node of workflow.nodes) {
      expect(node.isolate).toBe(false);
    }
  });

  it('每个角色都声明了职责边界、禁止事项、完成判据，且加载后可读', () => {
    const roles = loadAllRoles(CONFIG_DIR);
    for (const role of roles.values()) {
      expect(role.responsibilities?.length).toBeGreaterThan(0);
      expect(role.prohibitions?.length).toBeGreaterThan(0);
      expect(role.doneCriteria?.length).toBeGreaterThan(0);
    }
  });

  it('simple_dev 的节点含说明与进入条件，边含说明与失败语义', () => {
    const workflow = loadWorkflow(CONFIG_DIR, 'simple_dev');
    for (const node of workflow.nodes) {
      expect(node.description).toBeTruthy();
      expect(node.entryCondition).toBeTruthy();
    }
    for (const edge of workflow.edges) {
      expect(edge.description).toBeTruthy();
      // simple_dev 是串行基线：条件不满足即判定任务失败
      expect(edge.onMissing).toBe('fail');
    }
  });

  it('simple_dev 节点的 consumes/produces 与角色 inputs/outputs 一致（唯一权威来源）', () => {
    const workflow = loadWorkflow(CONFIG_DIR, 'simple_dev');
    const roles = loadAllRoles(CONFIG_DIR);
    for (const node of workflow.nodes) {
      const role = roles.get(node.role);
      expect(role).toBeDefined();
      expect(node.consumes).toEqual(role!.inputs);
      expect(node.produces).toBe(role!.outputs[0]);
    }
  });
});