#!/usr/bin/env bash
# install.sh — Terminal-of-Yours 一键安装 / 环境自检（doctor）
#
# 用法:
#   install.sh                  自检 + 安装依赖 + 注册指引
#   install.sh --check-only     仅自检（doctor 模式；全绿退出 0，否则非零）
#   install.sh --link [目录]     自检 + 安装 + 注册到 skills 目录
#                               默认 ~/.workbuddy/skills/terminal-of-yours
#                               可用参数覆盖，如 ~/.claude/skills/terminal-of-yours
#   install.sh --help           帮助
#
# 退出码: 0 = 自检通过（check 模式）或安装成功；1 = 自检失败 / 安装失败

set -uo pipefail

# 自定位：不依赖调用方 cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER="$ROOT/server"
RUNTIME="$ROOT/runtime"

# ---------- 输出 ----------
GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
ok()   { printf "${GREEN}[OK]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[!!]${NC} %s\n" "$*"; }
fail() { printf "${RED}[XX]${NC} %s\n" "$*"; }

usage() {
  sed -n '2,10p' "$0"
}

# ---------- 环境自检（doctor 核心） ----------
check_env() {
  local FAILED=0
  echo "── Terminal-of-Yours 环境自检 ─────────────────"
  echo "  安装目录: $ROOT"

  # OS 探测（Git Bash / MSYS / Cygwin 视为 windows-gitbash）
  local OS=unknown
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) OS=windows-gitbash ;;
    Darwin*) OS=macos ;;
    Linux*) OS=linux ;;
  esac
  ok "OS: $OS ($(uname -s))"

  # bash
  command -v bash >/dev/null 2>&1 && ok "bash 可用" || { fail "未找到 bash（本脚本本身需 bash 运行）"; FAILED=1; }

  # node（要求 >=18 <25，node-pty 1.1.0 prebuild 已实测兼容 Node 18–24）
  if command -v node >/dev/null 2>&1; then
    local node_ver node_major
    node_ver="$(node -v | sed 's/^v//')"
    node_major="${node_ver%%.*}"
    if (( node_major >= 18 && node_major < 25 )); then
      ok "Node $node_ver (v$node_major，支持范围)"
    else
      fail "Node $node_ver 不在支持范围 (>=18 <25)；node-pty prebuild 可能缺失。建议用 nvm 切换 Node 版本"
      FAILED=1
    fi
  else
    fail "未找到 node。请安装 Node.js 18-24 (https://nodejs.org)"
    FAILED=1
  fi

  # npm
  if command -v npm >/dev/null 2>&1; then
    ok "npm $(npm -v 2>/dev/null || echo '?')"
  else
    fail "未找到 npm（随 Node 安装）"
    FAILED=1
  fi

  # 终端 shell：Windows 用 PowerShell（pwsh PS7 优先，回退 PS5.1）；
  # Linux/macOS 原生用 POSIX shell（$SHELL 或 bash 优先），可选 pwsh
  if [[ "$OS" == "windows-gitbash" ]]; then
    if command -v pwsh >/dev/null 2>&1 || [[ -f "/c/Program Files/PowerShell/7/pwsh.exe" ]]; then
      ok "pwsh (PowerShell 7) 可用 — 将作为默认 shell"
    else
      ok "未装 pwsh，回退 powershell.exe (PowerShell 5.1，Windows 10/11 自带)"
    fi
  else
    if command -v bash >/dev/null 2>&1; then
      ok "bash 可用（原生 Linux 终端默认 shell${SHELL:+，$SHELL}）"
    else
      warn "未找到 bash（POSIX shell 缺失？将尝试 /bin/sh）"
    fi
    if command -v pwsh >/dev/null 2>&1; then
      ok "pwsh (PowerShell 7) 可用 — 可通过 config.txt 显式 shell=pwsh 切换"
    fi
  fi

  # node-pty 依赖
  if [[ -d "$SERVER/node_modules/node-pty" ]]; then
    ok "node-pty 已安装"
  else
    warn "node-pty 未安装（install 或首次 start 会自动安装）"
  fi

  # 运行状态提示
  if [[ -f "$RUNTIME/toy.port" ]]; then
    warn "检测到 runtime/toy.port — 服务可能已在运行，先 toy.sh stop 再操作"
  fi

  echo "──────────────────────────────────────────────"
  return $FAILED
}

