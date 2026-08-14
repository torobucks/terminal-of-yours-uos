<p align="center">
  <img src="assets/icon.svg" alt="Terminal-of-Yours" width="92" height="92">
</p>

<h1 align="center">Terminal-of-Yours (TOY)</h1>

<p align="center">
  A user's browser and an AI agent <b>collaboratively control the same local PowerShell terminal</b> · what you see is what you get
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.2.0-0e639c">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-blue">
  <img alt="language" src="https://img.shields.io/badge/stack-Node%20%2F%20node--pty%20%2F%20xterm.js-green">
  <img alt="shell" src="https://img.shields.io/badge/shell-PowerShell%205.1%20%2F%207-informational">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-yellow">
</p>

<p align="center">
  🇬🇧 English &nbsp;|&nbsp; 🇨🇳 <a href="README.md">中文</a>
</p>

---

You open a terminal in your browser to get work done, and an AI agent can inject commands into, send keystrokes to, and watch the output of that *same* terminal — both of you share the same screen and the same context. Need to operate a remote machine? Just `ssh` inside the terminal, and the agent's injections naturally flow through the SSH session to the remote host.

## Features

- **Shared terminal view** — The user's browser (xterm.js) and the agent (ZCode) share one local PTY; commands and output are what-you-see-is-what-you-get.
- **`toy.sh run` command injection** — The agent injects a command and waits for completion, returning `{status, output, exitCode}`.
- **`toy.sh keys` keystroke injection** — For full-screen interactive programs like vim / ssh / less; writes keystroke sequences verbatim.
- **User-priority lock** — Any input from the user in the browser sets the lock, preventing the agent's injection from being concatenated onto a half-typed line (collision avoidance, not permission approval).
- **Control-mode switch** — One-click switch between `user ⇄ agent` modes: agent mode explicitly blocks user input to keep injections flowing.
- **Serial injection queue** — User keystrokes and agent commands go through the same queue, fixing the concurrency/ordering hard bug.
- **Sentinel completion detection** — The injected token's echo naturally distinguishes PSReadLine echo from real output, reliably determining command completion.
- **Disconnect replay** — On reconnect, auto-clear the screen + full replay of the buffer (default 512KB), then resume the live stream.
- **Zero extra dependencies** — The only npm dependency is `node-pty` (prebuilt, no compilation); HTTP/SSE use native Node, no WebSocket.
- **Local security** — Binds `127.0.0.1` only and validates Host/Origin; the browser page is equivalent to a local terminal.

## Architecture

![TOY Architecture](assets/architecture.svg)

```
browser xterm.js ←SSE→ toy.js (node-pty + static hosting) ←toy.sh→ ZCode
     ↕ POST keystrokes (user-priority lock)      ↕ serial injection queue / sentinel
              PowerShell PTY (local process, conpty)
                ├─ user: operate directly in the browser terminal
                └─ ssh: a normal command inside the terminal (to any remote host)
```

## Installation & Configuration

### Prerequisites

- [ ] **Windows 10/11** (node-pty depends on ConPTY, not supported on Windows 7/8); macOS/Linux are experimental.
- [ ] **Git Bash** (MSYS2 also works; `cmd` / PowerShell cannot run `toy.sh`).
- [ ] **Node.js 18–24** (node-pty 1.1.0 prebuild verified compatible with 18–24; declared in `package.json` `engines`).
- [ ] **PowerShell 5.1** (ships with Windows 10/11, default shell); if pwsh is installed, PowerShell 7 is used automatically.

If unsure about your environment, run `bash scripts/toy.sh doctor` for a self-check first; install once everything is green.

### One-click install (recommended)

```bash
git clone https://github.com/qwerd53/terminal-of-yours.git TerminalOfYours
cd TerminalOfYours
bash scripts/install.sh          # environment self-check + auto npm install node-pty
bash scripts/toy.sh start        # start the service and open the browser automatically
```

- If `install.sh` self-check fails, it gives clear fix hints (e.g. suggests `nvm` to switch to Node 18–24 when the version mismatches).
- On dependency install failure, it suggests two paths: switch Node version for the node-pty prebuild / use a local build chain (python + node-gyp + VS Build Tools).

