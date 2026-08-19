#!/usr/bin/env node
/**
 * toy.js — Terminal-of-Yours 常驻服务
 * 用户浏览器 (xterm.js) 与 agent (ZCode) 协同控制一个本地 PowerShell 终端。
 *
 * 架构：node-pty (conpty) + Node 原生 http（零 WS 依赖，SSE 推输出、POST 收输入）
 *   GET  /                  静态页面 (web/)
 *   GET  /stream            SSE 输出流（首连为活动连接可输入，其余只读镜像）
 *   POST /input             用户按键（仅活动连接；置用户优先锁）
 *   POST /api/run           agent 命令注入（串行队列 + 哨兵完成检测；用户锁置位时立即返回 paused，恢复决策由 agent 平台控制）
 *   POST /api/keys          交互模式按键注入（无哨兵，如 vim/ssh 内的按键）
 *   POST /api/pause         手动暂停（agent 侧，等价于置用户优先锁）
 *   POST /api/resume        agent 平台清锁（恢复由 agent 与用户对话确认后决定）
 *   POST /api/takeover      只读镜像连接 → 接管为活动连接（可输入）
 *   POST /api/resize        终端尺寸同步（xterm fit 后防抖上报）
 *   GET  /api/status        状态查询
 *   POST /api/kill-session  销毁会话（taskkill /F /T 进程树）
 *
 * 安全：仅绑定 127.0.0.1；所有请求校验 Host 头（防 DNS rebinding）；
 *       POST 校验 Origin（浏览器）或 X-TOY 自定义头（curl 等非浏览器客户端）。
 *
 * 哨兵完成检测：注入 `; Write-Output "__TOY_DONE_<token>_$([int]$LASTEXITCODE)__"`
 *   关键：PSReadLine 回显的是**未展开**的原始文本（`$([int]$LASTEXITCODE)`），而
 *   Write-Output 输出的是**已展开**的数字——因此正则只匹配数字结尾的
 *   输出哨兵，天然区分回显与执行完成，无需延迟确认。
 *   `[int]$LASTEXITCODE` 保证 cmdlet（$null）也展开为 0，哨兵总有数字。
 */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, spawnSync } = require('child_process');
const os = require('os');
const pty = require('node-pty');

const ROOT = process.env.TOY_DIR || path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const WEB = path.join(ROOT, 'web');
const LOG_FILE = path.join(RUNTIME, 'toy.log');
const CONFIG_FILE = path.join(RUNTIME, 'config.txt');
const LOG_MAX = 10 * 1024 * 1024;        // 10MB × 3 轮转
const MAX_RUN_OUTPUT = 10 * 1024 * 1024; // 单 run 输出收集上限
const MAX_REPLAY_EVENT = 16 * 1024;      // 回放事件单块上限（防 xterm 一次大 write 卡 UI）

// ---------- 配置（runtime/config.txt） ----------
function loadConfig() {
  const cfg = { port: 8787, shell: 'auto', buffer: 512 * 1024, runTimeout: 120, noProfile: false };
  try {
    for (const raw of fs.readFileSync(CONFIG_FILE, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k === 'port') cfg.port = parseInt(v, 10) || 8787;
      else if (k === 'shell') cfg.shell = v;
      else if (k === 'buffer') cfg.buffer = parseInt(v, 10) || 512 * 1024;
      else if (k === 'runTimeout') cfg.runTimeout = parseInt(v, 10) || 120;
      else if (k === 'noProfile') cfg.noProfile = v === '1' || v === 'true';
    }
  } catch (e) { /* 缺配置用默认 */ }
  return cfg;
}
const config = loadConfig();

