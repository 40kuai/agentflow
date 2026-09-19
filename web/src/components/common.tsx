/** 通用展示件：状态徽章、时间、折叠块、JSON 块、复制按钮、空状态与错误框 */

import { useState, type ReactNode } from 'react';
import { formatAbsoluteTime, formatRelativeTime } from '../format';

export type Tone = 'ok' | 'run' | 'fail' | 'warn' | 'blocked' | 'muted';

/** 任务/节点状态 → 语义色。未知状态一律 muted，不崩 */
export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'succeeded':
    case 'completed':
    case 'ok':
      return 'ok';
    case 'running':
    case 'active':
      return 'run';
    case 'failed':
    case 'error':
      return 'fail';
    case 'needs_changes':
    case 'cancelled':
    case 'waiting_gate':
      return 'warn';
    case 'blocked':
      return 'blocked';
    case 'queued':
    default:
      return 'muted';
  }
}

/** 产物状态 → 语义色：ok 绿、needs_changes 琥珀、blocked 琥珀（加重） */
export function artifactTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'needs_changes':
      return 'warn';
    case 'blocked':
      return 'blocked';
    default:
      return 'muted';
  }
}

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge tone-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const value = status ?? 'unknown';
  return <Badge tone={statusTone(value)}>{value}</Badge>;
}

export function ArtifactStatusBadge({ status }: { status: string | null | undefined }) {
  const value = status ?? 'unknown';
  return (
    <Badge tone={artifactTone(value)} title={`产物自评状态：${value}`}>
      {value}
    </Badge>
  );
}

/** 相对时间，hover 显示绝对时间 */
export function TimeAgo({ ts, prefix }: { ts: number | null | undefined; prefix?: string }) {
  return (
    <span className="timeago" title={formatAbsoluteTime(ts)}>
      {prefix}
      {formatRelativeTime(ts)}
    </span>
  );
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button type="button" className="btn btn-ghost btn-xs" onClick={() => void handleCopy()}>
      {copied ? '已复制' : label}
    </button>
  );
}

export function Collapsible({
  title,
  children,
  defaultOpen = false,
  right,
  className = '',
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`collapsible ${className}`}>
      <div className="collapsible-head">
        <button type="button" className="collapsible-toggle" onClick={() => setOpen((v) => !v)}>
          <span className="caret">{open ? '▾' : '▸'}</span>
          <span className="collapsible-title">{title}</span>
        </button>
        {right}
      </div>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

/** 格式化 JSON 展示 + 复制 */
export function JsonBlock({ value, maxHeight }: { value: unknown; maxHeight?: number }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return (
    <div className="json-block">
      <div className="json-block-toolbar">
        <CopyButton text={text} />
      </div>
      <pre className="json" style={maxHeight ? { maxHeight } : undefined}>
        {text}
      </pre>
    </div>
  );
}

/** 等宽文本块 + 复制 */
export function PreBlock({
  text,
  maxHeight,
  className = '',
}: {
  text: string;
  maxHeight?: number;
  className?: string;
}) {
  return (
    <div className={`pre-block ${className}`}>
      <div className="json-block-toolbar">
        <CopyButton text={text} />
      </div>
      <pre className="mono-pre" style={maxHeight ? { maxHeight } : undefined}>
        {text}
      </pre>
    </div>
  );
}

export function Section({
  title,
  right,
  children,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h3>{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function ErrorBox({
  title,
  message,
  hint,
}: {
  title: string;
  message: string;
  hint?: ReactNode;
}) {
  return (
    <div className="error-box">
      <div className="error-box-title">{title}</div>
      <div className="error-box-message">{message}</div>
      {hint && <div className="error-box-hint">{hint}</div>}
    </div>
  );
}

/** 键值对网格：汇总条用 */
export function KeyValue({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="kv">
      <div className="kv-label">{label}</div>
      <div className={`kv-value${tone ? ` tone-${tone}` : ''}`}>{children}</div>
    </div>
  );
}