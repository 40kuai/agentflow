/** 产物浏览器：回答"每个角色产出了什么"，并把非 ok 的自评状态（blocked / needs_changes）显著标出 */

import { useState } from 'react';
import type { Artifact, TaskState } from '../api';
import type { NodeAggregate, TaskAggregate } from '../aggregate';
import { asNumber, asRecord, asString, asStringArray, shortId } from '../format';
import {
  ArtifactStatusBadge,
  Badge,
  Collapsible,
  CopyButton,
  EmptyState,
  JsonBlock,
  PreBlock,
  Section,
  TimeAgo,
} from './common';

type Props = {
  state: TaskState;
  aggregate: TaskAggregate;
};

export function ArtifactView({ state, aggregate }: Props) {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const artifacts = state.artifacts ?? [];

  // artifact → node 的归属：只能走 NodeState.artifactIds（投影未输出 artifact.node_id）
  const nodeByArtifact = new Map<string, NodeAggregate>();
  for (const node of aggregate.nodes) {
    for (const id of node.artifactIds) nodeByArtifact.set(id, node);
  }

  const counts = {
    ok: artifacts.filter((a) => a.status === 'ok').length,
    needs_changes: artifacts.filter((a) => a.status === 'needs_changes').length,
    blocked: artifacts.filter((a) => a.status === 'blocked').length,
  };

  const filtered =
    statusFilter === 'all' ? artifacts : artifacts.filter((a) => a.status === statusFilter);

  return (
    <div className="artifact-view">
      <Section
        title={`产物（${artifacts.length}）`}
        right={
          <div className="filters">
            {(['all', 'ok', 'needs_changes', 'blocked'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`tab-btn${statusFilter === option ? ' active' : ''}`}
                onClick={() => setStatusFilter(option)}
              >
                {option === 'all' ? `全部 ${artifacts.length}` : `${option} ${counts[option]}`}
              </button>
            ))}
          </div>
        }
      >
        {counts.blocked > 0 || counts.needs_changes > 0 ? (
          <div className="notice warn">
            模型自评为非 ok 的产物：{counts.blocked} 个 blocked、{counts.needs_changes} 个 needs_changes。
            这是模型自己给出的"不能继续"结论，工作流的边条件（
            <code>all(artifacts.*.status == &apos;ok&apos;)</code>）会因此不成立。
          </div>
        ) : null}

        {artifacts.length === 0 ? (
          <EmptyState>该任务还没有产物。节点成功产出结构化结果后才会出现 artifact。</EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState>没有 status = {statusFilter} 的产物。</EmptyState>
        ) : (
          <div className="artifact-list">
            {filtered.map((artifact) => (
              <ArtifactCard
                key={artifact.artifact_id}
                artifact={artifact}
                node={nodeByArtifact.get(artifact.artifact_id) ?? null}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function ArtifactCard({ artifact, node }: { artifact: Artifact; node: NodeAggregate | null }) {
  const tone =
    artifact.status === 'blocked'
      ? 'is-blocked'
      : artifact.status === 'needs_changes'
        ? 'is-warn'
        : '';

  return (
    <div className={`artifact-card ${tone}`}>
      <div className="artifact-head">
        <div className="artifact-title">
          <span className="artifact-type">{artifact.type}</span>
          <ArtifactStatusBadge status={artifact.status} />
          {node ? (
            <Badge tone="muted">{node.nodeId}</Badge>
          ) : (
            <Badge tone="muted">节点未知</Badge>
          )}
        </div>
        <div className="artifact-ids">
          <span className="mono muted" title={artifact.artifact_id}>
            {shortId(artifact.artifact_id, 16)}
          </span>
          <span className="mono muted" title={artifact.run_id}>
            run {shortId(artifact.run_id, 14)}
          </span>
          <span className="muted">v{artifact.schema_version}</span>
          <TimeAgo ts={artifact.created_at} />
        </div>
      </div>

      <div className="artifact-summary">{artifact.summary}</div>

      <PayloadView artifact={artifact} />

      {artifact.refs && artifact.refs.length > 0 && (
        <div className="artifact-refs">
          <span className="muted">refs</span>
          {artifact.refs.map((ref, index) => (
            <span key={`${ref.uri}-${index}`} className="ref-chip">
              <Badge tone="muted">{ref.kind}</Badge>
              <code>{ref.uri}</code>
            </span>
          ))}
        </div>
      )}

      <div className="artifact-actions">
        <CopyButton text={safeJson(artifact.payload)} label="复制 payload" />
      </div>
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 按产物类型结构化展示 payload；未知类型回落为格式化 JSON */
function PayloadView({ artifact }: { artifact: Artifact }) {
  const payload = asRecord(artifact.payload);

  if (!payload) {
    return (
      <Collapsible title={<span className="muted">payload（非对象）</span>}>
        <PreBlock text={safeJson(artifact.payload)} maxHeight={360} />
      </Collapsible>
    );
  }

  switch (artifact.type) {
    case 'requirement':
      return <RequirementPayload payload={payload} />;
    case 'work_package_plan':
      return <WorkPackagePayload payload={payload} />;
    case 'code_diff':
      return <CodeDiffPayload payload={payload} raw={artifact.payload} />;
    case 'test_report':
      return <TestReportPayload payload={payload} />;
    default:
      return (
        <Collapsible title={<span className="muted">payload（未知类型，原始 JSON）</span>}>
          <JsonBlock value={artifact.payload} maxHeight={420} />
        </Collapsible>
      );
  }
}

function FieldList({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="payload-field">
      <div className="payload-label">{label}</div>
      {items.length === 0 ? (
        <div className="muted">（空）</div>
      ) : (
        <ul className="payload-list">
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RequirementPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="payload-structured">
      <div className="payload-field">
        <div className="payload-label">problem</div>
        <div className="payload-text">{asString(payload['problem'], '（空）')}</div>
      </div>
      <FieldList label="goals" items={asStringArray(payload['goals'])} />
      <FieldList label="non_goals" items={asStringArray(payload['non_goals'])} />
      <FieldList label="acceptance_criteria" items={asStringArray(payload['acceptance_criteria'])} />
    </div>
  );
}

function WorkPackagePayload({ payload }: { payload: Record<string, unknown> }) {
  const packages = Array.isArray(payload['packages']) ? payload['packages'] : [];
  if (packages.length === 0) {
    return <JsonBlock value={payload} maxHeight={360} />;
  }
  return (
    <div className="payload-structured">
      {packages.map((rawPkg, index) => {
        const pkg = asRecord(rawPkg);
        if (!pkg) return null;
        const contract = asRecord(pkg['interface_contract']);
        return (
          <div key={index} className="wp-card">
            <div className="wp-head">
              <b>{asString(pkg['name'], '未命名工作包')}</b>
              <span className="mono muted">{asString(pkg['id'])}</span>
            </div>
            <FieldList label="owns（写权限）" items={asStringArray(pkg['owns'])} />
            <FieldList label="reads" items={asStringArray(pkg['reads'])} />
            <FieldList label="depends_on" items={asStringArray(pkg['depends_on'])} />
            <FieldList label="acceptance_refs" items={asStringArray(pkg['acceptance_refs'])} />
            {contract && Object.keys(contract).length > 0 && (
              <div className="payload-field">
                <div className="payload-label">interface_contract</div>
                <ul className="payload-list">
                  {Object.entries(contract).map(([signature, behavior]) => (
                    <li key={signature}>
                      <code>{signature}</code>
                      <span className="muted"> → {asString(behavior)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CodeDiffPayload({
  payload,
  raw,
}: {
  payload: Record<string, unknown>;
  raw: unknown;
}) {
  const selfTest = asString(payload['self_test_result'], 'unknown');
  // 后端 code_diff 的 schema 里没有 diff 字段（只有 files_changed / insertions / deletions）。
  // 若某天载荷里带了 diff，这里照样按增删着色展示；没有就明确说明。
  const diff = typeof payload['diff'] === 'string' ? (payload['diff'] as string) : null;

  return (
    <div className="payload-structured">
      <div className="kv-grid compact">
        <div className="kv">
          <div className="kv-label">branch</div>
          <div className="kv-value mono">{asString(payload['branch'], '—')}</div>
        </div>
        <div className="kv">
          <div className="kv-label">wp_id</div>
          <div className="kv-value mono">{asString(payload['wp_id'], '—')}</div>
        </div>
        <div className="kv">
          <div className="kv-label">insertions / deletions</div>
          <div className="kv-value">
            <span className="add">+{asNumber(payload['insertions'])}</span>{' '}
            <span className="del">-{asNumber(payload['deletions'])}</span>
          </div>
        </div>
        <div className="kv">
          <div className="kv-label">self_test_result</div>
          <div className="kv-value">
            <Badge tone={selfTest === 'passed' ? 'ok' : selfTest === 'failed' ? 'fail' : 'muted'}>
              {selfTest}
            </Badge>
          </div>
        </div>
      </div>
      <FieldList label="files_changed" items={asStringArray(payload['files_changed'])} />
      {asString(payload['notes']) !== '' && (
        <div className="payload-field">
          <div className="payload-label">notes</div>
          <div className="payload-text">{asString(payload['notes'])}</div>
        </div>
      )}
      {diff ? (
        <div className="payload-field">
          <div className="payload-label">diff</div>
          <DiffBlock diff={diff} />
        </div>
      ) : (
        <div className="notice">
          该代码改动产物未带 <code>diff</code> 字段（内核 code_diff schema 只记录 branch / files_changed /
          insertions / deletions / self_test_result / notes）。
          <Collapsible title={<span className="muted">查看完整 payload JSON</span>}>
            <JsonBlock value={raw} maxHeight={320} />
          </Collapsible>
        </div>
      )}
    </div>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <div className="diff-block">
      <div className="json-block-toolbar">
        <CopyButton text={diff} label="复制 diff" />
      </div>
      <pre className="mono-pre diff-pre">
        {lines.map((line, index) => {
          const cls = line.startsWith('+++') || line.startsWith('---')
            ? 'diff-meta'
            : line.startsWith('@@')
              ? 'diff-hunk'
              : line.startsWith('+')
                ? 'diff-add'
                : line.startsWith('-')
                  ? 'diff-del'
                  : 'diff-ctx';
          return (
            <div key={index} className={`diff-line ${cls}`}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function TestReportPayload({ payload }: { payload: Record<string, unknown> }) {
  const failures = Array.isArray(payload['failures']) ? payload['failures'] : [];
  const passed = asNumber(payload['passed']);
  const failed = asNumber(payload['failed']);
  return (
    <div className="payload-structured">
      <div className="kv-grid compact">
        <div className="kv">
          <div className="kv-label">passed</div>
          <div className="kv-value tone-ok">{passed}</div>
        </div>
        <div className="kv">
          <div className="kv-label">failed</div>
          <div className={`kv-value${failed > 0 ? ' tone-fail' : ''}`}>{failed}</div>
        </div>
        <div className="kv">
          <div className="kv-label">wp_id</div>
          <div className="kv-value mono">{asString(payload['wp_id'], '—')}</div>
        </div>
      </div>
      <FieldList label="suites" items={asStringArray(payload['suites'])} />
      {failures.length > 0 && (
        <div className="payload-field">
          <div className="payload-label">failures</div>
          <ul className="payload-list">
            {failures.map((rawFailure, index) => {
              const failure = asRecord(rawFailure);
              return (
                <li key={index}>
                  <b>{asString(failure?.['test'], '未知用例')}</b>
                  <div className="muted">{asString(failure?.['reason'])}</div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}