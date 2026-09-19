import { z } from 'zod';

/** 全部内核事件类型。Phase 1 只产生其中一部分，其余在后续阶段启用 */
export const KERNEL_EVENT_TYPES = [
  'task.created',
  'task.completed',
  'task.failed',
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