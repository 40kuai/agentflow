/**
 * 角色面板：本次任务的角色与花费（用户明确要）+ 角色编辑（接 PUT /api/roles/:id）。
 *
 * 编辑的语义（与后端一致）：后端在**临时目录副本**上跑生产加载路径校验，非法配置返回 422
 * 且**一字不落盘**。这里如实把后端的中文错误展示出来，不做前端"善意猜测"。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  getRole,
  getTaskRoles,
  listRoles,
  updateRole,
  type FlowView,
  type RoleEditInput,
  type RoleView,
  type TaskRoleUsage,
} from '../api';
import { formatDuration, formatUsd } from '../format';
import { Badge, EmptyState, Section, StatusBadge } from './common';

type Props = {
  taskId: string;
  flow: FlowView | null;
  onOpenLog: (nodeId: string) => void;
};

export function RolePanel({ taskId, flow, onOpenLog }: Props) {
  const [usage, setUsage] = useState<TaskRoleUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleView[] | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const titleById = useMemo(
    () => new Map((flow?.nodes ?? []).map((node) => [node.id, node.title || node.id])),
    [flow],
  );

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await getTaskRoles(taskId));
      setUsageError(null);
    } catch (err) {
      setUsageError((err as Error).message);
    }
  }, [taskId]);

  const refreshRoles = useCallback(async () => {
    try {
      setRoles(await listRoles());
      setRolesError(null);
    } catch (err) {
      setRolesError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
    void refreshRoles();
  }, [refreshUsage, refreshRoles]);

  return (
    <div className="role-panel">
      <Section
        title="本次任务的角色与花费"
        right={<Badge tone="muted">GET /api/tasks/:id/roles</Badge>}
      >
        {usageError && <div className="inline-error">角色用量加载失败：{usageError}</div>}
        {!usage && !usageError && <EmptyState>正在加载角色用量…</EmptyState>}
        {usage && usage.roles.length === 0 && <EmptyState>该任务还没有调度过任何节点。</EmptyState>}
        {usage && usage.roles.length > 0 && (
          <table className="mini-table">
            <thead>
              <tr>
                <th>角色</th>
                <th>模型 / 预算</th>
                <th>节点</th>
                <th className="num">耗时</th>
                <th className="num">花费</th>
              </tr>
            </thead>
            <tbody>
              {usage.roles.map((role) => (
                <tr key={role.roleId}>
                  <td>
                    <div>
                      {role.displayName ?? role.roleId}{' '}
                      <span className="muted mono small">{role.roleId}</span>
                    </div>
                    <div className="muted small">共 {role.nodes.length} 个节点</div>
                  </td>
                  <td>
                    <div className="mono small">{role.model ?? '—'}</div>
                    <div className="muted small">
                      {role.budget
                        ? `重试 ≤${role.budget.maxRetries} · 墙钟 ${formatDuration(role.budget.maxWallTimeMs)}`
                        : '（未配置角色定义）'}
                    </div>
                  </td>
                  <td>
                    {role.nodes.map((node) => (
                      <div key={node.nodeId} className="role-node-row">
                        <button
                          type="button"
                          className="node-chip"
                          onClick={() => onOpenLog(node.nodeId)}
                          title="查看该节点日志"
                        >
                          {titleById.get(node.nodeId) ?? node.nodeId}
                        </button>
                        <StatusBadge status={node.status} />
                        <span className="muted small">
                          第 {node.attempt} 次
                          {node.produces ? ` · 产出 ${node.produces}` : ''}
                          {node.artifactTypes.length > 0 ? `（${node.artifactTypes.join(', ')}）` : ''}
                          {node.invalidatedArtifactTypes.length > 0
                            ? ` · 作废 ${node.invalidatedArtifactTypes.join(', ')}`
                            : ''}
                        </span>
                        <span className="muted small">{formatDuration(node.durationMs)}</span>
                      </div>
                    ))}
                  </td>
                  <td className="num">{formatDuration(role.totalDurationMs)}</td>
                  <td className="num money">{formatUsd(role.totalCostUsd)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4} className="muted">
                  合计（与 TaskState.budgetUsedUsd 同源：node.usage_recorded 累加）
                </td>
                <td className="num money">
                  <b>{formatUsd(usage.totalCostUsd)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Section>

      <Section
        title="角色清单与编辑"
        right={
          <span className="muted small">
            编辑会写入 <code>config/roles/&lt;id&gt;.yaml</code>；校验失败不落盘
          </span>
        }
      >
        {rolesError && <div className="inline-error">角色清单加载失败：{rolesError}</div>}
        {!roles && !rolesError && <EmptyState>正在加载角色清单…</EmptyState>}
        {roles && (
          <div className="role-editor">
            <div className="role-list">
              {roles.map((role) => (
                <button
                  key={role.id}
                  type="button"
                  className={`task-card${role.id === editingId ? ' active' : ''}`}
                  onClick={() => setEditingId(role.id === editingId ? null : role.id)}
                >
                  <div className="task-card-top">
                    <span className="task-title">{role.displayName}</span>
                    <span className="mono small muted">{role.id}</span>
                  </div>
                  <div className="task-card-meta">
                    <span className="muted small">
                      owns {role.owns.length === 0 ? '（只读）' : role.owns.join(' ')}
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {editingId ? (
              <RoleEditor
                key={editingId}
                roleId={editingId}
                onSaved={(saved) => {
                  setRoles((current) =>
                    current ? current.map((role) => (role.id === saved.id ? saved : role)) : current,
                  );
                }}
              />
            ) : (
              <EmptyState>选择左侧角色查看职责边界 / 禁止事项 / 完成判据 / owns / reads / 预算，并可编辑。</EmptyState>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

/** 一行一个元素的数组输入：空行忽略，前后空白裁剪（与后端 schema 的 min(1) 校验配合） */
function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function arrayToLines(values: string[]): string {
  return values.join('\n');
}

