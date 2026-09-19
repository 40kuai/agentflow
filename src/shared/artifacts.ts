import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ARTIFACT_TYPES = [
  'requirement',
  'work_package_plan',
  'code_diff',
  'test_report',
] as const;

export const ArtifactTypeSchema = z.enum(ARTIFACT_TYPES);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactStatusSchema = z.enum(['ok', 'needs_changes', 'blocked']);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

/**
 * 每个 payload schema 内嵌 `status` 字段，目的是让模型能在**结构化输出里**表达自己的判断
 * （spec §5.3：role prompt 要求模型判断 ok / needs_changes / blocked）。
 * 它最终不是 payload 的一部分，而是 Artifact 行的独立列——由 parseArtifactPayload 提升出来、
 * 内核写入 artifact.created（2026-09-19 契约修复前，内核写死 'ok'，模型的判断被静默吃掉）。
 * `default('ok')` 是为**向后兼容**：`tests/fixtures/` 下逐字归档的真实样本没有该字段，加了默认值仍能解析。
 */
const RequirementPayload = z.object({
  problem: z.string().min(1),
  goals: z.array(z.string().min(1)),
  non_goals: z.array(z.string()),
  acceptance_criteria: z.array(z.string().min(1)),
  status: ArtifactStatusSchema.default('ok'),
});

const WorkPackageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 写入范围（glob 列表）。空数组表示该工作包/角色没有写入范围（只读），这是有意为之 */
  owns: z.array(z.string().min(1)),
  reads: z.array(z.string()),
  depends_on: z.array(z.string()),
  /** 接口契约：键为接口签名，值为行为描述。冻结后不可变 */
  interface_contract: z.record(z.string()),
  acceptance_refs: z.array(z.string()),
});

const WorkPackagePlanPayload = z.object({
  packages: z.array(WorkPackageSchema).min(1),
  status: ArtifactStatusSchema.default('ok'),
});

const CodeDiffPayload = z.object({
  wp_id: z.string().min(1),
  branch: z.string().min(1),
  files_changed: z.array(z.string()),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  self_test_result: z.enum(['passed', 'failed', 'not_run']),
  notes: z.string(),
  status: ArtifactStatusSchema.default('ok'),
});

const TestReportPayload = z.object({
  wp_id: z.string().min(1),
  suites: z.array(z.string()),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failures: z.array(z.object({ test: z.string(), reason: z.string() })),
  status: ArtifactStatusSchema.default('ok'),
});

/** 本阶段实现的 4 种 Artifact 载荷 schema */
export const ARTIFACT_PAYLOAD_SCHEMAS = {
  requirement: RequirementPayload,
  work_package_plan: WorkPackagePlanPayload,
  code_diff: CodeDiffPayload,
  test_report: TestReportPayload,
} satisfies Record<ArtifactType, z.ZodTypeAny>;

export const ArtifactRefSchema = z.object({
  kind: z.enum(['file', 'commit', 'artifact']),
  uri: z.string().min(1),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ArtifactSchema = z.object({
  artifact_id: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().min(1),
  type: ArtifactTypeSchema,
  status: ArtifactStatusSchema,
  schema_version: z.number().int().positive(),
  payload: z.unknown(),
  refs: z.array(ArtifactRefSchema),
  /**
   * 唯一会进入下游 prompt 的部分。这里约束的是字符数上限（4000 字符），不是 token 上限；
   * 「500 token」是 Task 9 上下文装配器用估算函数裁剪的约定，不由本 schema 约束
   */
  summary: z.string().max(4000),
  created_at: z.number().int(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ARTIFACT_SCHEMA_VERSION = 1;

/**
 * 解析后的载荷：`status` 被**提升到顶层**（它是 Artifact 行的独立列，不是 payload 语义的一部分），
 * `payload` 是剔除 status 之后的纯载荷，供内核写库 / 拼摘要。
 */
export type ParsedArtifactPayload = {
  status: ArtifactStatus;
  payload: Record<string, unknown>;
};

/** 校验并解析载荷；失败时抛出带 artifact 类型信息的错误 */
export function parseArtifactPayload(type: ArtifactType, raw: unknown): ParsedArtifactPayload {
  const schema = ARTIFACT_PAYLOAD_SCHEMAS[type];
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Artifact(${type}) 载荷校验失败：${result.error.message}`);
  }
  const { status, ...payload } = result.data as { status: ArtifactStatus } & Record<string, unknown>;
  return { status, payload };
}

/**
 * 导出 JSON Schema，供 claude --json-schema 使用，同时也会被内联进装配后的 prompt
 * （`src/kernel/context-assembler.ts`），两处必须是同一份、措辞一致。
 *
 * `status` 在 zod 侧带 `.default('ok')`（为兼容 `tests/fixtures/` 下无该字段的归档样本），
 * 因此 `zod-to-json-schema` **不会**把它列进 `required` —— 这会让模型漏给 status 时被 CLI/harness
 * 静默当成 `ok` 放行，边条件 `all(artifacts.*.status == 'ok')` 形同恒真，与本次契约修复的病根同类。
 * 故在此对**所有 4 个 payload 类型**统一把 `status` 注入 `required`：
 *  - 模型侧：CLI 强制必须给出该字段（漏给会被 harness 要求重试，而不是静默通过）；
 *  - 解析侧：仍容忍历史载荷缺省为 `'ok'`（归档 fixture 继续可用）。
 */
export function jsonSchemaForArtifact(type: ArtifactType): object {
  const schema = zodToJsonSchema(ARTIFACT_PAYLOAD_SCHEMAS[type], {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as { required?: string[] } & Record<string, unknown>;
  const required = Array.isArray(schema.required) ? [...schema.required] : [];
  if (!required.includes('status')) required.push('status');
  // 展开原 schema 以保留 additionalProperties: false 等既有形状
  return { ...schema, required };
}