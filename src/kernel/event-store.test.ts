import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventStore, type EventStore } from './event-store.js';

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = createEventStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('append 后返回带 seq 与 created_at 的完整事件', () => {
    const e = store.append({
      task_id: 'task_1',
      type: 'task.created',
      payload: { title: '测试任务' },
      actor: 'human',
    });
    expect(e.seq).toBe(1);
    expect(e.task_id).toBe('task_1');
    expect(e.event_id).toMatch(/^evt_/);
    expect(e.created_at).toBeGreaterThan(0);
  });

  it('seq 全局单调递增，跨任务连续', () => {
    const a = store.append({ task_id: 't1', type: 'task.created', payload: {}, actor: 'human' });
    const b = store.append({ task_id: 't2', type: 'task.created', payload: {}, actor: 'human' });
    const c = store.append({ task_id: 't1', type: 'node.started', payload: {}, actor: 'kernel' });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(store.lastSeq()).toBe(3);
  });

  it('readTask 只返回该任务的事件，且按 seq 升序', () => {
    store.append({ task_id: 't1', type: 'task.created', payload: {}, actor: 'human' });
    store.append({ task_id: 't2', type: 'task.created', payload: {}, actor: 'human' });
    store.append({ task_id: 't1', type: 'node.started', payload: {}, actor: 'kernel' });

    const events = store.readTask('t1');
    expect(events.map((e) => e.type)).toEqual(['task.created', 'node.started']);
  });

  it('payload 能原样往返（含嵌套对象）', () => {
    store.append({
      task_id: 't1',
      type: 'artifact.created',
      payload: { artifact_id: 'a1', nested: { deep: [1, 2, 3] } },
      actor: 'role:pm',
    });
    const [loaded] = store.readTask('t1');
    expect(loaded?.payload).toEqual({ artifact_id: 'a1', nested: { deep: [1, 2, 3] } });
  });

  it('事件库只追加：同一 task 多次读取结果稳定增长，旧事件不被修改', () => {
    const first = store.append({ task_id: 't1', type: 'task.created', payload: {}, actor: 'human' });
    const before = store.readTask('t1');
    store.append({ task_id: 't1', type: 'node.started', payload: {}, actor: 'kernel' });
    const after = store.readTask('t1');
    expect(after[0]).toEqual(first);
    expect(before.length).toBe(1);
    expect(after.length).toBe(2);
  });
});