// ---------- shell 解析（config.shell 支持 auto） ----------
// auto（默认）：Windows 优先 pwsh（PS7），回退 powershell.exe（PS5.1）；
// Linux/macOS 优先用户默认登录 shell（$SHELL），其次 bash → zsh → sh（原生 Linux 终端）。
// 显式 shell= 时直接用。
function resolveShell() {
  if (config.shell !== 'auto') return config.shell;
  if (process.platform === 'win32') {
    const r = spawnSync('where', ['pwsh'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout) return r.stdout.split(/\r?\n/)[0].trim() || 'pwsh';
    for (const c of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\PowerShell\\6\\pwsh.exe']) {
      if (fs.existsSync(c)) return c;
    }
    return 'powershell.exe';
  }
  // 非 Windows（Linux/macOS）：优先用户默认登录 shell，保证最「原生」
  const defaultShell = process.env.SHELL;
  if (defaultShell && fs.existsSync(defaultShell)) return defaultShell;
  for (const c of ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/bin/fish', '/usr/bin/fish', '/bin/sh']) {
    if (fs.existsSync(c)) return c;
  }
  // 兜底：由 POSIX sh 探测命令路径
  const r = spawnSync('/bin/sh', ['-c', 'command -v bash || command -v zsh || command -v sh || echo /bin/sh'], { encoding: 'utf8', timeout: 5000 });
  if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  return '/bin/sh';
}

// shell 类型判定：powershell（含 pwsh）或 posix（bash/sh/zsh/fish 等）。
// 决定启动参数、注入哨兵语法与进程树 kill 方式。
function shellKind(shell) {
  const name = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (/powershell|pwsh/.test(name)) return 'powershell';
  return 'posix'; // 非 Windows 目标（UOS/Linux）默认按 POSIX shell 处理
}
const SHELL = resolveShell();
const KINDS = shellKind(SHELL);

// ---------- shell 版本探测 ----------
// 取主版本号（如 PowerShell 5/7、bash 5、zsh 5）存入状态；失败返回 null——
// agent 拿到 null 应保守处理。POSIX shell 各自用内置版本变量捞主版本号。
function posixVersionCmd(shell) {
  const name = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (name === 'bash') return 'echo "${BASH_VERSION%%[.-]*}"';
  if (name === 'zsh') return 'echo "${ZSH_VERSION%%[.-]*}"';
  if (name === 'fish') return 'echo "${FISH_VERSION%%[.-]*}"';
  return 'echo 1'; // POSIX sh / dash / 其他：无统一版本号，保守返回 1
}

function detectShellVersion(shell) {
  const args = KINDS === 'powershell'
    ? ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']
    : ['-c', posixVersionCmd(shell)];
  try {
    const r = spawnSync(shell, args, { encoding: 'utf8', timeout: 8000 });
    if (r.error || r.status !== 0) return null;
    const m = (r.stdout || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null; // m[0]=匹配串；无捕获组，m[1] 是 undefined
  } catch (e) { return null; }
}
const SHELL_VERSION = detectShellVersion(SHELL);

// ---------- 日志（轮转 + 脱敏：不记命令体明文） ----------
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX) {
        try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (e) { /* ignore */ }
        try {
          if (fs.statSync(LOG_FILE + '.1').size > LOG_MAX) {
            fs.renameSync(LOG_FILE + '.1', LOG_FILE + '.2');
          }
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* 无日志文件 */ }
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) { /* 日志失败不致命 */ }
  if (process.env.TOY_DEBUG) console.log(line.trim());
}

// ---------- 会话状态 ----------
const state = {
  pty: null,
  sessionAlive: false,
  userActive: false,       // 用户优先锁
  controlMode: 'user',     // 'user' | 'agent'：终端操作权（页面横幅点击切换）
  queue: [],               // run 请求队列（串行注入）
  current: null,           // 正在执行（已注入、等哨兵）的 run
  clients: new Map(),      // clientId -> res（SSE 连接）
  activeClientId: null,    // 唯一可输入的活动连接
  replay: [],              // 环形回放缓冲（事件数组，按完整事件裁剪）
  replayBytes: 0,
  seq: 0,
  killInFlight: false,
};

// ---------- 回放缓冲 ----------
function replayPush(data) {
  const size = Buffer.byteLength(data, 'utf8');
  // 合并相邻小块成 ≤16KB 事件，减少回放事件数
  const last = state.replay[state.replay.length - 1];
  if (last && last.size + size <= MAX_REPLAY_EVENT) {
    last.data += data;
    last.size += size;
  } else {
    state.replay.push({ data, size });
  }
  state.replayBytes += size;
  while (state.replayBytes > config.buffer && state.replay.length > 1) {
    const old = state.replay.shift();
    state.replayBytes -= old.size;
  }
}

