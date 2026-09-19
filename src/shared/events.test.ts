import { describe, expect, it } from 'vitest';
import { KERNEL_EVENT_TYPES, KernelEventSchema } from './events.js';

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