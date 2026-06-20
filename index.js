#!/usr/bin/env node
  /**
   * Minecraft Bot Dashboard — Standalone for Render.com
   * npm install && node index.js
   */

  'use strict';

  const http    = require('http');
  const fs      = require('fs');
  const path    = require('path');
  const crypto  = require('crypto');
  const { EventEmitter } = require('events');
  const { WebSocketServer, WebSocket } = require('ws');
  const express = require('express');

  // ── Password store ─────────────────────────────────────────────────────────────
  const PASS_FILE = path.join(process.cwd(), 'bot-passwords.json');

  function loadPasswords() {
    try { return JSON.parse(fs.readFileSync(PASS_FILE, 'utf-8')); } catch { return {}; }
  }
  function savePasswords(data) {
    try { fs.writeFileSync(PASS_FILE, JSON.stringify(data, null, 2)); } catch {}
  }
  function getOrCreatePassword(host) {
    const store = loadPasswords();
    if (!store[host]) {
      store[host] = crypto.randomBytes(8).toString('hex');
      savePasswords(store);
      addLog('info', 'Generated new password for ' + host + ' (saved to disk)');
    }
    return store[host];
  }

  // ── State ──────────────────────────────────────────────────────────────────────
  const botEvents = new EventEmitter();

  let config = {
    host: '', port: 25565, username: '', version: '',
    autoReconnect: true, randomMovement: true,
    autoDrop: true, knockbackEvasion: true, autoAuth: true,
  };

  let botStatus = 'stopped';
  let stats = { health:0, food:0, ping:0, pos:{x:'0',y:'0',z:'0'}, players:0, uptime:0, reconnects:0, dropped:0 };
  const logs = [];
  let bot = null, startTime = null, moveInterval = null, reconnectTimeout = null;

  function addLog(level, message) {
    const entry = { ts: Date.now(), level, message };
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    botEvents.emit('log', entry);
    console.log('[' + level.toUpperCase() + ']', message);
  }

  function setStatus(s) {
    botStatus = s;
    botEvents.emit('status', { status: botStatus, stats });
  }

  // ── Auto-auth ──────────────────────────────────────────────────────────────────
  const REG_PATTERNS   = ['register', '/register'];
  const LOGIN_PATTERNS = ['login', 'log in', '/login', 'please log', 'please login'];

  function handleAuthMessage(text) {
    if (!config.autoAuth || !bot) return;
    const lower = text.toLowerCase();
    const isReg   = REG_PATTERNS.some(p => lower.includes(p));
    const isLogin = LOGIN_PATTERNS.some(p => lower.includes(p));
    if (!isReg && !isLogin) return;
    const pass = getOrCreatePassword(config.host);
    if (isReg && lower.includes('register')) {
      setTimeout(() => { if (bot) { bot.chat('/register ' + pass + ' ' + pass); addLog('success', 'Auto-registered on ' + config.host); } }, 800);
    } else if (isLogin) {
      setTimeout(() => { if (bot) { bot.chat('/login ' + pass); addLog('success', 'Auto-logged in on ' + config.host); } }, 800);
    }
  }

  // ── Bot ────────────────────────────────────────────────────────────────────────
  function startBot() {
    if (bot) { addLog('warn', 'Bot already running'); return; }
    if (!config.host || !config.username || !config.version) { addLog('error', 'Set Host, Username and Version first'); return; }
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
    setStatus('connecting');
    addLog('info', 'Connecting to ' + config.host + ':' + config.port + ' as ' + config.username + '…');
    const mineflayer = require('mineflayer');
    try {
      bot = mineflayer.createBot({ host: config.host, port: Number(config.port), username: config.username, version: config.version });
    } catch (err) {
      addLog('error', 'Failed: ' + err.message); setStatus('error'); bot = null; return;
    }
    bot.on('spawn', () => {
      setStatus('online'); startTime = Date.now(); addLog('success', 'Bot spawned!');
      if (config.randomMovement) {
        moveInterval = setInterval(() => {
          if (!bot) return;
          const dirs = ['forward','back','left','right'];
          bot.setControlState(dirs[Math.floor(Math.random()*4)], true);
          setTimeout(() => bot && bot.clearControlStates(), 800);
        }, 7000);
      }
    });
    bot.on('health', () => {
      stats.health = Math.round((bot.health/20)*100);
      stats.food   = Math.round((bot.food/20)*100);
      botEvents.emit('stats', stats);
    });
    bot.on('entityHurt', entity => {
      if (!config.knockbackEvasion || entity !== bot.entity) return;
      const a = bot.nearestEntity(e => e.type==='player' && e.position.distanceTo(bot.entity.position)<5);
      if (a) {
        addLog('warn','Hit — evading!');
        const dx=bot.entity.position.x-a.position.x, dz=bot.entity.position.z-a.position.z;
        bot.setControlState(Math.abs(dx)>Math.abs(dz)?(dx>0?'right':'left'):(dz>0?'back':'forward'),true);
        bot.setControlState('jump',true);
        setTimeout(()=>bot&&bot.clearControlStates(),500);
      }
    });
    bot.on('playerCollect', async collector => {
      if (!config.autoDrop || collector!==bot.entity) return;
      await new Promise(r=>setTimeout(r,1000));
      const items = bot.inventory.items();
      addLog('info','Clearing '+items.length+' items…');
      for (const item of items) {
        await new Promise(r=>setTimeout(r,600));
        try { await bot.tossStack(item); stats.dropped++; addLog('info','Dropped: '+item.name); botEvents.emit('stats',stats); }
        catch(err) { addLog('error','Could not drop '+item.name+': '+err.message); }
      }
    });
    bot.on('chat', (username, message) => {
      if (username===bot.username) return;
      addLog('chat','<'+username+'> '+message);
      handleAuthMessage(message);
    });
    bot.on('message', jsonMsg => { try { handleAuthMessage(jsonMsg.toString()); } catch {} });
    bot.on('playerJoined', p => { stats.players=Object.keys(bot.players||{}).length; addLog('info','Joined: '+p.username); botEvents.emit('stats',stats); });
    bot.on('playerLeft',   p => { stats.players=Object.keys(bot.players||{}).length; addLog('info','Left: '+p.username);   botEvents.emit('stats',stats); });
    bot.on('death',  () => { addLog('warn','Died — respawning…'); setTimeout(()=>bot&&bot.respawn(),2000); });
    bot.on('kicked', reason => { addLog('warn','Kicked: '+reason); cleanup('disconnected'); scheduleReconnect(); });
    bot.on('end',    reason => { addLog('warn','Ended ('+(reason||'unknown')+')'); cleanup('disconnected'); scheduleReconnect(); });
    bot.on('error',  err    => { addLog('error','Error: '+err.message); cleanup('error'); });
  }

  function stopBot() {
    if (!bot) { addLog('warn','No bot running'); return; }
    config.autoReconnect = false;
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
    try { bot.quit('Dashboard stopped'); } catch {}
    cleanup('stopped'); addLog('info','Bot stopped');
  }

  function sendChat(msg) {
    if (!bot) { addLog('warn','Bot not connected'); return; }
    bot.chat(msg); addLog('chat','<'+config.username+'> '+msg);
  }

  function updateConfig(cfg) { Object.assign(config, cfg); addLog('info','Config updated'); }

  function getSnapshot() {
    const store = loadPasswords();
    return { status: botStatus, stats, config, logs: logs.slice(-200), storedPassword: config.host ? (store[config.host]||null) : null };
  }

  function cleanup(next) {
    if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
    bot = null; startTime = null; setStatus(next);
  }
  function scheduleReconnect() {
    if (!config.autoReconnect) return;
    stats.reconnects++;
    addLog('info','Reconnecting in 5s…');
    reconnectTimeout = setTimeout(()=>{ reconnectTimeout=null; startBot(); }, 5000);
  }

  setInterval(() => {
    if (!bot || !bot.entity) return;
    const p = bot.entity.position;
    stats.pos = { x:p.x.toFixed(1), y:p.y.toFixed(1), z:p.z.toFixed(1) };
    stats.ping    = (bot.player && bot.player.ping) || 0;
    stats.players = Object.keys(bot.players||{}).length;
    stats.uptime  = startTime ? Math.floor((Date.now()-startTime)/1000) : 0;
    botEvents.emit('stats', stats);
  }, 2000);

  // ── HTML ────────────────────────────────────────────────────────────────────────
  const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>🤖 Bot Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d0f14;--surface:#151921;--surface2:#1c2230;--border:#252d3d;
  --text:#e2e8f0;--muted:#64748b;--green:#22c55e;--red:#ef4444;
  --yellow:#eab308;--blue:#3b82f6;--cyan:#06b6d4;--purple:#a855f7;
  --accent:#3b82f6;
}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:14px;min-height:100vh;display:flex;flex-direction:column}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}

