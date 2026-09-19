import { describe, expect, it } from 'vitest';
import { buildFacts } from './facts.js';
import { ExpressionError, evaluateExpression } from './expression.js';
import { project } from './projector.js';
import type { KernelEvent } from '../shared/events.js';
import type { WorkflowDef } from '../shared/domain.js';

const workflow: WorkflowDef = {
  id: 'simple_dev',
  start: 'pm_analyze',
  nodes: [
    { id: 'pm_analyze', title: '需求分析', role: 'pm', consumes: [], produces: 'requirement', isolate: false },
    { id: 'dev_implement', title: '编码实现', role: 'backend_dev', consumes: ['requirement'], produces: 'code_diff', isolate: true },
  ],
  edges: [{ from: 'pm_analyze', to: 'dev_implement', when: "all(artifacts.requirement.status == 'ok')", description: '需求已澄清', onMissing: 'fail' }],
};

function ev(type: KernelEvent['type'], payload: Record<string, unknown>, seq: number): KernelEvent {
  return { seq, event_id: `e${seq}`, task_id: 'task_1', type, payload, actor: 'test', created_at: seq };
}

describe('buildFacts', () => {
  it('产出的 facts 能驱动真实的条件表达式', () => {
    const state = project([
      ev('task.created', { title: 't', requirement_raw: 'r', base_branch: 'main' }, 1),
      ev('node.started', { node_id: 'pm_analyze', role_id: 'pm', run_id: 'run_1', attempt: 1 }, 2),
      ev('artifact.created', {
        artifact_id: 'a1',
        run_id: 'run_1',
        node_id: 'pm_analyze',
        type: 'requirement',
        status: 'ok',
        summary: '需求已澄清',
      }, 3),
      ev('node.succeeded', { node_id: 'pm_analyze', run_id: 'run_1', log_ref: 'x' }, 4),
    ]);

    const facts = buildFacts({ state, workflow, roles: new Map() });
    expect(evaluateExpression("all(artifacts.requirement.status == 'ok')", facts)).toBe(true);
    // 尚未产出的 artifact 类型没有对应路径，按表达式契约抛错（而非静默为 false）；
    // 状态机把求值抛错的边视为"不匹配"，所以该条件在流程上的效果仍是不放行
    expect(() => evaluateExpression("all(artifacts.code_diff.status == 'ok')", facts)).toThrow(
      ExpressionError,
    );
    expect(evaluateExpression("node.visit_count == 1", facts)).toBe(true);
  });

  it('无依赖时 all(deps(wp).status == ...) 为 true', () => {
    const facts = buildFacts({ state: project([]), workflow, roles: new Map() });
    expect(evaluateExpression("all(deps(task).status == 'merged')", facts)).toBe(true);
  });
});