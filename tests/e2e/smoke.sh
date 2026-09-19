#!/usr/bin/env bash
set -euo pipefail

# ⚠️ 安全前提：端到端会真实启动 agent，而 simple_dev 的 dev_implement 拥有写权限
# （owns 非空 → acceptEdits + Edit/Write/Bash）。若在 AgentFlow 仓库里跑，agent 会
# 直接改写本项目的工作区。因此必须在一个**独立的临时 git 仓库**里跑：
# 让 AgentFlow 的 cwd（= 内核的 repoPath）落在这个临时仓库，而配置仍指向 AgentFlow 自己的 config。
AGENTFLOW_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

TARGET_REPO="$(mktemp -d /tmp/agentflow-e2e-target-XXXXXX)"
cd "$TARGET_REPO"
git init -q
git -c user.email=e2e@local -c user.name=e2e commit -q --allow-empty -m "初始提交"
echo "# 端到端目标仓库" > README.md

# 平台自身的运行时产物（事件库 / 运行日志 / worktree 落点）**刻意按默认形态放在目标仓库之内**：
# 内核的 repoPath = process.cwd()（= 目标仓库），Task 7 的 owns 路径级强制用 git status 采集
# 目标仓库的**实际变更路径**。修复前，这些平台自写的文件（尤其 logs/runs/*.jsonl）会被当成
# 「节点越界写入」，只读角色 pm_analyze 必然失败；修复后内核按注入的配置路径
# （AGENTFLOW_LOG_DIR / AGENTFLOW_DB_PATH / AGENTFLOW_WORKSPACE_DIR）把它们排除出「节点改动」。
# 本冒烟保持「运行时目录在目标仓库内」的形态，正是为了端到端覆盖该修复。

HOST="127.0.0.1"
PORT="${AGENTFLOW_PORT:-8787}"
BASE="http://${HOST}:${PORT}"

echo "==> 目标仓库：$TARGET_REPO"
echo "==> 运行时目录（刻意放在目标仓库内，验证 owns 核对会排除平台自身产物）"
echo "==> 启动 AgentFlow"
AGENTFLOW_CONFIG_DIR="$AGENTFLOW_ROOT/config" \
AGENTFLOW_DB_PATH="$TARGET_REPO/data/e2e.sqlite" \
AGENTFLOW_LOG_DIR="$TARGET_REPO/logs" \
AGENTFLOW_WORKSPACE_DIR="$TARGET_REPO/workspaces" \
  npx tsx "$AGENTFLOW_ROOT/src/main.ts" > /tmp/agentflow-e2e.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

echo "==> 等待服务就绪"
for i in $(seq 1 30); do
  if curl -sf "${BASE}/api/health" > /dev/null; then
    break
  fi
  sleep 1
done
curl -sf "${BASE}/api/health" > /dev/null || { echo "服务未能启动，日志："; cat /tmp/agentflow-e2e.log; exit 1; }

echo "==> 创建任务"
# requirement 必须落在各角色 owns 之内，否则 Task 7 的路径级强制会把节点判为越界失败：
#   dev_implement 的角色为 backend_dev，owns=["src/**"]；qa_verify 的角色为 qa_engineer，owns=["tests/**"]。
# 故这里要求产出 src/ 下的脚本（dev 写）与 tests/ 下的测试（qa 写），而不再要求写 scripts/ 与 README.md。
TASK_ID=$(curl -s -X POST "${BASE}/api/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"E2E 冒烟","requirementRaw":"在目标仓库的 src/ 目录新增 hello.sh（执行后输出 hello agentflow），并在 tests/ 目录新增一个测试脚本验证该输出。改动仅限 src/ 与 tests/，不要修改其它目录或文件。"}' \
  | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')

echo "任务 id：${TASK_ID}"
[ -n "${TASK_ID}" ] || { echo "创建任务失败"; exit 1; }

echo "==> 轮询任务状态（最长 40 分钟，每 5 秒一次）"
# 注意：原先用 sed -n 's/.*"status":"\([^"]*\)".*/\1/p' 提取状态是**错的**——
# sed 的 `.*` 是贪婪的，会匹配到最后一个 "status" 字段；而 TaskState 里 artifacts[].status
# 是 "ok"，于是取到的是 "ok" 而不是任务顶层 status，早退判据永不触发
# （Task 15 实测：必然跑满整个窗口才被 trap 中断，最终误判 FAIL）。
# 改为用 node 解析 JSON，直接取任务**顶层** status（node 项目已有，最可靠）。
for i in $(seq 1 480); do
  STATE=$(curl -s "${BASE}/api/tasks/${TASK_ID}")
  STATUS=$(echo "$STATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).status||'')}catch{console.log('')}})")
  echo "  [${i}] 已等待 $((i * 5)) 秒，status=${STATUS}"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    break
  fi
  sleep 5
done

echo "==> 最终状态"
echo "$STATE" | head -c 4000
echo

echo "==> 事件类型统计"
curl -s "${BASE}/api/tasks/${TASK_ID}/events" \
  | grep -o '"type":"[^"]*"' | sort | uniq -c | sort -rn

echo "==> 实测总花费 budgetUsedUsd / artifact 数 / requires approval 次数"
echo "$STATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log('  budgetUsedUsd = '+j.budgetUsedUsd)}catch(e){console.log('  budgetUsedUsd 解析失败')}})"
echo "  artifact.created 数 = $(curl -s "${BASE}/api/tasks/${TASK_ID}/events" | grep -o '"type":"artifact.created"' | wc -l | tr -d ' ')"
echo "  requires approval 次数 = $(grep -rho 'requires approval' "$TARGET_REPO/logs" 2>/dev/null | wc -l | tr -d ' ')"

echo "==> log_ref 是否真的指向存在的文件（Task 12/13 未在单测里覆盖的这一环在此补验）"
for ref in $(curl -s "${BASE}/api/tasks/${TASK_ID}/events" | grep -o '"log_ref":"[^"]*"' | sed 's/.*:"//;s/"$//' | sort -u); do
  if [ -f "$ref" ]; then echo "  OK   $ref"; else echo "  MISS $ref"; fi
done

echo "==> 目标仓库改动（预期：src/ 与 tests/ 的节点产物，加上 data/ logs/ workspaces/ 这些平台运行时目录）"
git -C "$TARGET_REPO" status --short || true

echo "==> 本仓库是否保持干净（不应被 agent 触碰）"
git -C "$AGENTFLOW_ROOT" status --short || true

echo "==> 判定"
if echo "$STATE" | grep -q '"status":"completed"'; then
  echo "PASS：任务完成"
else
  echo "FAIL：任务未完成，请检查上方状态与日志"
  exit 1
fi