### Register as an agent skill

`install.sh --link [target dir]` registers in one command (symlink preferred; on Windows, automatically falls back to a copy if symlink fails):

```bash
bash scripts/install.sh --link ~/.claude/skills/terminal-of-yours
```

- The target directory must contain `SKILL.md` (the agent identifies it as a skill directory); the frontmatter needs no modification.
- Common directories: `~/.claude/skills/`, `~/.zcode/skills/`, `~/.agents/skills/` (default `~/.workbuddy/skills/`).
- It also works without registration: just run `bash scripts/toy.sh start` for local use.

### Traditional ways (copy directory / install-free)

The skill's only runtime dependency is `node-pty` (prebuilt, no compilation). Both approaches work:

**Method A — Original repo / first clone (zero manual steps)**

`toy.sh start` is **idempotent**: when it detects `server/node_modules/node-pty` is missing, it **automatically runs `npm install`** — no manual install needed.

**Method B — Copy / copied directory**

After copying the whole `TerminalOfYours/` directory, there are two ways to start:

1. **Let the script install (easiest)**: just run `bash scripts/toy.sh start`; it auto-runs `npm install node-pty` on first launch.
2. **Install manually first (your habit)**:

```bash
cd server && npm install node-pty && cd ..
bash scripts/toy.sh start
```

> Note: `toy.sh` self-locates via `BASH_SOURCE` to the script's directory, **independent of your current cwd** — you can run it from anywhere inside the copy. The only requirement is that `server/`, `scripts/`, and `web/` remain intact in the copy.

### PowerShell 7 support

- Default `shell=auto`: prefers `pwsh` (PS7, including the common install path `C:\Program Files\PowerShell\7\pwsh.exe`), falls back to `powershell.exe` (PS5.1) if not found.
- Explicit override: write `shell=pwsh` or `shell=powershell.exe` in `runtime/config.txt`.
- `toy.sh status` returns `shell` (**the resolved actual shell path**) and `shellVersion` (`5` / `7` / `null` = detection failed).
- Under PS7, `run` supports `&&` / `??` / ternary expressions; PS5.1 still requires single-line semicolon merging — the agent decides syntax rules based on `shellVersion`.

## Quick start

```bash
bash scripts/toy.sh start      # start the service and open the browser automatically (TOY_NO_OPEN=1 to suppress)
bash scripts/toy.sh run 'git status'          # agent injects a command (returns {status,output,exitCode})
bash scripts/toy.sh keys '\x03'               # inject Ctrl-C (interactive mode / break a hang)
bash scripts/toy.sh status                    # query status
bash scripts/toy.sh stop                      # stop the service
```

## Command reference

| Command | Description |
| --- | --- |
| `toy.sh start` | Idempotently launch the resident service (auto `npm install node-pty` on first run), then open the browser automatically (`TOY_NO_OPEN=1` to disable). Port in `runtime/toy.port` (default 8787, auto +1 if occupied) |
| `toy.sh status` | Returns JSON: session alive, user-lock state, queue length, port, shell, etc. |
| `toy.sh stop` | Stop the service (the terminal session stops with it) |
| `toy.sh run '<command>' [timeout sec]` | Agent injects a command and waits for completion; default timeout 120s; returns `{status,output,exitCode}` |
| `toy.sh keys '<keystroke sequence>'` | Interactive-mode keystroke injection (no sentinel), for vim/ssh/less, etc.; supports `\x03 \e \r \n \t` escapes |
| `toy.sh mode [user\|agent]` | View or switch control mode; `agent` mode blocks user input to keep injections flowing |
| `toy.sh pause` | Agent-side manual user-priority lock (when it detects the user is operating) |
| `toy.sh resume` | Clear the lock. Called by the agent platform: after receiving `paused` and confirming with the user → `resume` then re-run the same command |
| `toy.sh url` | Print the browser address |
| `toy.sh kill-session` | Destroy the current terminal session (process tree); all of the agent's run/keys become invalid |
| `toy.sh doctor` | Environment self-check (bash/node/shell/dependencies), reuses `install.sh --check-only` |

