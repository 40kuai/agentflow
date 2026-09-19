#!/usr/bin/env bash
#
# AgentFlow 服务启停管理
#
#   scripts/server.sh start     启动服务（已在运行则直接返回）
#   scripts/server.sh stop      停止服务（先 SIGTERM 优雅退出，超时再强杀）
#   scripts/server.sh restart   重启（等价于 stop + start）
#   scripts/server.sh status    查看运行状态（进程 / 端口 / 健康检查 / 活跃任务）
#   scripts/server.sh logs      查看服务日志（--follow 持续跟踪）
#
# 可选参数：
#   --force, -f    强制操作：忽略"有任务正在运行"的保护、可接管被占用的端口
#   --follow       仅对 logs 有效，等价于 tail -f
#
# 环境变量：
#   AGENTFLOW_PORT          服务端口（默认 8787）
#   AGENTFLOW_HOST          绑定地址（默认 127.0.0.1，与 src/config/env.ts 的默认值一致）
#   AGENTFLOW_STOP_TIMEOUT  优雅退出的等待秒数（默认 15）
#   AGENTFLOW_START_TIMEOUT 启动后等待健康检查的秒数（默认 30）
#
# 设计取舍：
#   1. 运行态文件（PID / 服务日志）放在 logs/ 下，并按端口命名 —— logs/ 已被 .gitignore
#      忽略，且按端口命名后可以用不同 AGENTFLOW_PORT 同时管多个实例。
#   2. stop 以"端口是否释放"作为最终判据，而不是只看 PID —— 因为 npx/tsx 会派生子进程，
#      只杀父进程可能留下仍占着端口的子进程（本项目在 claude 子进程上踩过同类问题）。
#   3. 有任务处于 active 时，stop/restart 会拒绝执行并要求 --force —— 强杀服务会中断
#      正在运行的 agent 任务，而任务已经花掉的钱不会退回。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${AGENTFLOW_PORT:-8787}"
HOST="${AGENTFLOW_HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"

RUN_DIR="$ROOT/logs"
PID_FILE="$RUN_DIR/server-${PORT}.pid"
LOG_FILE="$RUN_DIR/server-${PORT}.log"

STOP_TIMEOUT="${AGENTFLOW_STOP_TIMEOUT:-15}"
START_TIMEOUT="${AGENTFLOW_START_TIMEOUT:-30}"

FORCE=0
FOLLOW=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    --follow) FOLLOW=1 ;;
  esac
done

# ---------- 工具函数 ----------

say() { printf '%s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

# 读取 PID 文件中的进程号（文件不存在或为空则为空串）
pid_from_file() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE" 2>/dev/null || true
  fi
}

is_alive() {
  local p="${1:-}"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

# 监听该端口的进程号（可能有多个；macOS 自带 lsof）
port_pids() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

port_in_use() {
  [ -n "$(port_pids)" ]
}

health_ok() {
  curl -sf -m 3 "$BASE/api/health" >/dev/null 2>&1
}

# 列出正在运行（status=active）的任务，每行一个 "taskId: 标题"
active_tasks() {
  curl -s -m 5 "$BASE/api/tasks" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const o = JSON.parse(s);
        for (const t of o.tasks || []) {
          if (t.status === "active") console.log(`${t.taskId}: ${t.title || ""}`);
        }
      } catch { /* 服务不可用或响应异常时静默——调用方自行处理空结果 */ }
    });
  ' 2>/dev/null || true
}

# 正在运行的 agent 子进程数（best-effort，仅用于提示）
# 注意：用子 shell 包住 pgrep —— 在 pipefail 下 pgrep 无匹配会返回 1，
# 若不隔离会让整个管道判定为失败，进而把 "0" 也吞掉。
claude_procs() {
  (pgrep -f 'claude' 2>/dev/null || true) | wc -l | tr -d ' \n'
}

