import { z } from 'zod';

// 新增字段的校验错误一律用中文：配置面向人类阅读与编辑，默认英文（如 "Required"）对使用者不友好。

export const RoleFileSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  system_prompt_ref: z.string().min(1),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()).min(1),
  owns: z.array(z.string()),
  reads: z.array(z.string()),
  // 职责边界：本角色负责的事项。用数组而非单个字符串，因为一个角色通常承担多项职责，逐条声明更清晰。
  responsibilities: z
    .array(z.string().min(1, 'responsibilities（职责边界）的每一项都不得为空'), {
      required_error: '缺少必填字段 responsibilities（职责边界）',
      invalid_type_error: 'responsibilities（职责边界）必须是字符串数组',
    })
    .min(1, 'responsibilities（职责边界）至少声明一条'),
  // 禁止事项：本角色明确不得做的事。数组便于逐条阅读与逐条校验。
  prohibitions: z
    .array(z.string().min(1, 'prohibitions（禁止事项）的每一项都不得为空'), {
      required_error: '缺少必填字段 prohibitions（禁止事项）',
      invalid_type_error: 'prohibitions（禁止事项）必须是字符串数组',
    })
    .min(1, 'prohibitions（禁止事项）至少声明一条'),
  // 完成判据：怎样算做完。数组便于逐条对照验收。
  done_criteria: z
    .array(z.string().min(1, 'done_criteria（完成判据）的每一项都不得为空'), {
      required_error: '缺少必填字段 done_criteria（完成判据）',
      invalid_type_error: 'done_criteria（完成判据）必须是字符串数组',
    })
    .min(1, 'done_criteria（完成判据）至少声明一条'),
  model: z.string().min(1),
  max_retries: z.number().int().nonnegative().default(2),
  max_wall_time_ms: z.number().int().positive(),
});
export type RoleFile = z.infer<typeof RoleFileSchema>;

export const WorkflowNodeFileSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  role: z.string().min(1),
  // consumes/produces 是**派生**字段：权威来源是角色的 inputs/outputs，
  // 此处声明的值必须与角色一致，否则加载期报错（见 loader.ts 的一致性校验）。
  consumes: z.array(z.string()),
  produces: z.string().min(1),
  isolate: z.boolean(),
  // 人类可读说明（可选；一旦声明就不得为空串）
  description: z.string().min(1, 'description（节点说明）不得为空').optional(),
  // 进入条件说明（可选；一旦声明就不得为空串）
  entry_condition: z.string().min(1, 'entry_condition（进入条件）不得为空').optional(),
});

export const WorkflowEdgeFileSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: z.string().optional(),
  // 人类可读说明（必填）：这条边在什么情况下、为什么走它
  description: z
    .string({ required_error: '缺少必填字段 description（边的人类可读说明）' })
    .min(1, 'description（边的人类可读说明）不得为空'),
  // 条件不满足时的失败语义（必填）：fail=判定任务失败；wait=保持等待（供 join 语义使用）
  // 用自定义 errorMap 覆盖 zod 默认英文消息（enum 的 invalid_enum_value 不受 invalid_type_error 影响）。
  on_missing: z.enum(['fail', 'wait'], {
    errorMap: (issue, ctx) =>
      issue.code === 'invalid_enum_value' || issue.code === 'invalid_type'
        ? { message: 'on_missing（条件不满足时的失败语义）只能是 fail 或 wait' }
        : { message: ctx.defaultError },
  }),
});

export const WorkflowFileSchema = z.object({
  id: z.string().min(1),
  start: z.string().min(1),
  nodes: z.array(WorkflowNodeFileSchema).min(1),
  edges: z.array(WorkflowEdgeFileSchema),
});
export type WorkflowFile = z.infer<typeof WorkflowFileSchema>;