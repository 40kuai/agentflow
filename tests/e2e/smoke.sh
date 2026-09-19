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

# 端口探测：目标端口若已被**别的进程**占用，本脚本**绝不静默继续**——否则本脚本启动的服务会
# EADDRINUSE 崩溃，而健康检查/建任务会打到那个陌生服务上，冒烟看似在跑、实际根本没测到被测代码
# （实测过：8787 被一个更早遗留的开发服务占用，其 repoPath=AgentFlow 本项目根，
#  导致 pm_analyze 把并发进程的改动判成越界，整次运行无效）。
# 处理方式（**绝不 kill 任何非自己启动的进程**）：
#   - 未显式指定 AGENTFLOW_PORT：自动改用一个空闲端口，并明确打印出来（推荐，开箱即用）；
#   - 显式指定了 AGENTFLOW_PORT 却被占用：立刻以明确的中文错误退出（尊重用户选择，不擅自换端口）。
port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN > /dev/null 2>&1; }
pick_free_port() {
  local p
  for p in $(seq 8790 8899); do
    if ! port_in_use "$p"; then echo "$p"; return 0; fi
  done
  return 1
}

if [ -n "${AGENTFLOW_PORT:-}" ]; then
  PORT="$AGENTFLOW_PORT"
  if port_in_use "$PORT"; then
    echo "错误：指定的 AGENTFLOW_PORT=$PORT 已被其它进程占用（不是本脚本启动的服务），冒烟会打不到被测服务。占用者："
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/        /'
    echo "      请改用其它空闲端口重跑，例如：AGENTFLOW_PORT=8791 bash tests/e2e/smoke.sh"
    echo "      （本脚本不会杀掉任何非自己启动的进程。）"
    exit 1
  fi
else
  PORT=8787
  if port_in_use "$PORT"; then
    ALT_PORT="$(pick_free_port)" || {
      echo "错误：默认端口 $PORT 被占用，且在 8790-8899 内未找到空闲端口；请用 AGENTFLOW_PORT 指定一个空闲端口后重跑。"
      exit 1
    }
    echo "注意：默认端口 $PORT 已被其它进程占用，自动改用空闲端口 ${ALT_PORT}（不会杀掉占用者）。占用者："
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/        /'
    PORT="$ALT_PORT"
  fi
fi
# 把最终端口导出给被测服务：src/main.ts 读 AGENTFLOW_PORT 决定监听端口。
# 若不导出，自动换端口后服务仍会绑默认 8787 → 健康检查打到陌生服务上，断言白跑。
export AGENTFLOW_PORT="$PORT"
BASE="http://${HOST}:${PORT}"
echo "==> 目标端口：$PORT"

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
# 健康检查通过后，再确认**本脚本启动的那个进程**仍存活：万一端口在预检之后又被别的进程抢占，
# 健康检查可能打到陌生服务上（结果不可信）。此时必须明确报错，绝不静默继续。
kill -0 "$SERVER_PID" 2>/dev/null || { echo "本脚本启动的服务（PID ${SERVER_PID}）已退出，日志："; cat /tmp/agentflow-e2e.log; exit 1; }

