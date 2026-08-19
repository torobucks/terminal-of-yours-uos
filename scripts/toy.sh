#!/usr/bin/env bash
# Terminal-of-Yours 管理脚本
# 用户浏览器 (xterm.js) 与 agent (ZCode) 协同控制一个本地 PowerShell 终端。
#
# 用法:
#   toy.sh start               启动常驻服务并打开浏览器
#   toy.sh status              查看状态 (JSON)
#   toy.sh stop                停止服务 (保留/销毁会话见 kill-session)
#   toy.sh run '<命令>' [超时秒]  agent 注入命令并等待完成 (返回 {status,output,exitCode})
#   toy.sh keys '<按键序列>'     交互模式按键注入 (无哨兵，如 vim/ssh 内按键)
#   toy.sh pause               手动暂停 (置用户优先锁，拦截后续 run)
#   toy.sh resume              清用户锁 (resume)，由 agent 平台在对话确认后调用
#   toy.sh url                 打印浏览器地址
#   toy.sh kill-session        销毁当前终端会话 (进程树)
#   toy.sh doctor              环境自检 (复用了 install.sh --check-only)
#
# 环境变量: TOY_NO_OPEN=1 时不自动打开浏览器

set -euo pipefail

# 自定位：不依赖调用方 cwd（防偶发 127 / 反斜杠路径问题）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
export PATH="/usr/bin:/bin:$PATH"

SERVER="$ROOT/server"
RUNTIME="$ROOT/runtime"
PID_FILE="$RUNTIME/toy.pid"
PORT_FILE="$RUNTIME/toy.port"
CONSOLE_LOG="$RUNTIME/toy.console.log"

# 服务是否存活：以端口探测为准（toy.js 写的 toy.port 是实际监听端口）。
# 注意：不能用 kill -0 查 node 进程——MSYS 下对 Windows 原生进程不可靠
is_running() {
  [[ -f "$PORT_FILE" ]] || return 1
  curl -sf -o /dev/null -m 2 "http://127.0.0.1:$(cat "$PORT_FILE")/api/status" -H "X-TOY: 1" 2>/dev/null
}

get_port() {
  if [[ -f "$PORT_FILE" ]] && [[ -s "$PORT_FILE" ]]; then
    cat "$PORT_FILE"
  else
    echo 8787
  fi
}

# 跨平台打开浏览器：Windows/MSYS 用 cmd start，Linux/macOS 用 xdg-open/open
open_browser() {
  local url="$1"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)  cmd //c start "" "$url" >/dev/null 2>&1 || true ;;
    Darwin*)               open "$url" >/dev/null 2>&1 || true ;;
    *)                     xdg-open "$url" >/dev/null 2>&1 || true ;;
  esac
}

api() { # api METHOD PATH [DATA]  — 失败时明确报错而非静默
  local method="$1" path="$2" data="${3:-}"
  local port out
  port="$(get_port)"
  if [[ -n "$data" ]]; then
    out="$(curl -s -m 3660 -X "$method" "http://127.0.0.1:$port$path" \
      -H "Content-Type: application/json" -H "X-TOY: 1" -d "$data" 2>/dev/null)" || out=""
  else
    out="$(curl -s -m 60 -X "$method" "http://127.0.0.1:$port$path" -H "X-TOY: 1" 2>/dev/null)" || out=""
  fi
  if [[ -z "$out" || "$out" != \{* ]]; then
    echo "错误：无法连接 TOY 服务（127.0.0.1:$port）——服务未运行？先执行 bash $0 start" >&2
    return 1
  fi
  printf '%s' "$out"
}

