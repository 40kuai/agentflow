import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId } from '../shared/ids.js';
import { KernelEventSchema, type KernelEvent, type NewEvent } from '../shared/events.js';

export interface EventStore {
  append(event: NewEvent): KernelEvent;
  readTask(taskId: string): KernelEvent[];
  readAll(): KernelEvent[];
  lastSeq(): number;
  close(): void;
}

type EventRow = {
  seq: number;
  event_id: string;
  task_id: string;
  type: string;
  payload: string;
  actor: string;
  created_at: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  task_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
`;

function rowToEvent(row: EventRow): KernelEvent {
  return KernelEventSchema.parse({
    seq: row.seq,
    event_id: row.event_id,
    task_id: row.task_id,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    actor: row.actor,
    created_at: row.created_at,
  });
}

/** 创建事件库。dbPath 传 ':memory:' 用于测试 */
export function createEventStore(dbPath: string): EventStore {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    `INSERT INTO events (event_id, task_id, type, payload, actor, created_at)
     VALUES (@event_id, @task_id, @type, @payload, @actor, @created_at)`,
  );
  const readTaskStmt = db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC');
  const readAllStmt = db.prepare('SELECT * FROM events ORDER BY seq ASC');
  const lastSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS last FROM events');

  return {
    append(event: NewEvent): KernelEvent {
      const row = {
        event_id: newId('evt'),
        task_id: event.task_id,
        type: event.type,
        payload: JSON.stringify(event.payload),
        actor: event.actor,
        created_at: Date.now(),
      };
      const info = insertStmt.run(row);
      return KernelEventSchema.parse({
        seq: Number(info.lastInsertRowid),
        ...row,
        payload: event.payload,
      });
    },

    readTask(taskId: string): KernelEvent[] {
      return (readTaskStmt.all(taskId) as EventRow[]).map(rowToEvent);
    },

    readAll(): KernelEvent[] {
      return (readAllStmt.all() as EventRow[]).map(rowToEvent);
    },

    lastSeq(): number {
      return (lastSeqStmt.get() as { last: number }).last;
    },

    close(): void {
      db.close();
    },
  };
}