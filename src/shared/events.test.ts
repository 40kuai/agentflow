import { describe, expect, it } from 'vitest';
import { FAILURE_REASON_LABELS, FAILURE_REASONS, KERNEL_EVENT_TYPES, KernelEventSchema } from './events.js';

describe('KernelEvent', () => {
  it('事件类型清单包含 Phase 1 必需的类型', () => {
    const required = [
      'task.created',
      'node.started',
      'node.succeeded',
      'artifact.created',
      'transfer.decided',
    ];
    for (const t of required) {
      expect(KERNEL_EVENT_TYPES).toContain(t);
    }
  });

  it('接受合法事件', () => {
    const r = KernelEventSchema.safeParse({
      seq: 1,
      event_id: 'evt_1',
      task_id: 'task_1',
      type: 'task.created',
      payload: { title: 'x' },
      actor: 'human',
      created_at: 1_700_000_000_000,
    });
    expect(r.success).toBe(true);
  });

  it('拒绝未知事件类型', () => {
    const r = KernelEventSchema.safeParse({
      seq: 1,
      event_id: 'evt_1',
      task_id: 'task_1',
      type: 'nope.happened',
      payload: {},
      actor: 'kernel',
      created_at: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe('失败原因分类枚举', () => {
  it('是稳定且完备的枚举（六类，含条件不满足与其他）', () => {
    expect(FAILURE_REASONS).toEqual([
      'permission_denied',
      'timeout',
      'invalid_payload',
      'structured_output_retries_exhausted',
      'condition_unmet',
      'other',
    ]);
  });

  it('每个分类都有中文说明，界面可直接展示而不必解析 CLI 原文', () => {
    for (const reason of FAILURE_REASONS) {
      expect(FAILURE_REASON_LABELS[reason]).toMatch(/[\u4e00-\u9fa5]/);
    }
    expect(FAILURE_REASON_LABELS.structured_output_retries_exhausted).toBe('结构化输出重试耗尽');
    expect(FAILURE_REASON_LABELS.condition_unmet).toBe('条件不满足');
  });
});