// ---------- SSE 广播 ----------
function sseSend(res, event, obj) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
}
function broadcast(event, obj) {
  for (const res of state.clients.values()) sseSend(res, event, obj);
}
function heartbeat() {
  for (const res of state.clients.values()) res.write(': keepalive\n\n');
}

// ---------- PTY ----------
// 按 shell 类型生成启动参数：
//   PowerShell 传 -NoLogo/-NoProfile；POSIX 无需参数（node-pty 以前台交互方式分配 PTY）
function shellArgsOf() {
  if (KINDS === 'powershell') {
    const args = ['-NoLogo'];
    if (config.noProfile) args.push('-NoProfile');
    return args;
  }
  return [];
}

function startSession() {
  const p = pty.spawn(SHELL, shellArgsOf(), {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: oshomedir(),
    env: process.env,
  });
  state.pty = p;
  state.sessionAlive = true;
  state.userActive = false;
  state.controlMode = 'user'; // 新会话默认用户模式
  state.queue = [];
  state.current = null;
  state.replay = [];       // 新会话从空白开始，清掉旧会话回放
  state.replayBytes = 0;
  log('session started', `pid=${p.pid} shell=${SHELL} v=${SHELL_VERSION}`);

  p.onData((data) => {
    replayPush(data);
    broadcast('out', { d: Buffer.from(data, 'utf8').toString('base64') });
    const run = state.current;
    if (run) {
      run.outputBuf += data;
      if (run.outputBuf.length > MAX_RUN_OUTPUT) {
        run.outputBuf = run.outputBuf.slice(-MAX_RUN_OUTPUT);
      }
      // 哨兵匹配（只匹配已展开的数字结尾，回显的 $([int]...) 不匹配）
      const re = new RegExp(`__TOY_DONE_${run.token}_(\\d+)__`);
      const m = run.outputBuf.match(re);
      if (m) {
        const idx = m.index;
        run.output = run.outputBuf.slice(0, idx).replace(/[\r\n]+$/, '');
        run.exitCode = parseInt(m[1], 10);
        finishRun(run, 'done');
      }
    }
  });

  p.onExit(({ exitCode }) => {
    log('session exited', `code=${exitCode}`);
    state.sessionAlive = false;
    state.pty = null;
    // 所有未完成的 run 返回 exited
    if (state.current) finishRun(state.current, 'exited');
    for (const r of state.queue.splice(0)) r.resolve({ status: 'exited', output: '' });
    broadcast('exit', { code: exitCode });
    broadcast('state', stateEvent());
  });
}

