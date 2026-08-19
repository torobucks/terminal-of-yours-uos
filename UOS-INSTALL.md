# Terminal-of-Yours · UOS v20（统信UOS）安装说明

在 UOS v20 桌面版上原生运行，终端使用系统默认 shell（bash）。本项目已移植支持 Linux，无需 Windows/ConPTY。

---

## 0. 快速安装（一条命令）

以下两条命令即可安装并启动：

```bash
git clone https://github.com/torobucks/terminal-of-yours-uos.git TerminalOfYours
cd TerminalOfYours
bash scripts/install.sh     # 环境自检 + 自动安装依赖（node-pty）
bash scripts/toy.sh start    # 启动服务并自动打开浏览器
```

启动成功后浏览器会自动打开 `http://127.0.0.1:8787`，就是你的终端。

> 若浏览器没自动打开，手动访问上面的地址即可（TOY 也支持 `TOY_NO_OPEN=1` 关闭自动打开）。

---

## 1. 环境准备（UOS v20 缺一不可）

| 依赖 | 版本 | 检查命令 |
| --- | --- | --- |
| Git | 任意 | `git --version` |
| Node.js | **18–24** | `node -v` |
| npm | 随 Node | `npm -v` |
| bash | 系统自带 | `bash --version` |
| 编译链 | （仅当 node-pty 无 prebuild 时需要） | `gcc --version` |

先跑环境自检，看缺什么：

```bash
bash scripts/toy.sh doctor
```

### 1.1 安装 Git

UOS 应用商店可装 git，或命令行：

```bash
sudo apt-get update
sudo apt-get install -y git curl
```

### 1.2 安装 Node.js 18–24（重点）

UOS apt 源里的 Node 版本太老（不满足 18–24），**建议用 nvm 安装**：

```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc

# 安装并使用 Node 20（18–24 内都行）
nvm install 20
nvm use 20
nvm alias default 20
```

验证：

```bash
node -v   # 应显示 v18~v24
npm -v
```

> 若网络受限拉不动 nvm，可改用 apt 装较新的 Node：
> ```bash
> curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
> sudo apt-get install -y nodejs
> ```
> 或直接：`sudo apt-get install -y nodejs npm`（版本可能不满足，需 doctor 确认）。

### 1.3 确保 bash 可用（UOS 自带，一般无需操作）

```bash
echo $SHELL    # 期望 /bin/bash（或 /bin/zsh 等，均为原生 POSIX shell）
```

---

## 2. 目录与依赖说明

```
TerminalOfYours/
├── server/toy.js         # 常驻服务（node-pty + Node 原生 http，唯一 npm 依赖就是 node-pty）
├── scripts/toy.sh        # 管理命令（bash）
├── scripts/install.sh    # 安装 / 自检
├── web/                  # 浏览器终端前端（xterm.js，已本地化，无需联网）
└── runtime/              # 运行时：config.txt / toy.pid / toy.port / toy.log
```

安装依赖（install.sh 已自动做，手动亦可）：

```bash
cd server
npm install --no-audit --no-fund   # 首次会下载/编译 node-pty
cd ..
```

> **若 node-pty 安装失败**（无匹配 prebuild）需要本地编译链：
> ```bash
> sudo apt-get install -y build-essential python3
> cd server && rm -rf node_modules && npm install
> ```

---

## 3. 常用命令

| 命令 | 说明 |
| --- | --- |
| `bash scripts/toy.sh start` | 启动服务并打开浏览器（幂等） |
| `bash scripts/toy.sh status` | 查看状态（JSON：会话、端口、shell、`kind`、`shellVersion`） |
| `bash scripts/toy.sh stop` | 停止服务 |
| `bash scripts/toy.sh url` | 打印浏览器地址 |
| `bash scripts/toy.sh doctor` | 环境自检 |
| `bash scripts/toy.sh run '命令'` | agent 注入命令并等完成，返回 `{status,output,exitCode}` |
| `bash scripts/toy.sh keys '\x03'` | 注入按键（vim/ssh/less 内用，如 Ctrl-C） |
| `bash scripts/toy.sh kill-session` | 终止当前终端会话 |

---

## 4. UOS 上验证清单（照做即可）

```bash
# 1) 自检
bash scripts/toy.sh doctor

# 2) 启动
bash scripts/toy.sh start
#    浏览器自动打开 http://127.0.0.1:8787，看到 bash 提示符即成功

# 3) 在浏览器终端里手敲一条命令
ls ~

# 4) agent 角度：注入命令并取回输出/退出码
bash scripts/toy.sh run 'uname -a'
#    期望返回 {"status":"done","output":"Linux ...","exitCode":0}

# 5) 确认 shell 判定
bash scripts/toy.sh status
#    期望包含 "kind":"posix" 和 "shell":"/bin/bash"（或你的 $SHELL）

# 6) 全屏程序按键注入验证（可选）
bash scripts/toy.sh run 'htop'    # 应返回 timeout（全屏程序内不要 run）
bash scripts/toy.sh keys '\x03'   # 注入 Ctrl-C 退出 htop

# 7) 停止
bash scripts/toy.sh stop
```

**通过标准**：浏览器能看到 bash 终端、命令输出所见即所得、`run` 能返回 `done+exitCode:0`、`status.kind` 为 `posix`。

---

## 5. 常见问题

**Q：`toy.sh start` 打不开浏览器？**
手动访问 `http://127.0.0.1:8787`；或先 `sudo apt-get install -y xdg-utils` 再试。

**Q：`status.kind` 不是 posix？**
检查 `$SHELL` 与 `bash scripts/toy.sh status` 的 `shell` 字段；默认在 Linux 下会解析为你的登录 shell（通常 `/bin/bash`）。

**Q：想改用 zsh / 指定 shell？**
编辑 `runtime/config.txt`（无则复制 `runtime/config.example.txt`），写 `shell=/usr/bin/zsh`，重启。

**Q：node-pty 装不上？**
见 1.3，装 `build-essential python3` 后重装。

**Q：端口被占？**
默认 8787，被占自动 +1；实际端口看 `runtime/toy.port`，或 `bash scripts/toy.sh url`。

---

## 6. 架构速览

```
浏览器 xterm.js ←SSE→ toy.js(node-pty) ←toy.sh→ AI agent
     ↕ POST 按键(用户优先锁)      ↕ 串行注入队列/哨兵
              bash/zsh PTY（UOS 本地进程）
                ├─ 用户：浏览器终端直接操作
                └─ ssh：终端里的普通命令（连任意远端）
```

- 用户与 AI agent 协同控制**同一个**本地 bash 终端，所见即所得。
- 哨兵完成检测：bash 注入 `echo "__TOY_DONE_<token>_$?__"`，按 `kind`（posix）生成。
- 仅绑定 `127.0.0.1` 并校验 Host/Origin，本地安全；勿暴露端口到局域网。