cmd_start() {
  if is_running; then
    # 服务在跑但会话可能已 dead（kill-session 后）——重启服务重建会话
    local alive
    alive="$(api GET /api/status | grep -o '"sessionAlive":[a-z]*' | cut -d: -f2)"
    if [[ "$alive" == "false" ]]; then
      echo "会话已结束，重启服务重建..."
      cmd_stop >/dev/null
    else
      echo "已在运行: http://127.0.0.1:$(get_port) (pid $(cat "$PID_FILE"))"
      return 0
    fi
  fi
  if [[ ! -d "$SERVER/node_modules/node-pty" ]]; then
    echo "安装 node-pty (首次运行)..."
    (cd "$SERVER" && npm install --no-audit --no-fund)
  fi
  mkdir -p "$RUNTIME"
  # 清陈旧 pid/port（toy.js 启动后会写真实 node pid 与端口）
  rm -f "$PID_FILE" "$PORT_FILE"
  TOY_DIR="$ROOT" nohup node "$SERVER/toy.js" >"$CONSOLE_LOG" 2>&1 &
  local i port
  for i in $(seq 1 30); do
    if [[ -f "$PORT_FILE" ]] && port="$(get_port)" && \
       curl -sf -o /dev/null -m 2 "http://127.0.0.1:$port/api/status" -H "X-TOY: 1"; then
      echo "已启动: http://127.0.0.1:$port (pid $(cat "$PID_FILE" 2>/dev/null || echo '?'))"
      if [[ "${TOY_NO_OPEN:-0}" != "1" ]]; then
        open_browser "http://127.0.0.1:$port"
      fi
      return 0
    fi
    sleep 1
  done
  echo "启动失败，控制台日志: $CONSOLE_LOG" >&2
  tail -20 "$CONSOLE_LOG" >&2 || true
  return 1
}

cmd_status() {
  if ! is_running; then
    echo '{"running":false}'
    return 0
  fi
  api GET /api/status
}

cmd_stop() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        taskkill //F //T //PID "$pid" >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true
        ;;
      *)
        # Linux/macOS：优先杀整个进程组（node-pty 进程通常为组长，pgid==pid）
        kill -- -"$pid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true
        ;;
    esac
    rm -f "$PID_FILE" "$PORT_FILE"
    echo "已停止"
  else
    echo "未运行"
  fi
}

cmd_run() {
  [[ $# -ge 1 ]] || { echo "用法: toy.sh run '<命令>' [超时秒]" >&2; return 1; }
  local cmd="$1" timeout="${2:-120}"
  local b64
  b64="$(printf '%s' "$cmd" | base64 -w0)"
  api POST /api/run "{\"cmd_b64\":\"$b64\",\"timeout\":$timeout}"
}

cmd_keys() {
  [[ $# -ge 1 ]] || { echo "用法: toy.sh keys '<按键序列>'" >&2; return 1; }
  # printf %b 解释 \x03 \e \r \n \t 等转义序列（bash 单引号不解释，必须在这里转换）
  local seq b64
  seq="$(printf '%b' "$1")"
  b64="$(printf '%s' "$seq" | base64 -w0)"
  api POST /api/keys "{\"cmd_b64\":\"$b64\"}"
}

cmd_pause()  { api POST /api/pause; }
cmd_resume() { api POST /api/resume; }

cmd_mode() {
  # 查看或切换操作权：user（用户优先）| agent（agent 畅通、禁止用户输入）
  if [[ $# -ge 1 ]]; then
    local mode="$1"
    [[ "$mode" == "agent" || "$mode" == "user" ]] || { echo "用法: toy.sh mode [user|agent]" >&2; return 1; }
    api POST /api/mode "{\"mode\":\"$mode\"}"
  else
    api GET /api/status | grep -o '"controlMode":"[a-z]*"' | cut -d'"' -f4 || echo "user"
  fi
}

cmd_url() {
  echo "http://127.0.0.1:$(get_port)"
}

cmd_kill_session() {
  api POST /api/kill-session
}

cmd_doctor() {
  bash "$ROOT/scripts/install.sh" --check-only
}

case "${1:-}" in
  start)         cmd_start ;;
  status)        cmd_status ;;
  stop)          cmd_stop ;;
  run)           shift; cmd_run "$@" ;;
  keys)          shift; cmd_keys "$@" ;;
  pause)         cmd_pause ;;
  resume)        cmd_resume ;;
  mode)          shift; cmd_mode "$@" ;;
  url)           cmd_url ;;
  kill-session)  cmd_kill_session ;;
  doctor)        cmd_doctor ;;
  *) sed -n '2,20p' "$0" >&2; exit 1 ;;
esac