function oshomedir() { return process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'; }

// ---------- run 生命周期 ----------
function previewOf(cmd) {
  const c = cmd.replace(/\s+/g, ' ').trim();
  return c.length > 60 ? c.slice(0, 60) + '…' : c;
}

function injectRun(run) {
  // 前置 \x03 清当前编辑行（防 PSReadLine / readline 拼接半行输入），再注入命令 + 哨兵
  // 哨兵按 shell 类型生成：
  //   powershell — Write-Output "..._$([int]$LASTEXITCODE)"：cmdlet 不更新
  //     $LASTEXITCODE（首次为 $null），[int]$null → 0，保证总有数字（native 命令携带真实退出码）
  //   posix      — echo "..._$?"：执行前 $? 即上一条命令的退出码（true/false 也展开为 0/1）
  // 关键：readline/PSReadLine 回显的是**未展开**的原始文本（`$([int]$LASTEXITCODE)` / `$?`），
  // 而 echo/Write-Output 输出的是已展开的数字——正则只匹配数字结尾，天然区分回显与真实输出。
  const isPs = KINDS === 'powershell';
  const sentinel = isPs
    ? `Write-Output "__TOY_DONE_${run.token}_$([int]$LASTEXITCODE)__"`
    : `echo "__TOY_DONE_${run.token}_$?__"`;
  const cmd = run.cmd.replace(/\r?\n/g, isPs ? '\r\n' : '\n');
  state.pty.write(`\x03${cmd}; ${sentinel}\r`);
  state.current = run;
  run.outputBuf = '';
  log('run start', `id=${run.id} len=${run.cmd.length} shell=${KINDS}`);
}

function finishRun(run, status) {
  if (state.current === run) state.current = null;
  clearTimeout(run.timer);
  log('run done', `id=${run.id} status=${status} exitCode=${run.exitCode}`);
  run.resolve({
    status,
    output: run.output !== undefined ? run.output : (run.outputBuf || ''),
    exitCode: status === 'done' ? run.exitCode : null,
  });
  pump();
}

function pump() {
  if (state.current || !state.sessionAlive) return;
  const run = state.queue.shift();
  if (!run) return;
  // agent 模式下不拦截（操作权显式交给 agent）；用户模式且锁置位时立即返回 paused
  if (state.userActive && state.controlMode === 'user') {
    // 用户优先锁：立即返回 paused，恢复决策交给 agent 平台
    // （agent 在对话中向用户确认后 toy.sh resume 清锁，再重新 run）
    broadcast('state', stateEvent()); // 先 state（横幅"你正在输入"），再 paused（带 preview 覆盖）
    broadcast('paused', { runId: run.id, preview: previewOf(run.cmd) });
    log('run paused', `id=${run.id} awaiting user (agent platform decides)`);
    run.resolve({ status: 'paused', preview: previewOf(run.cmd), output: '' });
  } else {
    injectRun(run);
    run.timer = setTimeout(() => {
      if (state.current === run) {
        state.current = null;
        log('run timeout', `id=${run.id}`);
        run.resolve({ status: 'timeout', output: run.outputBuf || '', exitCode: null });
        pump();
      }
    }, run.timeoutMs);
  }
}

function enqueueRun(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const run = {
      id: ++state.seq,
      cmd,
      token: crypto.randomBytes(8).toString('hex'),
      timeoutMs,
      resolve,
      outputBuf: '',
      output: undefined,
      exitCode: null,
      timer: null,
    };
    state.queue.push(run);
    pump();
  });
}

// ---------- 用户优先锁 ----------
function setUserActive(on) {
  state.userActive = on;
  broadcast('state', stateEvent());
}
function stateEvent() {
  return {
    sessionAlive: state.sessionAlive,
    userActive: state.userActive,
    controlMode: state.controlMode,
    queue: state.queue.length + (state.current ? 1 : 0),
    activeClientId: state.activeClientId,
  };
}

function handleMode(req, res, body) {
  // 操作权切换：user（用户优先，输入即让 agent 暂停）| agent（禁止用户输入，agent 畅通）
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch (e) { /* ignore */ }
  const mode = payload.mode === 'agent' ? 'agent' : 'user';
  state.controlMode = mode;
  if (mode === 'agent') state.userActive = false; // agent 模式畅通，清残留锁
  broadcast('state', stateEvent());
  log('control mode', mode);
  sendJson(res, 200, { ok: true, mode });
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(WEB, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store', // 页面/脚本实时更新，禁缓存
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  if (!hostOk(req)) { res.writeHead(403); res.end('bad host'); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api') && p !== '/stream') {
      return serveStatic(req, res, p);
    }
    if (req.method === 'GET' && p === '/stream') return handleStream(req, res);
    if (req.method === 'GET' && p === '/api/status') return sendJson(res, 200, {
      ...stateEvent(),
      pid: process.pid,
      port: state.actualPort || config.port, // 实际监听端口（非配置端口）
      shell: SHELL,               // 解析后的实际 shell（含路径），非配置值 auto
      shellVersion: SHELL_VERSION, // PowerShell 5/7 | posix 主版本 | null（探测失败）
      kind: KINDS,                // 'powershell' | 'posix' —— agent 据此选哨兵/语法
      replayBytes: state.replayBytes,
      clientCount: state.clients.size,
      version: '0.3.0',
    });

    if (req.method === 'POST') {
      if (!originOk(req)) { res.writeHead(403); res.end('origin rejected'); return; }
      const body = await readBody(req, 1024 * 1024);

      if (p === '/input') return handleInput(req, res, body);
      if (p === '/api/run' || p === '/api/keys') return handleRun(req, res, body, p === '/api/keys');
      if (p === '/api/pause') { setUserActive(true); return sendJson(res, 200, { ok: true }); }
      if (p === '/api/resume') return handleResume(req, res);
      if (p === '/api/mode') return handleMode(req, res, body);
      if (p === '/api/takeover') return handleTakeover(req, res);
      if (p === '/api/resize') return handleResize(req, res, body);
      if (p === '/api/kill-session') return handleKill(req, res);
      if (p === '/api/reborn') return handleReborn(req, res);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    log('http error', e.message);
    res.writeHead(500); res.end(e.message);
  }
});

