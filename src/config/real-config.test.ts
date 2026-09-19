import { describe, expect, it } from 'vitest';
import { checkBatchOwns, detectOwnsOverlaps } from '../kernel/path-guard.js';
import { loadAllRoles, loadWorkflow } from './loader.js';

const CONFIG_DIR = './config';

describe('仓库内的真实配置', () => {
  it('全部角色都能加载', () => {
    // simple_dev 的三个角色 + parallel_dev（Task 12）新增的三个角色（工作包拆解 + 两个按模块划分的开发）
    const roles = loadAllRoles(CONFIG_DIR);
    expect([...roles.keys()].sort()).toEqual([
      'backend_dev',
      'backend_dev_module_a',
      'backend_dev_module_b',
      'pm',
      'pm_planner',
      'qa_engineer',
    ]);
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

  it('parallel_dev 示例工作流能通过全部加载期校验（契约一致性 / 边引用完整性）', () => {
    // loadWorkflow 自身会在 schema 校验、start/边引用存在性、节点契约与角色一致性任一失败时抛错；
    // 因此「不抛错 + 结构断言」即证明该示例工作流通过加载期校验。
    const workflow = loadWorkflow(CONFIG_DIR, 'parallel_dev');
    const roles = loadAllRoles(CONFIG_DIR);
    expect(workflow.nodes).toHaveLength(5);
    for (const node of workflow.nodes) {
      const role = roles.get(node.role);
      expect(role).toBeDefined();
      expect(node.consumes).toEqual(role!.inputs);
      expect(node.produces).toBe(role!.outputs[0]);
      expect(node.description).toBeTruthy();
      expect(node.entryCondition).toBeTruthy();
    }
  });

  it('parallel_dev 结构：PM 产出 work_package_plan 后扇出两个开发节点，再 join 到测试节点', () => {
    const workflow = loadWorkflow(CONFIG_DIR, 'parallel_dev');
    // 首次真正用上 work_package_plan 产物类型
    const planNode = workflow.nodes.find((n) => n.id === 'pm_plan');
    expect(planNode?.produces).toBe('work_package_plan');
    // 扇出：pm_plan 有两条出边，分别指向两个开发节点
    expect(
      workflow.edges.filter((e) => e.from === 'pm_plan').map((e) => e.to).sort(),
    ).toEqual(['dev_module_a', 'dev_module_b']);
    // 两个开发节点各自产出 code_diff
    const devs = workflow.nodes.filter((n) => n.produces === 'code_diff').map((n) => n.id).sort();
    expect(devs).toEqual(['dev_module_a', 'dev_module_b']);
    // join：测试节点有两条入边（来自两个开发节点），且其失败语义为等待
    const joinEdges = workflow.edges.filter((e) => e.to === 'qa_verify');
    expect(joinEdges.map((e) => e.from).sort()).toEqual(['dev_module_a', 'dev_module_b']);
    for (const edge of joinEdges) expect(edge.onMissing).toBe('wait');
  });

  it('parallel_dev 的两个并行开发节点 owns 经占用检查判定为不相交（可并行）', () => {
    const workflow = loadWorkflow(CONFIG_DIR, 'parallel_dev');
    const roles = loadAllRoles(CONFIG_DIR);
    const batch = ['dev_module_a', 'dev_module_b'].map((id) => {
      const node = workflow.nodes.find((n) => n.id === id);
      expect(node).toBeDefined();
      return { nodeId: id, owns: roles.get(node!.role)!.owns };
    });
    // 两两重叠检测为空，且批次占用检查判定为可并行（未退化为串行/拒绝）
    expect(detectOwnsOverlaps(batch)).toEqual([]);
    expect(checkBatchOwns(batch).mode).toBe('parallel');
  });
});