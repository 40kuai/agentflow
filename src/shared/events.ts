import { z } from 'zod';

/** 全部内核事件类型。Phase 1 只产生其中一部分，其余在后续阶段启用 */
export const KERNEL_EVENT_TYPES = [
  'task.created',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'wp.declared',
  'wp.started',
  'wp.merged',
  'node.queued',
  'node.started',
  'node.succeeded',
  'node.failed',
  'node.cancelled',
  'node.usage_recorded',
  'artifact.created',
  'artifact.invalidated',
  'transfer.decided',
  'budget.consumed',
  'budget.exceeded',
] as const;

export const KernelEventTypeSchema = z.enum(KERNEL_EVENT_TYPES);
export type KernelEventType = z.infer<typeof KernelEventTypeSchema>;

export const KernelEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  event_id: z.string().min(1),
  task_id: z.string().min(1),
  type: KernelEventTypeSchema,
  payload: z.record(z.unknown()),
  actor: z.string().min(1),
  created_at: z.number().int(),
});
export type KernelEvent = z.infer<typeof KernelEventSchema>;

/** 追加事件时的入参：seq / event_id / created_at 由事件库填充 */
export type NewEvent = {
  task_id: string;
  type: KernelEventType;
  payload: Record<string, unknown>;
  actor: string;
};

/** 决策来源。写在 transfer.decided 事件里，是"为什么走到这一步"的凭据 */
export type DecidedBy = 'rule' | 'llm' | 'human';

/**
 * 失败原因的**稳定分类枚举**。
 *
 * 存在的理由（真实痛点）：一次真实任务在 `pm_analyze` 失败，界面只显示一行
 * `CLI 退出码 1：调用失败：subtype=error_max_structured_output_retries，result=undefined`，
 * 使用者无法据此判断"哪个角色、为什么、下一步会怎样"。故失败路径必须写入这里的稳定枚举，
 * 让界面**无需解析 CLI 原始文本**即可展示根因；原始文本仍作为附加信息保留在事件里。
 *
 * 枚举取值刻意保持稳定（不要为新增 subtype 扩枚举；未知情形一律归入 `other`），
 * 否则下游（前端、查询 API）的展示会随 CLI 版本漂移。
 */
export const FAILURE_REASONS = [
  'permission_denied',
  'timeout',
  'invalid_payload',
  'structured_output_retries_exhausted',
  'condition_unmet',
  'other',
] as const;

export const FailureReasonSchema = z.enum(FAILURE_REASONS);
export type FailureReason = z.infer<typeof FailureReasonSchema>;

/** 分类枚举 → 面向使用者的中文说明。界面直接展示该文案，不必解析 CLI 原文 */
export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  permission_denied: '权限被拒',
  timeout: '超时',
  invalid_payload: '载荷不合规',
  structured_output_retries_exhausted: '结构化输出重试耗尽',
  condition_unmet: '条件不满足',
  other: '其他',
};