describe_port_owner() {
  local pids
  pids="$(port_pids)"
  for p in $pids; do
    local cmd
    cmd="$(ps -o command= -p "$p" 2>/dev/null | head -c 120 || echo '?')"
    say "   PID $p  $cmd"
  done
}

# 在停止前检查是否有活跃任务；有则除非 --force 否则拒绝
guard_active_tasks() {
  health_ok || return 0   # 服务没起来，谈不上中断任务
  local tasks
  tasks="$(active_tasks)"
  [ -z "$tasks" ] && return 0

  if [ "$FORCE" -eq 1 ]; then
    warn "以下任务正在运行，--force 已指定，将继续中断它们："
    printf '%s\n' "$tasks" | sed 's/^/   /' >&2
    return 0
  fi

  say "检测到正在运行的任务，已中止停止操作："
  printf '%s\n' "$tasks" | sed 's/^/   /'
  say ""
  say "强杀服务会中断这些 agent 任务，且已消耗的费用不会退回。"
  say "请先等它们跑完，或确认后加 --force："
  say "   $0 stop --force"
  exit 1
}

# ---------- 子命令 ----------

cmd_start() {
  mkdir -p "$RUN_DIR"

  # 已由本脚本启动且进程还活着
  local pid
  pid="$(pid_from_file)"
  if is_alive "$pid"; then
    if health_ok; then
      say "服务已在运行（PID ${pid}，${BASE}）"
      exit 0
    fi
    die "PID 文件里的进程 $pid 还活着，但 $BASE/api/health 不通。请先 stop 或查 logs。"
  fi

  # 清理陈旧的 PID 文件（进程已不在）
  if [ -n "$pid" ]; then
    warn "PID 文件指向的进程 $pid 已不存在，清理陈旧记录"
    rm -f "$PID_FILE"
  fi

  # 端口被占用（可能是上次未正常退出的实例）
  if port_in_use; then
    if [ "$FORCE" -eq 1 ]; then
      warn "端口 $PORT 被占用，--force 已指定，先终止占用进程："
      describe_port_owner >&2
      # shellcheck disable=SC2046
      kill -9 $(port_pids) 2>/dev/null || true
      sleep 1
      port_in_use && die "端口 $PORT 仍被占用，请手工排查"
    else
      say "端口 $PORT 已被占用："
      describe_port_owner
      say ""
      say "若确认那是需要替换的旧实例，请执行："
      say "   $0 start --force"
      exit 1
    fi
  fi

  say "启动服务：$BASE"
  say "  日志：$LOG_FILE"
  # 用 printf 写入一行分隔，便于在日志里区分每次启动
  printf '\n===== 启动于 %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"

  cd "$ROOT"
  local launcher
  if [ -x "$ROOT/node_modules/.bin/tsx" ]; then
    launcher="$ROOT/node_modules/.bin/tsx"
  else
    launcher="npx tsx"
  fi
  # shellcheck disable=SC2086
  nohup $launcher src/main.ts >> "$LOG_FILE" 2>&1 &
  local new_pid=$!
  echo "$new_pid" > "$PID_FILE"

  # 等待健康检查（服务起不来时给出日志尾部，便于定位）
  local waited=0
  while [ "$waited" -lt "$START_TIMEOUT" ]; do
    if health_ok; then
      say "✅ 启动成功（PID $(pid_from_file)，耗时 ${waited}s）"
      return 0
    fi
    if ! is_alive "$new_pid"; then
      say "进程已退出，日志尾部："
      tail -n 20 "$LOG_FILE" 2>/dev/null | sed 's/^/   /'
      rm -f "$PID_FILE"
      die "启动失败"
    fi
    sleep 1
    waited=$((waited + 1))
  done

  say "等待 ${START_TIMEOUT}s 后健康检查仍不通，日志尾部："
  tail -n 20 "$LOG_FILE" 2>/dev/null | sed 's/^/   /'
  die "启动超时（进程可能仍在启动中，可执行 $0 status 复查）"
}