# ---------- 依赖安装 ----------
install_deps() {
  if [[ -d "$SERVER/node_modules/node-pty" ]]; then
    ok "node-pty 已安装，跳过 npm install"
    return 0
  fi
  echo "安装依赖 (npm install --no-audit --no-fund)..."
  if (cd "$SERVER" && npm install --no-audit --no-fund); then
    ok "依赖安装完成"
    return 0
  else
    fail "npm install 失败。可能原因与解决："
    echo "    - node-pty prebuild 与当前 Node/平台 不匹配 → 用 nvm 切换 Node 18-24 再试"
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*) echo "    - 本地编译链缺失（需 python + node-gyp + VS Build Tools）→ 优先升级/换 Node 版本" ;;
      *)                    echo "    - 本地编译链缺失（需 make + gcc/g++ + python3）→ 在 UOS 上：sudo apt-get install -y build-essential python3" ;;
    esac
    return 1
  fi
}

# ---------- skill 注册（软链优先，失败 fallback 拷贝） ----------
do_link() {
  local dest="${1:-$HOME/.workbuddy/skills/terminal-of-yours}"
  mkdir -p "$(dirname "$dest")"
  if [[ -e "$dest" ]]; then
    warn "目标已存在: $dest（跳过注册；如需重装先删除）"
    return 0
  fi
  # 软链优先；MSYS 下 ln -s 可能静默降级为整目录拷贝，必须校验真实软链
  if ln -s "$ROOT" "$dest" 2>/dev/null && [[ -L "$dest" ]]; then
    ok "已软链注册: $dest -> $ROOT"
  else
    # ln 失败（或假软链）：清掉残留，改用拷贝
    rm -rf "$dest" 2>/dev/null || true
    echo "软链失败（Windows 权限常见），改用拷贝（排除 node_modules/runtime/.git/.workbuddy）..."
    if mkdir -p "$dest" && \
       tar -C "$ROOT" \
           --exclude='node_modules' --exclude='runtime' --exclude='.git' --exclude='.workbuddy' \
           -cf - . 2>/dev/null \
         | tar -C "$dest" -xf - 2>/dev/null; then
      # 补回示例配置（runtime 整体被排除，但 config.example.txt 应随注册带上）
      mkdir -p "$dest/runtime"
      cp "$ROOT/runtime/config.example.txt" "$dest/runtime/config.example.txt" 2>/dev/null || true
      ok "已拷贝注册: $dest（首次 start 会自动装依赖）"
    else
      rm -rf "$dest"
      fail "拷贝失败，请手动拷贝整个目录到 $dest"
      return 1
    fi
  fi
  # 最终校验：注册目标必须含 SKILL.md
  if [[ -f "$dest/SKILL.md" ]]; then
    echo "  注册确认：$dest/SKILL.md 就位（agent 按 skill 目录识别）；frontmatter 无需修改"
  else
    fail "注册校验失败：$dest 下未找到 SKILL.md"
    return 1
  fi
}

# ---------- 注册指引 ----------
print_register() {
  echo ""
  echo "下一步（注册到 agent 的 skills 目录）："
  echo "  方式 1（推荐）: bash scripts/install.sh --link [目标目录]"
  echo "    常见目标：~/.claude/skills/terminal-of-yours"
  echo "              ~/.zcode/skills/terminal-of-yours"
  echo "              ~/.agents/skills/terminal-of-yours"
  echo "  方式 2（手动）: 把整个 TerminalOfYours 目录放到上述任一目录下"
  echo "  方式 3（本机试用）: 直接 bash scripts/toy.sh start"
}

# ---------- 参数解析 ----------
mode=install
link_dest=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) mode=check ;;
    --link) mode=link ;;
    --help|-h) usage; exit 0 ;;
    *)
      if [[ "$mode" == "link" ]]; then link_dest="$1"; else usage; exit 1; fi
      ;;
  esac
  shift
done

case "$mode" in
  check)
    check_env
    rc=$?
    if [[ $rc -eq 0 ]]; then echo "环境就绪 ✓"; else echo "自检未通过，请按上方提示修复后重试"; fi
    exit $rc
    ;;
  install)
    check_env || exit $?
    install_deps || exit 1
    print_register
    ;;
  link)
    check_env || exit $?
    install_deps || exit 1
    do_link "$link_dest"
    ;;
esac
