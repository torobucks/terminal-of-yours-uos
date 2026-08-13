/* Terminal-of-Yours 前端：xterm.js + SSE 输出 + POST 输入 + 协同状态条 */
(function () {
  'use strict';

  const term = new Terminal({
    scrollback: 10000,
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    convertEol: false,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();

  const $ = (id) => document.getElementById(id);
  let clientId = null;
  let active = false;        // 本连接是否活动连接（可输入）
  let replaying = false;     // 回放进行中
  let es = null;

  // JS 运行时错误显示到状态条（避免静默白屏）
  window.onerror = (msg) => {
    const t = document.getElementById('sessionText');
    if (t) t.textContent = 'JS 错误: ' + String(msg).slice(0, 120);
  };

  // atob 返回 Latin-1 字符串，必须转回 UTF-8（否则中文乱码）
  function b64ToUtf8(b64) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // 哨兵行渲染为 ✓：行内包含完整哨兵模式 `__TOY_DONE_<16hex>_<n>__` 即整行替换。
  // 前后允许任意 ANSI 序列（PS 输出行常带 \x1b[m 前缀与光标定位后缀）。
  // 回显行不匹配：回显里是未展开的 `_$([int]$LASTEXITCODE)`（非数字形式）。
  function cleanSentinel(text) {
    return text.split(/(\r\n|\n)/).map((seg) => {
      if (/__TOY_DONE_[0-9a-f]{16}_\d+__/.test(seg)) return '✓';
      return seg;
    }).join('');
  }

  // ---------- 状态条 ----------
  function setSession(text, cls) {
    $('sessionText').textContent = text;
    $('dot').className = 'dot ' + (cls || 'ok');
  }
  // 横幅常显当前操作权（点击切换 user ⇄ agent）：
  //   user 模式无锁：👤 用户模式 · 点击让 agent 接管
  //   user 模式有锁：⏸ agent 已让位（点击让 agent 接管）
  //   agent 模式：🤖 agent 操作中 · 点击收回控制权
  let controlMode = 'user';
  let userActive = false;
  let lastPreview = '';
  function renderChip() {
    const chip = $('pausedChip');
    if (sessionDead) {
      chip.style.display = 'none';
      return;
    }
    if (controlMode === 'agent') {
      chip.textContent = '🤖 agent 操作中 · 点击收回控制权';
    } else if (userActive) {
      chip.textContent = lastPreview
        ? '⏸ agent 命令已暂停: ' + lastPreview + '（点击让 agent 接管）'
        : '⏸ agent 已让位（点击让 agent 接管）';
    } else {
      chip.textContent = '👤 用户模式 · 点击让 agent 接管';
    }
    chip.style.display = 'inline-block';
  }
  function syncInputLock() {
    // 输入锁定 = agent 模式（显式禁止用户输入）或会话已结束
    term.options.disableStdin = (controlMode === 'agent') || sessionDead;
  }
  function setControlMode(mode) {
    controlMode = mode;
    syncInputLock();
    renderChip();
  }
  function setReadonly(on) {
    $('roChip').style.display = on ? 'inline-block' : 'none';
    $('btnTakeover').style.display = on ? 'inline-block' : 'none';
    // 不禁用 stdin：只读标签输入照发，服务端「输入即接管」会提升本连接；
    // 输入锁定只由操作权模式/会话状态决定
    syncInputLock();
  }
  $('pausedChip').onclick = () => {
    fetch('/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: controlMode === 'agent' ? 'user' : 'agent' }),
    }).catch(() => {});
  };

  // ---------- 输入 ----------
  // 只读镜像也照发输入：服务端「输入即接管」——在任何标签打字都有效
  term.onData((data) => {
    if (!clientId) return;
    fetch('/input', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Client-Id': clientId },
      body: data,
    }).catch(() => { /* 服务重连时忽略 */ });
  });

  // 接管输入：只读镜像 → 申请成为活动连接
  $('btnTakeover').onclick = () => {
    if (!clientId) return;
    fetch('/api/takeover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
    }).then((r) => r.json()).then((d) => {
      if (d.ok) {
        active = true;
        setReadonly(false);
        renderChip();
      }
    }).catch(() => {});
  };

  // 断开连接 = 终止整个终端会话（PTY 进程 + agent 通道）；
  // 会话结束后按钮变为「重建会话」（服务端重启 PTY，无需重启服务）
  let sessionDead = false;
  function killSession() {
    fetch('/api/kill-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).then((r) => r.json()).then((d) => {
      if (d.ok) {
        sessionDead = true;
        setSession('会话已断开（终端进程已终止）', 'bad');
        $('btnDisconnect').textContent = '重建会话';
        syncInputLock();
        renderChip(); // 会话结束 → 横幅隐藏
      }
    }).catch(() => {});
  }
  function rebornSession() {
    fetch('/api/reborn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).then((r) => r.json()).then((d) => {
      if (d.ok) {
        sessionDead = false;
        term.reset(); // 新会话从空白开始
        syncInputLock();
        $('btnDisconnect').textContent = '断开连接';
      }
    }).catch(() => {});
  }
  $('btnDisconnect').onclick = () => (sessionDead ? rebornSession() : killSession());

  // ---------- resize（防抖 100ms 上报） ----------
  let resizeTimer = null;
  function reportResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try {
        fitAddon.fit();
        fetch('/api/resize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
        }).catch(() => {});
      } catch (e) { /* ignore */ }
    }, 100);
  }
  window.addEventListener('resize', reportResize);
  setTimeout(reportResize, 300);

  // ---------- SSE ----------
  // 注意：EventSource 的 onmessage 只接收无 event: 字段的默认事件；
  // 服务端发的是命名事件（event: hello/out/...），必须逐个 addEventListener
  function handleEvent(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    switch (ev.type) {
      case 'hello':
        clientId = msg.clientId;
        active = msg.active;
        setReadonly(!active);
        break;
      case 'replay_start':
        replaying = true;
        break;
      case 'replay':
        if (replaying) term.write(cleanSentinel(b64ToUtf8(msg.d)));
        break;
      case 'replay_end':
        replaying = false;
        setSession('已连接', 'ok');
        break;
      case 'out':
        if (!replaying) term.write(cleanSentinel(b64ToUtf8(msg.d)));
        break;
      case 'state':
        userActive = !!msg.userActive;
        if (!msg.userActive) lastPreview = '';
        setControlMode(msg.controlMode || 'user');
        setSession(msg.sessionAlive ? '已连接' : '会话已结束', msg.sessionAlive ? 'ok' : 'bad');
        if (msg.sessionAlive) {
          sessionDead = false;
          $('btnDisconnect').textContent = '断开连接';
        }
        break;
      case 'paused':
        lastPreview = msg.preview || '';
        renderChip();
        break;
      case 'clients':
        if (clientId && msg.activeClientId !== clientId) {
          active = false;
          setReadonly(true);
        } else if (clientId && msg.activeClientId === clientId) {
          active = true;
          setReadonly(false);
        }
        break;
      case 'exit':
        sessionDead = true;
        setSession('会话已结束（点击「重建会话」恢复）', 'bad');
        $('btnDisconnect').textContent = '重建会话';
        syncInputLock();
        renderChip(); // sessionDead → 横幅隐藏
        break;
      default:
        break;
    }
  }

  function connect() {
    es = new EventSource('/stream');

    es.onopen = () => {
      term.reset(); // 重连：清屏等回放，避免重复渲染
      setSession('已连接，回放中…', 'ok');
      $('btnDisconnect').textContent = '断开连接';
    };
    es.onerror = () => {
      if (es) setSession('连接中断，重连中…', 'bad');
    };

    ['hello', 'replay_start', 'replay', 'replay_end', 'out', 'state',
     'paused', 'clients', 'exit'
    ].forEach((name) => es.addEventListener(name, handleEvent));
  }
  connect();
})();