function RoleEditor({ roleId, onSaved }: { roleId: string; onSaved: (role: RoleView) => void }) {
  const [draft, setDraft] = useState<RoleEditInput | null>(null);
  const [role, setRole] = useState<RoleView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await getRole(roleId);
        if (cancelled) return;
        setRole(loaded);
        setDraft(toDraft(loaded));
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roleId]);

  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
    try {
      const result = await updateRole(roleId, draft);
      setRole(result.role);
      setDraft(toDraft(result.role));
      onSaved(result.role);
      setSaveOk(`已保存：${result.path}`);
    } catch (err) {
      // 后端的 422/400 带中文原因（错误的配置在哪、为什么被拒），原样展示
      const message =
        err instanceof ApiError && err.code
          ? `${err.message}（${err.code}，状态码 ${err.status}）`
          : (err as Error).message;
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <div className="inline-error">角色详情加载失败：{loadError}</div>;
  if (!draft || !role) return <EmptyState>正在加载角色详情…</EmptyState>;

  const patch = (part: Partial<RoleEditInput>): void => setDraft({ ...draft, ...part });

  return (
    <div className="role-form">
      <div className="role-form-head">
        <b>{role.displayName}</b>
        <span className="mono muted small">{role.id}</span>
        <span className="muted small">提示词：{role.systemPromptRef}</span>
      </div>

      <div className="role-form-grid">
        <label className="field">
          <span>显示名</span>
          <input value={draft.displayName} onChange={(e) => patch({ displayName: e.target.value })} />
        </label>
        <label className="field">
          <span>提示词引用（system_prompt_ref）</span>
          <input
            value={draft.systemPromptRef}
            onChange={(e) => patch({ systemPromptRef: e.target.value })}
          />
        </label>
        <label className="field">
          <span>模型</span>
          <input value={draft.model} onChange={(e) => patch({ model: e.target.value })} />
        </label>
        <label className="field">
          <span>最大重试次数</span>
          <input
            type="number"
            value={draft.maxRetries}
            onChange={(e) => patch({ maxRetries: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>最大墙钟时间（ms）</span>
          <input
            type="number"
            value={draft.maxWallTimeMs}
            onChange={(e) => patch({ maxWallTimeMs: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="role-form-grid two">
        <TextArea
          label="职责边界（responsibilities，一行一条）"
          value={arrayToLines(draft.responsibilities)}
          onChange={(text) => patch({ responsibilities: linesToArray(text) })}
        />
        <TextArea
          label="禁止事项（prohibitions）"
          value={arrayToLines(draft.prohibitions)}
          onChange={(text) => patch({ prohibitions: linesToArray(text) })}
        />
        <TextArea
          label="完成判据（done_criteria）"
          value={arrayToLines(draft.doneCriteria)}
          onChange={(text) => patch({ doneCriteria: linesToArray(text) })}
        />
        <TextArea
          label="可写路径（owns；空＝只读角色）"
          value={arrayToLines(draft.owns)}
          onChange={(text) => patch({ owns: linesToArray(text) })}
        />
        <TextArea
          label="可读路径（reads）"
          value={arrayToLines(draft.reads)}
          onChange={(text) => patch({ reads: linesToArray(text) })}
        />
        <TextArea
          label="产出类型（outputs；与工作流节点的 produces 必须一致）"
          value={arrayToLines(draft.outputs)}
          onChange={(text) => patch({ outputs: linesToArray(text) })}
        />
        <TextArea
          label="输入类型（inputs）"
          value={arrayToLines(draft.inputs)}
          onChange={(text) => patch({ inputs: linesToArray(text) })}
        />
      </div>

      <div className="role-form-actions">
        <button type="button" className="btn btn-primary btn-xs" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          disabled={saving}
          onClick={() => setDraft(toDraft(role))}
        >
          重置为已加载内容
        </button>
        {saveOk && <span className="tone-ok small">{saveOk}</span>}
      </div>

      {saveError && (
        <div className="banner banner-fail">
          <div className="banner-body">
            <b>编辑被拒绝</b>
            <span className="banner-detail">{saveError}</span>
            <span className="banner-detail muted">
              后端在临时副本上跑生产加载路径校验（角色 schema、提示词文件存在性、与工作流节点的契约一致性）；
              校验失败时真实配置文件一字未改。
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea rows={4} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function toDraft(role: RoleView): RoleEditInput {
  return {
    displayName: role.displayName,
    systemPromptRef: role.systemPromptRef,
    inputs: role.inputs,
    outputs: role.outputs,
    owns: role.owns,
    reads: role.reads,
    responsibilities: role.responsibilities,
    prohibitions: role.prohibitions,
    doneCriteria: role.doneCriteria,
    model: role.model,
    maxRetries: role.budget.maxRetries,
    maxWallTimeMs: role.budget.maxWallTimeMs,
  };
}