.header{display:flex;align-items:center;gap:12px;padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
.header-logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px;letter-spacing:-.3px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0;transition:background .3s,box-shadow .3s}
.dot.online{background:var(--green);box-shadow:0 0 8px var(--green)}
.dot.connecting{background:var(--yellow);animation:pulse 1s infinite}
.dot.error,.dot.disconnected{background:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.status-badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;background:var(--surface2);border:1px solid var(--border)}
.status-badge.online{color:var(--green);border-color:#22c55e40;background:#22c55e10}
.status-badge.connecting{color:var(--yellow);border-color:#eab30840;background:#eab30810}
.status-badge.error,.status-badge.disconnected{color:var(--red);border-color:#ef444440;background:#ef444410}
.status-badge.stopped{color:var(--muted);border-color:var(--border)}
.ws-pill{padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.4px;background:var(--surface2);border:1px solid var(--border);color:var(--muted)}
.ws-pill.connected{color:var(--green);border-color:#22c55e40;background:#22c55e10}
.header-actions{display:flex;gap:8px;margin-left:auto}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:1px solid transparent;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;letter-spacing:.2px;line-height:1}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn-primary:hover{background:#2563eb}
.btn-danger{background:#ef444420;color:var(--red);border-color:#ef444440}
.btn-danger:hover{background:#ef444430}
.btn-ghost{background:transparent;color:var(--muted);border-color:var(--border)}
.btn-ghost:hover{background:var(--surface2);color:var(--text)}
.btn:disabled{opacity:.4;cursor:not-allowed}

.layout{display:grid;grid-template-columns:290px 1fr;flex:1;overflow:hidden;height:calc(100vh - 53px)}
.sidebar{background:var(--surface);border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column}
.main{display:flex;flex-direction:column;overflow:hidden}

.sidebar-tabs{display:flex;border-bottom:1px solid var(--border)}
.sidebar-tab{flex:1;padding:10px 6px;text-align:center;font-size:11px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;letter-spacing:.3px;text-transform:uppercase}
.sidebar-tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.sidebar-panel{flex:1;padding:16px;display:none;flex-direction:column;gap:14px}
.sidebar-panel.active{display:flex}

.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stat-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:4px}
.stat-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
.stat-value{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
.stat-sub{font-size:10px;color:var(--muted)}
.stat-card.full{grid-column:1/-1}
.bar-wrap{margin-top:4px;height:4px;background:var(--border);border-radius:2px;overflow:hidden}
.bar-fill{height:100%;border-radius:2px;transition:width .4s}
.section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);padding:4px 0 2px}

.form-group{display:flex;flex-direction:column;gap:4px}
.form-group label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.form-group input{background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:8px 10px;width:100%;transition:border .15s;outline:none}
.form-group input:focus{border-color:var(--accent)}
.form-group input::placeholder{color:var(--muted)}
.toggle-row{display:flex;align-items:center;justify-content:space-between}
.toggle-row span{font-size:12px;color:var(--text)}
.toggle{position:relative;width:36px;height:20px;cursor:pointer;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:var(--border);border-radius:10px;transition:.2s}
.toggle-slider:before{content:'';position:absolute;width:14px;height:14px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.toggle input:checked + .toggle-slider{background:var(--accent)}
.toggle input:checked + .toggle-slider:before{transform:translateX(16px)}

/* Password box */
.pass-box{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.pass-val{font-family:monospace;font-size:12px;color:var(--green);flex:1;word-break:break-all}
.pass-none{font-size:11px;color:var(--muted);font-style:italic}
.copy-btn{background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:10px;font-weight:600;padding:3px 8px;cursor:pointer;white-space:nowrap}
.copy-btn:hover{color:var(--text);border-color:var(--accent)}

.main-tabs{display:flex;gap:2px;padding:10px 16px 0;border-bottom:1px solid var(--border);background:var(--surface)}
.main-tab{padding:8px 14px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;border-radius:8px 8px 0 0;border:1px solid transparent;border-bottom:none;transition:all .15s}
.main-tab.active{background:var(--bg);color:var(--text);border-color:var(--border)}
.main-panel{flex:1;overflow:hidden;display:none;flex-direction:column}
.main-panel.active{display:flex}

.console-toolbar{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--border);background:var(--surface);flex-wrap:wrap}
.console-filter{display:flex;gap:4px}
.filter-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--muted);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s}
.filter-btn.active{background:var(--surface2);color:var(--text);border-color:var(--accent)}
.console-search{background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;padding:5px 10px;width:180px;outline:none}
.console-search:focus{border-color:var(--accent)}
.auto-scroll-label{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);cursor:pointer;margin-left:auto}
.console-out{flex:1;overflow-y:auto;padding:10px 14px;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12px;line-height:1.7}
.log-entry{display:flex;gap:10px;padding:2px 6px;border-radius:4px}
.log-entry:hover{background:var(--surface2)}
.log-time{color:var(--muted);flex-shrink:0;font-size:10px;padding-top:2px}
.log-badge{flex-shrink:0;font-size:9px;font-weight:700;text-transform:uppercase;padding:2px 5px;border-radius:4px;letter-spacing:.4px;align-self:flex-start;margin-top:2px}
.log-badge.info{background:#3b82f620;color:var(--blue)}
.log-badge.warn{background:#eab30820;color:var(--yellow)}
.log-badge.error{background:#ef444420;color:var(--red)}
.log-badge.success{background:#22c55e20;color:var(--green)}
.log-badge.chat{background:#a855f720;color:var(--purple)}
.log-msg{flex:1;word-break:break-all;white-space:pre-wrap;color:var(--text)}

.chat-bar{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--border);background:var(--surface)}
.chat-input{flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;padding:8px 12px;outline:none}
.chat-input:focus{border-color:var(--accent)}
.chat-input::placeholder{color:var(--muted)}

@media(max-width:700px){.layout{grid-template-columns:1fr}.sidebar{max-height:260px}}
</style>
</head>
<body>

<div class="header">
  <div class="header-logo">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
    Bot Dashboard
  </div>
  <div class="dot" id="hdr-dot"></div>
  <span class="status-badge stopped" id="hdr-badge">Stopped</span>
  <span class="ws-pill" id="ws-pill">WS Connecting…</span>
  <div class="header-actions">
    <button class="btn btn-primary" id="btn-start" onclick="sendCmd('start')">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      Start Bot
    </button>
    <button class="btn btn-danger" id="btn-stop" onclick="sendCmd('stop')" disabled>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      Stop
    </button>
  </div>
</div>

<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-tabs">
      <div class="sidebar-tab active" onclick="switchSideTab('stats',this)">Stats</div>
      <div class="sidebar-tab" onclick="switchSideTab('config',this)">Config</div>
    </div>

    <!-- Stats panel -->
    <div class="sidebar-panel active" id="side-stats">
      <div class="section-label">Health &amp; Food</div>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">❤️ Health</div>
          <div class="stat-value" id="s-health" style="color:var(--red)">0%</div>
          <div class="bar-wrap"><div class="bar-fill" id="bar-health" style="width:0%;background:var(--red)"></div></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">🍖 Food</div>
          <div class="stat-value" id="s-food" style="color:var(--yellow)">0%</div>
          <div class="bar-wrap"><div class="bar-fill" id="bar-food" style="width:0%;background:var(--yellow)"></div></div>
        </div>
      </div>
      <div class="section-label">Network</div>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">📡 Ping</div>
          <div class="stat-value" id="s-ping" style="color:var(--cyan)">0</div>
          <div class="stat-sub">ms</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">👥 Players</div>
          <div class="stat-value" id="s-players" style="color:var(--purple)">0</div>
          <div class="stat-sub">online</div>
        </div>
      </div>
      <div class="section-label">Session</div>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">⏱ Uptime</div>
          <div class="stat-value" id="s-uptime" style="font-size:15px;color:var(--green)">0s</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">🔄 Reconnects</div>
          <div class="stat-value" id="s-reconnects" style="color:var(--yellow)">0</div>
        </div>
        <div class="stat-card full">
          <div class="stat-label">🗑 Items Dropped</div>
          <div class="stat-value" id="s-dropped" style="color:var(--blue)">0</div>
        </div>
      </div>
      <div class="section-label">Position</div>
      <div class="stat-card">
        <div class="stat-label">📍 Coordinates</div>
        <div id="s-pos" style="font-size:12px;font-family:monospace;margin-top:4px;color:var(--muted)">X: — Y: — Z: —</div>
      </div>
      <div class="section-label">Auto-Auth Password</div>
      <div class="stat-card full" style="gap:8px">
        <div class="stat-label">🔑 Stored for this server</div>
        <div class="pass-box">
          <span id="pass-display" class="pass-none">No server configured</span>
          <button class="copy-btn" onclick="copyPass()">Copy</button>
        </div>
        <div style="font-size:10px;color:var(--muted);line-height:1.5">Generated automatically on first register. Saved permanently — survives restarts &amp; deploys.</div>
      </div>
    </div>

    <!-- Config panel -->
    <div class="sidebar-panel" id="side-config">
      <div class="section-label">Server</div>
      <div class="form-group"><label>Host</label><input id="cfg-host" type="text" placeholder="e.g. play.example.com"/></div>
      <div class="form-group"><label>Port</label><input id="cfg-port" type="number" placeholder="25565"/></div>
      <div class="section-label">Bot</div>
      <div class="form-group"><label>Username</label><input id="cfg-user" type="text" placeholder="e.g. MyBot"/></div>
      <div class="form-group">
        <label>Version <span style="font-weight:400;text-transform:none;font-size:10px;color:var(--muted)">(type any version)</span></label>
        <input id="cfg-ver" type="text" placeholder="e.g. 1.21.11"/>
      </div>
      <div class="section-label">Features</div>
      <div class="form-group" style="gap:10px">
        <div class="toggle-row"><span>Auto Reconnect</span><label class="toggle"><input type="checkbox" id="cfg-auto" checked/><span class="toggle-slider"></span></label></div>
        <div class="toggle-row"><span>Random Movement</span><label class="toggle"><input type="checkbox" id="cfg-move" checked/><span class="toggle-slider"></span></label></div>
        <div class="toggle-row"><span>Auto Drop Items</span><label class="toggle"><input type="checkbox" id="cfg-drop" checked/><span class="toggle-slider"></span></label></div>
        <div class="toggle-row"><span>Knockback Evasion</span><label class="toggle"><input type="checkbox" id="cfg-kb" checked/><span class="toggle-slider"></span></label></div>
        <div class="toggle-row">
          <span style="display:flex;flex-direction:column;gap:2px">
            Auto Register / Login
            <span style="font-size:10px;color:var(--muted)">Handles auth plugins automatically</span>
          </span>
          <label class="toggle"><input type="checkbox" id="cfg-auth" checked/><span class="toggle-slider"></span></label>
        </div>
      </div>
      <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:4px" onclick="applyConfig()">Apply Config</button>
    </div>
  </aside>

  <div class="main">
    <div class="main-tabs">
      <div class="main-tab active" onclick="switchMainTab('console',this)">Console</div>
      <div class="main-tab" onclick="switchMainTab('chat',this)">Chat</div>
    </div>

    <div class="main-panel active" id="panel-console">
      <div class="console-toolbar">
        <div class="console-filter">
          <button class="filter-btn active" onclick="setFilter('all',this)">All</button>
          <button class="filter-btn" onclick="setFilter('info',this)">Info</button>
          <button class="filter-btn" onclick="setFilter('warn',this)">Warn</button>
          <button class="filter-btn" onclick="setFilter('error',this)">Error</button>
          <button class="filter-btn" onclick="setFilter('chat',this)">Chat</button>
        </div>
        <input class="console-search" id="console-search" type="text" placeholder="Search logs…" oninput="renderLogs()"/>
        <label class="auto-scroll-label"><input type="checkbox" id="auto-scroll" checked/> Auto-scroll</label>
        <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="clearLogs()">Clear</button>
      </div>
      <div class="console-out" id="console-out"></div>
    </div>

    <div class="main-panel" id="panel-chat">
      <div class="console-out" id="chat-out" style="flex:1"></div>
      <div class="chat-bar">
        <input class="chat-input" id="chat-input" type="text" placeholder="Send a message in-game…" onkeydown="if(event.key==='Enter')sendChat()"/>
        <button class="btn btn-primary" onclick="sendChat()">Send</button>
      </div>
    </div>
  </div>
</div>

<script>
let ws, reconnTimer;
let allLogs = [];
let activeFilter = 'all';
let currentPass = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onopen = () => { clearTimeout(reconnTimer); setPill(true); };
  ws.onmessage = (e) => {
    const { type, payload } = JSON.parse(e.data);
    if (type === 'init') {
      allLogs = payload.logs || [];
      renderLogs(); renderChatLogs();
      updateStatus(payload.status, payload.stats);
      loadConfig(payload.config);
      setPass(payload.storedPassword);
    } else if (type === 'log') {
      allLogs.push(payload);
      if (activeFilter === 'all' || activeFilter === payload.level) appendLog(document.getElementById('console-out'), payload);
      if (payload.level === 'chat') appendLog(document.getElementById('chat-out'), payload);
    } else if (type === 'status') {
      updateStatus(payload.status, payload.stats);
    } else if (type === 'stats') {
      updateStats(payload);
    } else if (type === 'password') {
      setPass(payload);
    }
  };
  ws.onclose = () => { setPill(false); reconnTimer = setTimeout(connect, 2000); };
  ws.onerror  = () => ws.close();
}

function setPill(on) {
  const p = document.getElementById('ws-pill');
  p.textContent = on ? 'WS Live' : 'WS Reconnecting…';
  p.className = 'ws-pill' + (on ? ' connected' : '');
}

function sendCmd(cmd, extra = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: cmd, ...extra }));
}

function setPass(p) {
  currentPass = p;
  const el = document.getElementById('pass-display');
  if (!el) return;
  if (p) {
    el.className = 'pass-val';
    el.textContent = p;
  } else {
    el.className = 'pass-none';
    el.textContent = document.getElementById('cfg-host')?.value
      ? 'Will generate on first connect'
      : 'No server configured';
  }
}

function copyPass() {
  if (!currentPass) return;
  navigator.clipboard.writeText(currentPass).then(() => {
    const btn = document.querySelector('.copy-btn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

function updateStatus(status, stats) {
  const dot = document.getElementById('hdr-dot');
  const badge = document.getElementById('hdr-badge');
  dot.className = 'dot ' + status;
  badge.className = 'status-badge ' + status;
  badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  document.getElementById('btn-start').disabled = status === 'online' || status === 'connecting';
  document.getElementById('btn-stop').disabled  = status === 'stopped' || status === 'disconnected';
  if (stats) updateStats(stats);
}

function updateStats(s) {
  set('s-health', s.health + '%'); set('s-food', s.food + '%');
  set('s-ping', s.ping + ' ms'); set('s-players', s.players);
  set('s-reconnects', s.reconnects); set('s-dropped', s.dropped);
  set('s-uptime', fmtUptime(s.uptime));
  if (s.pos) set('s-pos', 'X: ' + s.pos.x + '  Y: ' + s.pos.y + '  Z: ' + s.pos.z);
  bar('bar-health', s.health); bar('bar-food', s.food);
}

function set(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function bar(id, pct) { const el = document.getElementById(id); if (el) el.style.width = pct + '%'; }
function fmtUptime(s) {
  if (!s) return '0s';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
  return h ? h+'h '+m+'m' : m ? m+'m '+ss+'s' : ss+'s';
}

function renderLogs() {
  const out = document.getElementById('console-out');
  const q = document.getElementById('console-search').value.toLowerCase();
  out.innerHTML = '';
  allLogs.filter(l => (activeFilter === 'all' || l.level === activeFilter) && (!q || l.message.toLowerCase().includes(q)))
    .forEach(l => appendLog(out, l, false));
  autoScroll(out);
}

function renderChatLogs() {
  const out = document.getElementById('chat-out');
  out.innerHTML = '';
  allLogs.filter(l => l.level === 'chat').forEach(l => appendLog(out, l, false));
}

function appendLog(container, log, scroll = true) {
  if (container.id === 'console-out') {
    const q = document.getElementById('console-search').value.toLowerCase();
    if (activeFilter !== 'all' && log.level !== activeFilter) return;
    if (q && !log.message.toLowerCase().includes(q)) return;
  }
  const t = new Date(log.ts);
  const el = document.createElement('div');
  el.className = 'log-entry';
  el.innerHTML = '<span class="log-time">'+pad(t.getHours())+':'+pad(t.getMinutes())+':'+pad(t.getSeconds())+'</span>'
    +'<span class="log-badge '+log.level+'">'+log.level+'</span>'
    +'<span class="log-msg">'+esc(log.message)+'</span>';
  container.appendChild(el);
  if (scroll) autoScroll(container);
}

function autoScroll(el) {
  if (document.getElementById('auto-scroll').checked) el.scrollTop = el.scrollHeight;
}

function clearLogs() { allLogs = []; document.getElementById('console-out').innerHTML = ''; }

function setFilter(f, btn) {
  activeFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderLogs();
}

function sendChat() {
  const inp = document.getElementById('chat-input');
  const msg = inp.value.trim();
  if (!msg) return;
  sendCmd('chat', { message: msg });
  inp.value = '';
}

function applyConfig() {
  const host = document.getElementById('cfg-host').value.trim();
  sendCmd('config', { config: {
    host,
    port: Number(document.getElementById('cfg-port').value) || 25565,
    username: document.getElementById('cfg-user').value.trim(),
    version: document.getElementById('cfg-ver').value.trim(),
    autoReconnect: document.getElementById('cfg-auto').checked,
    randomMovement: document.getElementById('cfg-move').checked,
    autoDrop: document.getElementById('cfg-drop').checked,
    knockbackEvasion: document.getElementById('cfg-kb').checked,
    autoAuth: document.getElementById('cfg-auth').checked,
  }});
  // Update pass display hint immediately
  if (!currentPass) setPass(null);
}

function loadConfig(cfg) {
  if (!cfg) return;
  document.getElementById('cfg-host').value = cfg.host || '';
  document.getElementById('cfg-port').value = cfg.port || '';
  document.getElementById('cfg-user').value = cfg.username || '';
  document.getElementById('cfg-ver').value  = cfg.version  || '';
  document.getElementById('cfg-auto').checked = !!cfg.autoReconnect;
  document.getElementById('cfg-move').checked = !!cfg.randomMovement;
  document.getElementById('cfg-drop').checked = !!cfg.autoDrop;
  document.getElementById('cfg-kb').checked   = !!cfg.knockbackEvasion;
  document.getElementById('cfg-auth').checked = cfg.autoAuth !== false;
}

function switchSideTab(id, el) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('side-'+id).classList.add('active');
}

function switchMainTab(id, el) {
  document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.main-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('panel-'+id).classList.add('active');
}

function pad(n) { return String(n).padStart(2,'0'); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

connect();
</script>
</body>
</html>`;

  // ── Express + WebSocket server ─────────────────────────────────────────────────
  const app = express();
  app.get('/', (_req, res) => res.setHeader('Content-Type','text/html;charset=utf-8') && res.send(DASHBOARD_HTML) || res.send(DASHBOARD_HTML));
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    else socket.destroy();
  });

  const clients = new Set();
  wss.on('connection', ws => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'init', payload: getSnapshot() }));
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type==='start')  startBot();
      if (msg.type==='stop')   stopBot();
      if (msg.type==='chat'  && msg.message) sendChat(msg.message);
      if (msg.type==='config'&& msg.config)  updateConfig(msg.config);
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const ws of clients) if (ws.readyState===WebSocket.OPEN) ws.send(msg);
  }
  botEvents.on('log',    e => broadcast('log',    e));
  botEvents.on('status', d => broadcast('status', d));
  botEvents.on('stats',  d => broadcast('stats',  d));

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('\n  Dashboard running at http://localhost:'+PORT+'\n'));
  