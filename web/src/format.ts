/** 数值、时间、文本格式化工具。金额固定 4 位小数，耗时人类可读，时间戳相对值 + 绝对值 hover。 */

const EMPTY = '—';

/** 金额：固定 4 位小数，非数字一律当 0 处理（后端字段可能为 null / undefined） */
export function formatUsd(value: number | null | undefined): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `$${n.toFixed(4)}`;
}

/** 纯数值：千分位 */
export function formatCount(value: number | null | undefined): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return n.toLocaleString('en-US');
}

/** 耗时：ms < 1000 → `450ms`；< 60s → `103.4s`；< 60min → `8.6min`；否则 `1.3h` */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return EMPTY;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}min`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** 绝对时间：YYYY-MM-DD HH:mm:ss（本地时区） */
export function formatAbsoluteTime(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return EMPTY;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** 时钟时间：HH:mm:ss（日志行时间戳用，日志密集时省掉日期） */
export function formatClock(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return EMPTY;
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 3 天前 */
export function formatRelativeTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return EMPTY;
  const diff = now - ts;
  if (diff < 0) return '刚刚';
  if (diff < 10_000) return '刚刚';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatAbsoluteTime(ts).slice(0, 10);
}

/** 短 id：`task_1a2b3c…` */
export function shortId(id: string | null | undefined, length = 12): string {
  if (typeof id !== 'string' || id.length === 0) return EMPTY;
  return id.length <= length ? id : `${id.slice(0, length)}…`;
}

/** 截断长文本，保留尾部信息量（工具返回常常开头是无关的路径列表） */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** 安全取值：payload 里的字符串字段 */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** 安全取值：payload 里的数字字段 */
export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 安全取值：payload 里的字符串数组 */
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 对象安全读取 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 事件时间戳：实现为 created_at，文档写作 ts —— 两者兼容 */
export function eventTime(event: { created_at?: number; ts?: number } | null | undefined): number {
  if (!event) return 0;
  if (typeof event.created_at === 'number' && Number.isFinite(event.created_at)) {
    return event.created_at;
  }
  if (typeof event.ts === 'number' && Number.isFinite(event.ts)) return event.ts;
  return 0;
}