function handleStream(req, res) {
  if (!state.sessionAlive) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_dead' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const clientId = crypto.randomBytes(8).toString('hex');
  const isActive = state.activeClientId === null;
  if (isActive) state.activeClientId = clientId;
  state.clients.set(clientId, res);
  log('client attach', `id=${clientId} active=${isActive}`);

  sseSend(res, 'hello', { clientId, active: isActive });
  // 回放：先清屏信号 + 全量缓冲（分块），再切实时流
  sseSend(res, 'replay_start', {});
  for (const ev of state.replay) {
    sseSend(res, 'replay', { d: Buffer.from(ev.data, 'utf8').toString('base64') });
  }
  sseSend(res, 'replay_end', {});
  sseSend(res, 'state', stateEvent());
  if (!isActive) broadcast('clients', { activeClientId: state.activeClientId });

  res.on('close', () => {
    state.clients.delete(clientId);
    log('client detach', `id=${clientId}`);
    if (state.activeClientId === clientId) {
      state.activeClientId = state.clients.keys().next().value || null;
      broadcast('clients', { activeClientId: state.activeClientId });
    }
  });
  // 连接级心跳防中间层空闲断开（本地直连意义小，成本为零）
  res.hbTimer = setInterval(() => res.write(': keepalive\n\n'), 15000);
  res.on('close', () => clearInterval(res.hbTimer));
}

function handleInput(req, res, body) {
  const clientId = req.headers['x-client-id'];
  if (!state.sessionAlive) return sendJson(res, 409, { error: 'session_dead' });
  if (!clientId || !state.clients.has(clientId)) {
    return sendJson(res, 403, { error: 'unknown_client' });
  }
  // 输入即接管：任何连接的输入都自动提升为活动连接（用户优先）。
  // 只读镜像只在该标签未输入时成立；一输入即获得控制权，其他标签变只读。
  if (state.activeClientId !== clientId) {
    state.activeClientId = clientId;
    broadcast('clients', { activeClientId: clientId });
    broadcast('state', stateEvent());
    log('auto takeover by input', `client=${clientId}`);
  }
  const text = body.toString('utf8');
  if (!text) return sendJson(res, 200, { ok: true });
  state.pty.write(text);
  if (!state.userActive) setUserActive(true); // 用户任何输入 → 用户优先锁
  sendJson(res, 200, { ok: true });
}

function handleRun(req, res, body, isKeys) {
  if (!state.sessionAlive) return sendJson(res, 409, { error: 'session_dead' });
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); } catch (e) { return sendJson(res, 400, { error: 'bad_json' }); }
  const cmd = payload.cmd_b64 ? Buffer.from(payload.cmd_b64, 'base64').toString('utf8') : (payload.cmd || '');
  if (!cmd) return sendJson(res, 400, { error: 'empty_cmd' });
  const timeoutMs = (parseInt(payload.timeout, 10) || config.runTimeout) * 1000;

  if (isKeys) {
    // keys 模式：原样写入（不置锁、无哨兵），用于交互程序内的按键注入
    state.pty.write(cmd);
    log('keys inject', `len=${cmd.length}`);
    return sendJson(res, 200, { ok: true, mode: 'keys' });
  }

  enqueueRun(cmd, timeoutMs).then((result) => {
    sendJson(res, 200, result);
  });
}

function handleResume(req, res) {
  // agent 平台清锁：放行后续排队命令（是否恢复由 agent 与用户确认后决定）
  state.userActive = false;
  broadcast('state', stateEvent());
  pump();
  sendJson(res, 200, { ok: true });
}

function handleTakeover(req, res) {
  // 只读镜像 → 接管为活动连接（可输入）
  const clientId = req.headers['x-client-id'];
  if (!clientId || !state.clients.has(clientId)) {
    return sendJson(res, 400, { error: 'unknown_client' });
  }
  state.activeClientId = clientId;
  broadcast('clients', { activeClientId: clientId });
  broadcast('state', stateEvent());
  log('takeover', `client=${clientId}`);
  sendJson(res, 200, { ok: true, activeClientId: clientId });
}

