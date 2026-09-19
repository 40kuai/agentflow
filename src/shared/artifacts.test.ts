import { describe, expect, it } from 'vitest';
import { ARTIFACT_PAYLOAD_SCHEMAS, jsonSchemaForArtifact } from './artifacts.js';

describe('Artifact payload schema', () => {
  it('requirement 接受合法载荷', () => {
    const r = ARTIFACT_PAYLOAD_SCHEMAS.requirement.safeParse({
      problem: '用户无法自动流转任务',
      goals: ['支持多角色自动流转'],
      non_goals: ['不做分布式调度'],
      acceptance_criteria: ['一个需求输入后三角色自动完成'],
    });
    expect(r.success).toBe(true);
  });

  it('requirement 缺少 problem 时拒绝', () => {
    const r = ARTIFACT_PAYLOAD_SCHEMAS.requirement.safeParse({
      goals: ['x'],
      non_goals: [],
      acceptance_criteria: [],
    });
    expect(r.success).toBe(false);
  });

  it('work_package_plan 缺少 interface_contract 或 acceptance_refs 时拒绝', () => {
    const bad = ARTIFACT_PAYLOAD_SCHEMAS.work_package_plan.safeParse({
      packages: [{ id: 'wp1', name: '后端接口', owns: [], reads: [], depends_on: [] }],
    });
    expect(bad.success).toBe(false);

    const good = ARTIFACT_PAYLOAD_SCHEMAS.work_package_plan.safeParse({
      packages: [
        {
          id: 'wp1',
          name: '后端接口',
          owns: ['src/server/**'],
          reads: ['docs/**'],
          depends_on: [],
          interface_contract: { 'GET /health': '返回 {ok:true}' },
          acceptance_refs: ['健康检查接口可用'],
        },
      ],
    });
    expect(good.success).toBe(true);
  });

  it('工作包缺少 owns 键时拒绝', () => {
    const r = ARTIFACT_PAYLOAD_SCHEMAS.work_package_plan.safeParse({
      packages: [
        {
          id: 'wp1',
          name: '只读调研',
          reads: ['docs/**'],
          depends_on: [],
          interface_contract: {},
          acceptance_refs: [],
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('owns: [] 合法，表示该工作包没有写入范围（只读语义，有意为之）', () => {
    const r = ARTIFACT_PAYLOAD_SCHEMAS.work_package_plan.safeParse({
      packages: [
        {
          id: 'wp1',
          name: '只读调研',
          owns: [],
          reads: ['docs/**'],
          depends_on: [],
          interface_contract: {},
          acceptance_refs: [],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('jsonSchemaForArtifact 产出可序列化的 JSON Schema 且顶层为 object', () => {
    const schema = jsonSchemaForArtifact('test_report') as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(() => JSON.stringify(schema)).not.toThrow();
  });
});