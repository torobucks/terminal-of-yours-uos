---
name: terminal-of-yours
description: >-
  Shared local terminal collaboration between an AI agent and a human user.
  This skill should be used when an agent needs to run or inject commands into a
  local PowerShell terminal that the user can see and operate from their browser
  in real time, or when the user and agent must share one terminal session —
  e.g. collaborative shell work, driving a remote host through ssh over a shared
  PTY, or controlling interactive programs (vim/ssh/less) via key injection.
version: 0.2.0
tags: [terminal, powershell, agent-collaboration, node-pty, local-dev, cli, ssh]
license: MIT
---

# Terminal-of-Yours

用户浏览器（xterm.js）与 agent（ZCode）**协同控制一个本地 PowerShell 终端**：
- 用户在自己的浏览器终端里干活，随时能看到 agent 注入的命令和输出（所见即所得）
- agent 通过 `toy.sh run` 注入命令、`toy.sh keys` 注入按键，与用户共用同一终端
- ssh 是终端里的普通命令：需要操作远端时，在终端里 ssh 即可，之后 run/keys 的注入自然流经 ssh 到达远端
- 会话状态由 agent 的对话历史记忆（终端断了/重建不背状态恢复的包袱）

与 ssh-relay 的关系：**独立 skill**。ssh-relay 继续负责 ZCode 对远端的直接命令通道（`relay.sh run`）；Terminal-of-Yours 提供用户可见、可协同的终端画面。两者命令互不相干。

## 何时使用（agent 触发器）

- 用户想在浏览器里直接操作一个本地 PowerShell 终端，同时让 agent 也能注入命令、看到同一画面
- agent 需要在本地终端执行命令并取回输出与退出码（`toy.sh run`）
- 需要向 vim / ssh / less 等全屏交互程序注入按键（`toy.sh keys`）
- 需要通过共享 PTY 操作远端：在终端里 `ssh` 即可，之后的注入自然流经 ssh
- 出现 `run` 返回 `paused`（用户正在输入）时，按对话流程确认后 `resume` 再重跑
- **不适用**：需要 ZCode 对远端走独立直连通道时，用 ssh-relay，而非本 skill

## 用法

```bash
bash <skill>/scripts/toy.sh {start|status|stop|run|keys|pause|resume|url|kill-session} ...
```

### start / status / stop
- `start`：幂等拉起常驻服务（首次自动 `npm install node-pty`），成功后自动打开浏览器（`TOY_NO_OPEN=1` 可关闭）。实际端口见 `runtime/toy.port`（默认 8787，被占自动 +1）
- `status`：返回 JSON（会话存活、用户锁状态、排队数、端口、shell 等）
- `stop`：停止服务（终端会话随服务停止）

### run —— agent 注入命令并等待完成
```bash
toy.sh run 'git status'                 # 默认超时 120s
toy.sh run 'npm run build' 600          # 指定超时（秒）
```
返回 JSON：
```json
{"status":"done","output":"...","exitCode":0}
```
- `status: done`：命令完成，`exitCode` 为退出码（**仅 native 命令有效**，如 git/node；cmdlet 后为残留值，参考即可）
- `status: timeout`：超过超时未完成，命令仍在终端里继续跑
- `status: paused`：**立即返回**（不阻塞）。用户在浏览器终端输入触发了用户优先锁——命令未执行。**恢复流程**：agent 在对话中向用户确认 → 用户同意后调用 `toy.sh resume`（清锁）→ 重新 run 同一命令
- `status: exited`：终端会话已结束（用户敲了 exit 或 kill-session）
- `output`：从注入时刻起终端输出（**含命令回显**，所见即所得）
- **注意**：页面没有「放行/丢弃」按钮了——恢复与否由 agent 平台（对话）决策，TOY 只报告状态

### keys —— 交互模式按键注入（无哨兵）
```bash
toy.sh keys 'ihello<ESC>:wq<CR>'        # 向 vim 等交互程序注入按键
toy.sh keys '\x03'                      # Ctrl-C（打断卡住的命令）
```
keys 原样写入终端，不带哨兵、不置用户锁。用于 vim/ssh/less 等全屏交互程序。