### `run` return status codes

| status | Meaning |
| --- | --- |
| `done` | Command completed, `exitCode` is the exit code (only reliable for native commands; leftover value after cmdlets) |
| `timeout` | Exceeded timeout but not finished; the command keeps running inside the terminal |
| `paused` | **Returns immediately**, not executed. The user's input in the browser triggered the user-priority lock — after confirmation, `resume` then re-run |
| `exited` | The terminal session has ended (user typed exit or kill-session) |

> The page **no longer has "allow/discard" buttons** — whether to resume is decided by the agent platform (the conversation); TOY only reports the `paused` status.

## Usage rules (agent must-read)

1. **No concurrent run** — The injection queue is serial; do not send the next command before the previous one finishes.
2. **Choose syntax by shellVersion** — Before `run`, check `shellVersion` from `toy.sh status`: `7` allows `&&`/`??`/ternary; `5` or `null` still needs 5.1-compatible single-line semicolon merging (no `&&`, `??`, ternary; merge multiple lines into one with semicolons).
3. **Don't assume conda is activated** — Explicitly `conda activate <env>` when needed.
4. **No run injection inside full-screen interactive programs** — Use `keys` for injection; exit with `keys '\x03'` or an exit sequence.
5. **Output includes echo** — `output` is the terminal stream (including command echo, prompt, ANSI sequences); be careful when parsing.
6. **Exit code semantics** — `$LASTEXITCODE` only updates after native commands; wrap with `cmd /c '...'` for reliable exit codes.
7. **When run is paused** — The command was not executed and returns immediately; confirm with the user in the conversation, then `resume` and re-run after approval.
8. **Session rebuild** — After kill-session / service stop, session state is lost; the agent relies on its own conversation history to re-confirm state.
9. **Multi-tab takeover** — Any tab's input auto-takes over (other tabs become read-only mirror); the agent's run/keys are always available.
10. **Security** — Binds `127.0.0.1` only and validates Host/Origin; the page can execute arbitrary local commands, do not expose it to the LAN.

## Directory

```
├── SKILL.md          # agent protocol doc (includes frontmatter metadata)
├── README.md         # this file (Chinese)
├── README.en.md      # English version
├── assets/           # icon.svg / architecture.svg self-contained vector graphics
├── scripts/toy.sh    # management commands
├── scripts/install.sh# one-click install / environment self-check (--check-only reused by toy.sh doctor)
├── server/           # toy.js resident service (node-pty as the only dependency)
├── web/              # index.html + app.js + vendor/ (@xterm/xterm localized)
└── runtime/          # config.txt (see config.example.txt) / toy.pid / toy.port / toy.log (10MB×3 rotation, desensitized)
```

## Boundaries & known limitations (phase 1)

- **Single user, single agent** — Among multiple browser tabs, only the first connection can input; no authentication (only `127.0.0.1` + Host/Origin validation).
- **PowerShell 5.1 or 7** — Default `shell=auto` prefers `pwsh` (PS7) and falls back to 5.1; injection syntax is judged by `status.shellVersion` (5.1: single-line semicolon; 7: `&&`/`??`/ternary allowed). Exit code is only reliable for native commands.
- **No run injection inside interactive programs** — Use `keys` for vim/ssh/less.
- **Not persistent across restarts** — After machine reboot / stop, the session is lost (the agent's conversation history backs it up); `start` auto-rebuilds after kill-session.
- **Output includes echo and ANSI sequences** — `output` is the terminal stream; be careful when parsing.

## Design process

This skill was implemented after a grilling design tree (20+ decisions) + sub-agent technical review (13 fixes). Key pitfalls recorded:

- `$LASTEXITCODE__` variable-swallowing bug (underscore belongs to the variable name) → braces + `[int]` coercion.
- node-pty PTY resize crash after exit under Node 22 → all wrapped in try/catch.
- PSReadLine half-line input concatenated with injection → prepend `\x03` to clear the line on injection.
- Windows browser auto-open → `cmd //c start "" "URL"`.

---

<p align="center">
  <sub>Terminal-of-Yours · let the agent and the user share one real terminal · MIT License</sub>
</p>