cmd_stop() {
  guard_active_tasks

  local pid
  pid="$(pid_from_file)"
  local stopped_any=0

  if is_alive "$pid"; then
    say "停止服务（PID ${pid}）…"
    # 先杀子进程再杀父进程：tsx 可能派生子进程，只杀父进程会留下占着端口的孤儿
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    stopped_any=1
  fi

  # 以端口是否释放为最终判据（最多等 STOP_TIMEOUT 秒）
  local waited=0
  while [ "$waited" -lt "$STOP_TIMEOUT" ]; do
    if ! port_in_use; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # 仍在监听则强杀（正常情况走不到这里）
  if port_in_use; then
    warn "等待 ${STOP_TIMEOUT}s 后端口 $PORT 仍被占用，强制终止："
    describe_port_owner >&2
    # shellcheck disable=SC2046
    kill -9 $(port_pids) 2>/dev/null || true
    sleep 1
    stopped_any=1
  fi

  rm -f "$PID_FILE"

  if port_in_use; then
    die "端口 $PORT 仍被占用，请手工排查"
  fi

  if [ "$stopped_any" -eq 1 ]; then
    say "✅ 已停止，端口 $PORT 已释放"
  else
    say "服务未在运行（端口 $PORT 空闲）"
  fi
}

cmd_status() {
  local pid healthy=0
  pid="$(pid_from_file)"

  say "AgentFlow 服务状态（端口 ${PORT}）"
  say "----------------------------------------"

  if is_alive "$pid"; then
    say "进程      ：运行中（PID ${pid}）"
  elif [ -n "$pid" ]; then
    say "进程      ：PID 文件记录 ${pid}，但进程已不在（陈旧记录）"
  else
    say "进程      ：未由本脚本启动"
  fi

  if port_in_use; then
    say "端口 ${PORT} ：监听中"
    describe_port_owner
  else
    say "端口 ${PORT} ：空闲"
  fi

  if health_ok; then
    healthy=1
    say "健康检查  ：正常（$BASE/api/health）"
  else
    say "健康检查  ：不通"
  fi

  local tasks
  tasks="$(active_tasks)"
  if [ -n "$tasks" ]; then
    say "活跃任务  ："
    printf '%s\n' "$tasks" | sed 's/^/   /'
  elif [ "$healthy" -eq 1 ]; then
    say "活跃任务  ：无"
  else
    say "活跃任务  ：无法查询（服务未就绪）"
  fi

  local c
  c="$(claude_procs)"
  if [ "$c" -gt 0 ] 2>/dev/null; then
    say "claude 进程：$c 个（若服务已停却仍有残留，说明有孤儿进程需手工清理）"
  fi

  if [ -f "$LOG_FILE" ]; then
    say "服务日志  ：${LOG_FILE}（$(du -h "$LOG_FILE" | cut -f1)）"
  else
    say "服务日志  ：${LOG_FILE}（尚未生成）"
  fi

  [ "$healthy" -eq 1 ] || exit 1
}

cmd_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    say "服务日志尚未生成：$LOG_FILE"
    say "（服务日志在首次 start 后才会出现）"
    exit 0
  fi
  if [ "$FOLLOW" -eq 1 ]; then
    say "跟踪 ${LOG_FILE}（Ctrl-C 退出）"
    tail -n 50 -f "$LOG_FILE"
  else
    tail -n 100 "$LOG_FILE"
  fi
}

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
}

# ---------- 入口 ----------

CMD="${1:-}"
# 把已识别的开关从位置参数里剥掉，剩下的第一个词作为子命令
case "$CMD" in
  --force|-f|--follow) CMD="$(printf '%s\n' "$@" | grep -v -e '^--force$' -e '^-f$' -e '^--follow$' | head -n 1 || true)" ;;
esac

case "$CMD" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  ""|help|--help|-h) usage ;;
  *) say "未知子命令：$CMD"; say ""; usage; exit 1 ;;
esac