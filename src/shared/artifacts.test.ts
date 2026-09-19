import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_PAYLOAD_SCHEMAS,
  ARTIFACT_TYPES,
  jsonSchemaForArtifact,
  parseArtifactPayload,
} from './artifacts.js';

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

describe('Artifact status 契约（由模型在结构化输出里给出，内核消费）', () => {
  const requirementBase = {
    problem: '用户无法自动流转任务',
    goals: ['支持多角色自动流转'],
    non_goals: ['不做分布式调度'],
    acceptance_criteria: ['一个需求输入后三角色自动完成'],
  };

  it('每个 payload schema 都接受 status 字段（模型可表达判断）', () => {
    const req = ARTIFACT_PAYLOAD_SCHEMAS.requirement.safeParse({ ...requirementBase, status: 'blocked' });
    expect(req.success && req.data.status).toBe('blocked');
    const wp = ARTIFACT_PAYLOAD_SCHEMAS.work_package_plan.safeParse({
      packages: [
        {
          id: 'wp1',
          name: 'x',
          owns: [],
          reads: [],
          depends_on: [],
          interface_contract: {},
          acceptance_refs: [],
        },
      ],
      status: 'blocked',
    });
    expect(wp.success && wp.data.status).toBe('blocked');
    const diff = ARTIFACT_PAYLOAD_SCHEMAS.code_diff.safeParse({
      wp_id: 'wp1',
      branch: 'main',
      files_changed: [],
      insertions: 0,
      deletions: 0,
      self_test_result: 'not_run',
      notes: '',
      status: 'blocked',
    });
    expect(diff.success && diff.data.status).toBe('blocked');
    const report = ARTIFACT_PAYLOAD_SCHEMAS.test_report.safeParse({
      wp_id: 'wp1',
      suites: [],
      passed: 0,
      failed: 0,
      failures: [],
      status: 'needs_changes',
    });
    expect(report.success && report.data.status).toBe('needs_changes');
  });

  it('归档样本形状（不含 status）仍能解析，status 默认为 ok（向后兼容）', () => {
    const parsed = parseArtifactPayload('requirement', requirementBase);
    expect(parsed.status).toBe('ok');
    expect(parsed.payload).toEqual(requirementBase);
  });

  it('parseArtifactPayload 把 status 提升到顶层，payload 里不再含 status', () => {
    const parsed = parseArtifactPayload('requirement', { ...requirementBase, status: 'blocked' });
    expect(parsed.status).toBe('blocked');
    expect(parsed.payload).not.toHaveProperty('status');
    expect((parsed.payload as Record<string, unknown>)['problem']).toBe(requirementBase.problem);
  });

  it('非法 status 被拒', () => {
    const r = ARTIFACT_PAYLOAD_SCHEMAS.requirement.safeParse({
      ...requirementBase,
      status: 'done',
    });
    expect(r.success).toBe(false);
  });

  it('jsonSchemaForArtifact 暴露 status 字段（下沉到 CLI 层强制）', () => {
    const schema = jsonSchemaForArtifact('requirement') as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties?.['status']).toBeDefined();
  });

  it('jsonSchemaForArtifact 把 status 注入 required（4 个类型都强制模型给出），且保留 additionalProperties: false', () => {
    // zod 侧的 status 带 .default('ok')（为兼容归档 fixture），故 zod-to-json-schema 不会把它列为 required。
    // 若不在 JSON Schema 上注入，模型漏给 status 就会被当成 'ok' 静默放行（边条件形同恒真）——
    // 这份 schema 同时用于签发 --json-schema 与内联进 prompt，故必须对所有 4 个类型一致地标为必填。
    for (const type of ARTIFACT_TYPES) {
      const schema = jsonSchemaForArtifact(type) as {
        required?: string[];
        additionalProperties?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema.required, `${type} 的 required 应包含 status`).toContain('status');
      expect(schema.properties?.['status'], `${type} 的 properties 应含 status`).toBeDefined();
      // 既有形状不得被破坏
      expect(schema.additionalProperties, `${type} 应保留 additionalProperties: false`).toBe(false);
    }
  });

  it('jsonSchemaForArtifact 剥离签发侧 status 的 default（4 个类型都不许兜底）', () => {
    // 解析侧（ARTIFACT_PAYLOAD_SCHEMAS 的 .default('ok')）必须保留（归档 fixture 依赖它），
    // 但签发侧不能带 default：required 与 default 并存会让「必填」形同虚设——
    // 一旦 harness 对缺失字段应用 default，模型漏给 status 就会被兜成 ok、边条件恒真。
    for (const type of ARTIFACT_TYPES) {
      const schema = jsonSchemaForArtifact(type) as {
        required?: string[];
        properties?: Record<string, Record<string, unknown>>;
      };
      expect(schema.required, `${type} 的 required 应包含 status`).toContain('status');
      const status = schema.properties?.['status'];
      expect(status, `${type} 的 properties 应含 status`).toBeDefined();
      expect(status?.['default'], `${type} 的签发 schema 不应带 default`).toBeUndefined();
      // 剥离 default 不得破坏其余形状
      expect(status?.['enum'], `${type} 的 status 枚举应保留`).toEqual([
        'ok',
        'needs_changes',
        'blocked',
      ]);
    }
  });
});