echo "==> 创建任务"
# requirement 必须**落在各角色自己的 owns 之内**，否则 Task 7 的路径级强制会把节点判为越界失败：
#   dev_implement 的角色为 backend_dev，owns=["src/**"]；qa_verify 的角色为 qa_engineer，owns=["tests/**"]；
#   pm_analyze 的角色为 pm，owns=[]（只读）。
# 所以需求文本按「三阶段各守其界」措辞（与 config/workflows/simple_dev.yaml 的
# 需求分析 → 编码实现 → 测试验证一致）：只要求**开发阶段在 src/** 内产出实现**，
# 测试由**测试工程师在其自有 tests/** 内**自行编写并运行。
# ⚠️ 切勿把「创建 tests/ 下的测试脚本」写进给开发节点的需求里——那会让 dev 代做 qa 的活、
# 越权写 tests/**，被安全闸**正确**拦下（上一次实测的 FAIL 正是这个原因）；
# 也切勿回到更早那套 scripts/hello.sh + README.md 的措辞（两者都在 backend_dev.owns 之外）。
TASK_ID=$(curl -s -X POST "${BASE}/api/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"E2E 冒烟","requirementRaw":"本任务在目标仓库内按「需求分析 → 编码实现 → 测试验证」三阶段推进，每个节点只做本阶段的事。编码实现阶段：只在 src/ 目录内新增可执行脚本 src/hello.sh（执行后输出一行 hello agentflow），不得改动 src/ 之外的任何文件，也不要创建 README、scripts/ 或测试文件。测试验证阶段：由测试工程师负责，在 tests/ 目录内编写并运行测试，验证 src/hello.sh 的实际输出。验收标准：运行 src/hello.sh 的输出为 hello agentflow。"}' \
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
EVENTS=$(curl -s "${BASE}/api/tasks/${TASK_ID}/events")
printf '%s' "$EVENTS" | grep -o '"type":"[^"]*"' | sort | uniq -c | sort -rn

echo "==> 实测总花费 budgetUsedUsd / artifact 数 / node.succeeded 数 / requires approval 次数"
echo "$STATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log('  budgetUsedUsd = '+j.budgetUsedUsd)}catch(e){console.log('  budgetUsedUsd 解析失败')}})"
ARTIFACT_COUNT=$(printf '%s' "$EVENTS" | grep -o '"type":"artifact.created"' | wc -l | tr -d ' ' || true)
NODE_SUCCEEDED_COUNT=$(printf '%s' "$EVENTS" | grep -o '"type":"node.succeeded"' | wc -l | tr -d ' ' || true)
echo "  artifact.created 数 = ${ARTIFACT_COUNT}"
echo "  node.succeeded 数 = ${NODE_SUCCEEDED_COUNT}"
echo "  requires approval 次数 = $(grep -rho 'requires approval' "$TARGET_REPO/logs" 2>/dev/null | wc -l | tr -d ' ')"

echo "==> log_ref 是否真的指向存在的文件（Task 12/13 未在单测里覆盖的这一环在此补验）"
for ref in $(printf '%s' "$EVENTS" | grep -o '"log_ref":"[^"]*"' | sed 's/.*:"//;s/"$//' | sort -u); do
  if [ -f "$ref" ]; then echo "  OK   $ref"; else echo "  MISS $ref"; fi
done

# 产出核对：断言每个角色的产出都落在它自己的 owns 之内（这是本冒烟单独覆盖的路径级安全闸）。
#   dev 的产出应是 src/ 下的实现（src/**）；qa 的产出应是 tests/ 下的测试（tests/**）。
SRC_OK=0
QA_OK=0
echo "==> 产出核对（各角色产出应落在其 owns 之内）"
if [ -f "$TARGET_REPO/src/hello.sh" ]; then
  echo "  OK   src/hello.sh 存在（dev 产出，落在 owns=src/**）"
  SRC_OK=1
else
  echo "  MISS src/hello.sh（dev 未在 owns=src/** 内产出）"
fi
TEST_FILE_COUNT=$(find "$TARGET_REPO/tests" -type f 2>/dev/null | wc -l | tr -d ' ' || true)
if [ "${TEST_FILE_COUNT}" -gt 0 ]; then
  echo "  OK   tests/ 下有 ${TEST_FILE_COUNT} 个测试文件（qa 产出，落在 owns=tests/**）"
  QA_OK=1
else
  echo "  MISS tests/ 下无测试文件（qa 未在 owns=tests/** 内产出）"
fi

# dev 的自测结果必须来自真实运行（backend_dev 的完成判据之一）：code_diff.payload.self_test_result 应为 passed。
SELF_TEST_OK=0
SELF_TEST_RESULT=$(printf '%s' "$STATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const cd=(j.artifacts||[]).find(a=>a.type==='code_diff');console.log(cd&&cd.payload&&cd.payload.self_test_result?cd.payload.self_test_result:'')}catch{console.log('')}})")
echo "==> dev 自测结果"
echo "  self_test_result = ${SELF_TEST_RESULT:-<未读到>}"
if [ "$SELF_TEST_RESULT" = "passed" ]; then SELF_TEST_OK=1; fi

echo "==> 目标仓库改动（预期：src/ 与 tests/ 的节点产物，加上 data/ logs/ workspaces/ 这些平台运行时目录）"
git -C "$TARGET_REPO" status --short || true

echo "==> 本仓库是否保持干净（不应被 agent 触碰）"
git -C "$AGENTFLOW_ROOT" status --short || true

echo "==> 判定"
PASS=1
echo "$STATE" | grep -q '"status":"completed"' || PASS=0
[ "${NODE_SUCCEEDED_COUNT}" -eq 3 ] || PASS=0
[ "${ARTIFACT_COUNT}" -eq 3 ] || PASS=0
[ "${SRC_OK}" -eq 1 ] || PASS=0
[ "${QA_OK}" -eq 1 ] || PASS=0
[ "${SELF_TEST_OK}" -eq 1 ] || PASS=0
if [ "$PASS" -eq 1 ]; then
  echo "PASS：任务完成（3 节点 succeeded / 3 个 artifact / dev 产出落在 src/**、qa 产出落在 tests/**、self_test_result=passed）"
else
  echo "FAIL：任务未达到通过标准，请检查上方状态、产出核对与日志"
  exit 1
fi