### mode —— 操作权切换（user ⇄ agent）
- **user 模式（默认）**：用户在浏览器输入时置用户优先锁，agent 的 run 被拦截立即返回 paused
- **agent 模式**：**显式禁止用户输入**（浏览器端 disableStdin），agent 的 run/keys 畅通不被拦截
- 切换方式：
  - 浏览器：点击状态条横幅（「agent 已让位」⇄「🤖 agent 操作中」）一键切换
  - agent 侧：`toy.sh mode user|agent` 查看/切换（`toy.sh mode` 不带参数查看当前模式）
- 新会话默认 user 模式；切到 agent 模式时自动清残留锁

### pause / resume —— 用户优先锁（冲突避免，非审批）
- 用户在浏览器里**任何输入**都会置用户优先锁：之后排队的 run 会被拦截并**立即返回 paused**
- `toy.sh pause`：agent 侧手动置锁（比如发现用户正在终端里操作）
- `toy.sh resume`：清锁。**由 agent 平台调用**——agent 收到 paused 后应在对话中向用户确认，用户同意后调 resume 再重新 run
- 锁是冲突避免（防止 agent 注入拼进用户的半行输入），不是权限审批；已注入的命令无法被锁撤销（锁只拦下一个注入）
- 锁会一直保持直到 resume（没有自动超时释放），agent 每次 run 前若不确定锁状态可先查 `toy.sh status` 的 userActive 字段

### kill-session / 断开连接
- **浏览器「断开连接」按钮 = 终止整个终端会话**（taskkill 进程树杀 PTY，agent 的 run/keys 全部失效）——不是只断页面
- 会话结束后页面按钮变「重建会话」（POST /api/reborn：服务端重启 PTY，无需重启服务）
- `toy.sh kill-session`：agent 侧等价操作
- 关闭浏览器页面 = 会话继续在服务端跑（那是另一回事）

## 使用规则（agent 必读）

1. **勿并发 run**：注入队列串行，但长时间等待会占队。一条命令完成前不要发下一条
2. **命令用 PowerShell 5.1 兼容语法、单行**：本机是 PS 5.1（无 pwsh 7），不支持 `&&`、`??`、三元表达式；多行命令用分号合并成单行（反引号续行在多行注入下不可靠）
3. **不假设 conda 已激活**：profile 默认加载，但环境激活状态未知；需要时显式 `conda activate <env>`（或依赖用户当前环境）
4. **全屏交互程序（vim/ssh/less/htop 类）内禁止 run 注入**：注入的命令会被当按键吞掉或破坏界面。交互程序内用 `keys` 注入按键；要退出用 `keys '\x03'` 或直接注入退出序列
5. **输出含回显**：`output` 是终端流（含命令回显、提示符、ANSI 序列），解析时注意
6. **exit code 语义**：`$LASTEXITCODE` 只在 native 命令后更新；cmdlet（如 `Get-ChildItem`）后是残留值。要拿可靠退出码，用 `cmd /c '...'` 包装
7. **run 被 paused 时**：命令未执行，立即返回。agent 应在对话中向用户确认，用户同意后 `toy.sh resume` 再重新 run 同一命令
8. **会话重建**：kill-session / 服务停止后会话状态丢失——agent 依赖自己的对话历史记忆上下文，重建会话后从当前目录/环境重新确认状态
9. **多标签/输入接管**：浏览器多标签时，任何标签输入都会**自动接管**终端（输入即接管，最后输入的标签获得控制权，其余变只读镜像）；也可用页面「接管输入」按钮显式切换；agent 不受此限制（run/keys 总是可用）
10. **安全**：服务仅绑定 127.0.0.1 且校验 Host/Origin；浏览器页面可执行任意本地命令（等同本地终端），不要暴露端口到局域网

## 架构

```
浏览器 xterm.js ←SSE→ toy.js(node-pty + 静态托管) ←toy.sh→ ZCode
     ↕ POST 按键(用户优先锁)      ↕ 串行注入队列/哨兵
              PowerShell PTY（本地进程）
                ├─ 用户：直接在浏览器终端操作
                └─ ssh：终端里的普通命令（连任意远端）
```

- 哨兵完成检测：注入 `; Write-Output "__TOY_DONE_<token>_$([int]$LASTEXITCODE)__"`，匹配已展开的数字结尾（PSReadLine 回显的 `$([int]...)` 不匹配，天然区分）；`[int]` 保证 cmdlet（$null）也展开为 0
- 回放：浏览器断线重连 → 清屏 + 全量回放缓冲（≤512KB，config 可调）→ 切实时流
- 多标签：首连可输入，后续连接只读镜像（页面可「接管输入」切换活动连接）
