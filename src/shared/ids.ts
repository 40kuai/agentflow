import { randomUUID } from 'node:crypto';

/** 生成带语义前缀的 id，便于在日志和事件库里肉眼辨认实体类型 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}