function handleResize(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8')); } catch (e) { /* ignore */ }
  const cols = parseInt(payload.cols, 10), rows = parseInt(payload.rows, 10);
  if (!cols || !rows || !state.pty) return sendJson(res, 400, { error: 'bad_params' });
  try { state.pty.resize(cols, rows); } catch (e) { log('resize error', e.message); } // Node 22 崩溃 bug 兜底
  sendJson(res, 200, { ok: true });
}

function handleKill(req, res) {
  if (state.killInFlight) return sendJson(res, 409, { error: 'kill_in_flight' });
  if (!state.pty) return sendJson(res, 409, { error: 'no_session' });
  state.killInFlight = true;
  const pid = state.pty.pid;

  // 杀进程树：Windows 用 taskkill /F /T；POSIX 用进程组信号（node-pty 在 Unix 上
  // 通常使 spawn 进程成为进程组组长，pgid == pid，负数即杀整个进程组）
  const finishKill = (err) => {
    state.killInFlight = false;
    if (err) {
      // 杀进程失败不致命：PTY 可能已退出，强制结束会话
      log('kill warn', String(err && err.message || err));
      if (state.pty) {
        try { state.pty.kill(); } catch (e) { /* ignore */ }
      }
      state.sessionAlive = false;
      broadcast('exit', { code: -1 });
    }
    broadcast('state', stateEvent());
    sendJson(res, 200, { ok: true });
  };

  log('kill session', `pid=${pid} platform=${process.platform}`);
  if (process.platform === 'win32') {
    exec(`taskkill /F /T /PID ${pid}`, finishKill);
  } else {
    try {
      process.kill(-pid, 'SIGTERM');            // 杀整个进程组（含子进程）
      finishKill(null);
    } catch (e) {
      try { process.kill(pid, 'SIGTERM'); finishKill(null); } // 兜底：仅杀组长
      catch (e2) { finishKill(e2); }
    }
  }
}

function handleReborn(req, res) {
  // 页内重建会话（kill-session 后恢复，无需重启整个服务）
  if (state.sessionAlive) return sendJson(res, 409, { error: 'session_alive' });
  if (state.killInFlight) return sendJson(res, 409, { error: 'kill_in_flight' });
  startSession();
  broadcast('state', stateEvent());
  log('session reborn');
  sendJson(res, 200, { ok: true });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function hostOk(req) {
  const host = (req.headers.host || '').toLowerCase();
  const name = host.split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['x-toy'] === '1'; // curl 等非浏览器客户端
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch (e) { return false; }
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- 启动 ----------
try { fs.mkdirSync(RUNTIME, { recursive: true }); } catch (e) { /* ignore */ }
startSession();
setInterval(heartbeat, 15000);

// 端口冲突自动 +1（最多 +10），实际端口写入 runtime/toy.port 供 toy.sh 发现
function tryListen(port) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < config.port + 10) {
      log('port busy', port, '->', port + 1);
      tryListen(port + 1);
    } else {
      log('listen fatal', e.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    state.actualPort = port; // status 返回实际监听端口（配置端口被占时 +1，agent 必须按实际连）
    try {
      fs.writeFileSync(path.join(RUNTIME, 'toy.port'), String(port));
      fs.writeFileSync(path.join(RUNTIME, 'toy.pid'), String(process.pid)); // 统一 pid 语义：node 真实 pid
    } catch (e) { /* ignore */ }
    log('listening', `http://127.0.0.1:${port}`);
    console.log(`TOY listening on http://127.0.0.1:${port} pid=${process.pid}`);
  });
}
tryListen(config.port);

process.on('SIGTERM', () => { log('sigterm received'); process.exit(0); });
process.on('SIGINT', () => { log('sigint received'); process.exit(0); });
process.on('exit', (code) => log('process exit', `code=${code}`)); // 崩溃/退出轨迹可见
process.on('uncaughtException', (e) => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => log('unhandled', e && e.stack ? e.stack : String(e)));
