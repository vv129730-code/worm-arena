'use strict';
/* Worm Arena — client: canvas render, input, interpolation, HUD */

const CFG = {
  TICK_HZ: 30,
  INTERP_MS: 100,   // render ~100ms behind server time
  BOOST_MIN_LEN: 13,
};

const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
const mmCv = document.getElementById('minimap');
const mmCtx = mmCv.getContext('2d');

const $ = (id) => document.getElementById(id);

// ---------- connection ----------
let ws = null;
let myId = null;
let roomCode = null;
let maxPlayers = 0;

// ---------- world state (client copy) ----------
const worms = new Map();   // id -> {id,hue,skin,x,y,dir,len,boost,protect, prevX,prevY,px,py}
const foods = new Map();   // id -> {x,y,r,v,hue}
const pellets = new Map(); // id -> {x,y,r,v,hue,born}
let leaderboard = [];
let kills = [];

// ---------- rendering state ----------
let cam = { x: 0, y: 0, zoom: 1 };
let mouse = { x: 0, y: 0, down: false };
let spaceDown = false;
let serverTimeOffset = 0;
let lastSnapTick = 0;
let dead = false;
let fps = 60;

function resize() {
  cv.width = window.innerWidth * devicePixelRatio;
  cv.height = window.innerHeight * devicePixelRatio;
  cv.style.width = window.innerWidth + 'px';
  cv.style.height = window.innerHeight + 'px';
}
window.addEventListener('resize', resize);
resize();

// ---------- lobby UI ----------
function show(el, on) { el.classList.toggle('hidden', !on); }

$('tab-host').addEventListener('click', () => {
  $('tab-host').classList.add('active');
  $('tab-join').classList.remove('active');
  show($('pane-host'), true);
  show($('pane-join'), false);
});
$('tab-join').addEventListener('click', () => {
  $('tab-join').classList.add('active');
  $('tab-host').classList.remove('active');
  show($('pane-join'), true);
  show($('pane-host'), false);
});

function connect() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Connection failed'));
    ws.onclose = () => {
      // Only treat as a disconnect if we're not already on the death/lobby screen
      if (!dead && myId !== null) {
        $('lobby-status').textContent = 'Disconnected from server.';
        document.body.classList.remove('playing');
        show($('lobby'), true);
        show($('hud'), false);
        show($('death'), false);
      }
      ws = null;
    };
  });
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

async function hostGame() {
  const name = $('host-name').value.trim() || 'Host';
  const max = Math.max(2, Math.min(50, parseInt($('host-max').value, 10) || 10));
  $('lobby-status').textContent = 'Connecting…';
  try {
    await connect();
    ws.onmessage = onMessage;
    send({ t: 'create', name, maxPlayers: max, skin: 0 });
  } catch (e) {
    $('lobby-status').textContent = e.message;
  }
}

async function joinGame() {
  const name = $('join-name').value.trim() || 'Player';
  const code = $('join-code').value.trim();
  if (!/^\d{6}$/.test(code)) {
    $('lobby-status').textContent = 'Room code 6 digits ka hona chahiye.';
    return;
  }
  $('lobby-status').textContent = 'Connecting…';
  try {
    await connect();
    ws.onmessage = onMessage;
    send({ t: 'join', name, code, skin: 0 });
  } catch (e) {
    $('lobby-status').textContent = e.message;
  }
}

$('btn-host').addEventListener('click', hostGame);
$('btn-join').addEventListener('click', joinGame);
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(); });

// ---------- server messages ----------
function onMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (e) { return; }
  switch (msg.t) {
    case 'welcome':
      myId = msg.id;
      roomCode = msg.roomCode;
      maxPlayers = msg.maxPlayers;
      dead = false;
      document.body.classList.add('playing');
      show($('lobby'), false);
      show($('hud'), true);
      show($('death'), false);
      show($('room-pill'), true);
      $('room-code').textContent = roomCode;
      $('lobby-status').textContent = '';
      break;
    case 'error':
      $('lobby-status').textContent = msg.msg;
      $('death-stats').textContent = msg.msg;
      try { ws.close(); } catch (e) {}
      break;
    case 'snap':
      applySnapshot(msg);
      break;
    case 'died':
      onDied(msg.by);
      break;
    case 'chat':
      addKillFeed(`${msg.name}: ${msg.text}`);
      break;
    case 'pong':
      break;
  }
}

function applySnapshot(s) {
  lastSnapTick = s.tick;
  serverTimeOffset = s.time - performance.now();

  // worms — head updates arrive at NET_HZ; we record a position history so the
  // client can rebuild each worm's body path (server only sends the head).
  const seen = new Set();
  for (const row of s.worms) {
    const [id, hue, skin, x, y, dir, len, boost, protect] = row;
    seen.add(id);
    let w = worms.get(id);
    if (!w) {
      w = { id, hue, skin, x, y, dir, len, boost, protect, history: [] };
      worms.set(id, w);
    } else {
      w.x = x; w.y = y; w.dir = dir; w.len = len; w.boost = boost; w.protect = protect;
    }
    const h = w.history;
    const last = h[h.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y) > 2) {
      h.push({ x, y });
      if (h.length > 400) h.splice(0, h.length - 400);
    }
  }
  for (const id of [...worms.keys()]) if (!seen.has(id)) worms.delete(id);

  // food delta
  for (const f of (s.foodNew || [])) foods.set(f.i, f);
  for (const id of (s.foodDel || [])) foods.delete(id);

  // pellets: full visible set each snapshot
  pellets.clear();
  for (const p of (s.pellets || [])) { p.born = performance.now(); pellets.set(p.i, p); }

  leaderboard = s.lb || [];
  kills = s.kills || [];
  for (const e of leaderboard) {
    const w = worms.get(e.id);
    if (w) w.name = e.name;
  }
}

function onDied(by) {
  if (dead) return; // idempotent guard
  dead = true;
  document.body.classList.remove('playing');
  show($('room-pill'), false);
  $('death-by').textContent = (by && by !== 'the wall') ? `Killed by ${by}` : 'You hit the wall!';
  const len = hudLen || 10;
  $('death-stats').textContent = `Final length: ${len}`;
  show($('death'), true);
}

// ---------- input ----------
cv.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
});
cv.addEventListener('mousedown', () => { mouse.down = true; });
window.addEventListener('mouseup', () => { mouse.down = false; });
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceDown = false;
});
cv.addEventListener('contextmenu', (e) => e.preventDefault());

// touch support
cv.addEventListener('touchstart', (e) => {
  mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; mouse.down = true;
  e.preventDefault();
}, { passive: false });
cv.addEventListener('touchmove', (e) => {
  mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY;
  e.preventDefault();
}, { passive: false });
cv.addEventListener('touchend', () => { mouse.down = false; });

setInterval(() => {
  if (!ws || ws.readyState !== 1 || myId === null || dead) return;
  send({ t: 'input', dir: aimDir(), boost: (mouse.down || spaceDown), vr: viewRadius() });
}, 1000 / CFG.TICK_HZ);

// Current half-diagonal of the visible world area (world units), +margin.
function viewRadius() {
  const halfW = cv.clientWidth / 2 / Math.max(cam.zoom, 0.01);
  const halfH = cv.clientHeight / 2 / Math.max(cam.zoom, 0.01);
  return Math.sqrt(halfW * halfW + halfH * halfH) + 120;
}

function aimDir() {
  const dx = mouse.x - cv.clientWidth / 2;
  const dy = mouse.y - cv.clientHeight / 2;
  return Math.atan2(dy, dx);
}

// ack for delta tracking
setInterval(() => { if (ws && ws.readyState === 1) send({ t: 'ack', tick: lastSnapTick }); }, 500);

// ---------- game loop ----------
let lastFrame = performance.now();
let hudLen = 10;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(50, now - lastFrame) / 1000;
  lastFrame = now;
  fps = fps * 0.95 + (1 / Math.max(dt, 0.001)) * 0.05;

  updateCamera();
  pruneFarFood();
  updateHud();
  render(now);
  renderMinimap();
}

// Per-frame safety prune: drop food that provably can't be on screen (cam is
// always current here). Covers ghost food from missed delta packets. Only
// active while zoomed-in enough that far food truly isn't visible.
function pruneFarFood() {
  // Floor mirrors the server's min view clamp (900) so we never prune food
  // the server considers in-view and will never re-send.
  const vr = Math.max(900, viewRadius());
  if (vr >= 2200 || foods.size === 0) return;
  const lim = vr * 1.12;
  for (const [id, f] of foods) {
    const dx = f.x - cam.x, dy = f.y - cam.y;
    if (dx * dx + dy * dy > lim * lim) foods.delete(id);
  }
}

requestAnimationFrame(frame);

function updateCamera() {
  const target = worms.get(myId);
  if (target && !dead) {
    cam.x = target.x;
    cam.y = target.y;
  }
  const len = target ? target.len : hudLen;
  const r = 9 + 3.2 * Math.sqrt(Math.max(0, len - 10));
  const targetZoom = Math.max(0.35, Math.min(1.1, 42 / (r + 26)));
  cam.zoom += (targetZoom - cam.zoom) * 0.05;
}

function updateHud() {
  const me = worms.get(myId);
  if (me) hudLen = Math.floor(me.len);
  $('hud-len').textContent = hudLen;
  $('hud-players').textContent = `${worms.size}/${maxPlayers || '?'}`;
  const rank = leaderboard.findIndex((e) => e.id === myId) + 1;
  $('hud-rank').textContent = rank > 0 ? `#${rank}` : '–';
  const meEntry = leaderboard.find((e) => e.id === myId);
  $('hud-kills').textContent = meEntry ? meEntry.kills : 0;

  const ol = $('lb-list');
  ol.innerHTML = leaderboard.slice(0, 10).map((e, i) =>
    `<li${e.id === myId ? ' class="me"' : ''}><span>${i + 1}. ${escapeHtml(e.name)}</span><b>${e.score}</b></li>`
  ).join('');

  const feed = $('kill-feed');
  feed.innerHTML = kills.slice(-4).map((k) =>
    `<div class="feed-line">☠ ${escapeHtml(k.killerName)} ➜ ${escapeHtml(k.victimName)}</div>`
  ).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- rendering ----------
const ARENA_R = 3800;

function worldToScreen(x, y) {
  return [
    (x - cam.x) * cam.zoom + cv.width / (2 * devicePixelRatio) * devicePixelRatio,
    (y - cam.y) * cam.zoom + cv.height / (2 * devicePixelRatio) * devicePixelRatio,
  ];
}

function render(now) {
  const w = cv.width, h = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0b0e1a';
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const cw = w / devicePixelRatio, ch = h / devicePixelRatio;
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  // grid
  const gridStep = 120;
  const gx0 = Math.floor((cam.x - cw / 2 / cam.zoom) / gridStep) * gridStep;
  const gy0 = Math.floor((cam.y - ch / 2 / cam.zoom) / gridStep) * gridStep;
  const gx1 = cam.x + cw / 2 / cam.zoom, gy1 = cam.y + ch / 2 / cam.zoom;
  ctx.strokeStyle = 'rgba(80,100,160,0.12)';
  ctx.lineWidth = 1 / cam.zoom;
  ctx.beginPath();
  for (let gx = gx0; gx <= gx1; gx += gridStep) { ctx.moveTo(gx, gy0); ctx.lineTo(gx, gy1); }
  for (let gy = gy0; gy <= gy1; gy += gridStep) { ctx.moveTo(gx0, gy); ctx.lineTo(gx1, gy); }
  ctx.stroke();

  // arena border
  ctx.beginPath();
  ctx.arc(0, 0, ARENA_R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,80,80,0.5)';
  ctx.lineWidth = 10 / cam.zoom;
  ctx.stroke();

  // food
  for (const f of foods.values()) {
    ctx.fillStyle = `hsl(${f.h},90%,60%)`;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // pellets
  for (const p of pellets.values()) {
    ctx.fillStyle = `hsl(${p.h},85%,65%)`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // worms
  for (const w of worms.values()) {
    drawWorm(w, now);
  }

  ctx.restore();
}

function drawWorm(w, now) {
  const r = 9 + 3.2 * Math.sqrt(Math.max(0, w.len - 10));
  const h = w.history;
  if (h.length === 0) return;

  ctx.lineWidth = r * 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = w.protect ? `hsla(${w.hue},80%,60%,0.45)` : `hsl(${w.hue},80%,55%)`;

  // Body path: walk back from the head through history until we've laid out
  // len*PATH_PER_LEN units, then draw a smooth polyline.
  const need = w.len * 3;
  ctx.beginPath();
  ctx.moveTo(w.x, w.y);
  let drawn = 0;
  let px = w.x, py = w.y;
  for (let i = h.length - 1; i >= 0 && drawn < need; i--) {
    const p = h[i];
    const d = Math.hypot(p.x - px, p.y - py);
    if (d > 200) break; // history gap (respawn) — stop here
    ctx.lineTo(p.x, p.y);
    drawn += d;
    px = p.x; py = p.y;
  }
  if (drawn < 1) ctx.lineTo(w.x - Math.cos(w.dir) * r, w.y - Math.sin(w.dir) * r);
  ctx.stroke();

  // boosting glow
  if (w.boost) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = r * 2.3;
    ctx.beginPath();
    ctx.arc(w.x, w.y, r * 0.4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // eyes
  const hx = w.x, hy = w.y;
  ctx.fillStyle = '#fff';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(
      hx + Math.cos(w.dir) * r * 0.45 + Math.cos(w.dir + s * Math.PI / 2) * r * 0.5,
      hy + Math.sin(w.dir) * r * 0.45 + Math.sin(w.dir + s * Math.PI / 2) * r * 0.5,
      r * 0.3, 0, Math.PI * 2
    );
    ctx.fill();
  }
  ctx.fillStyle = '#111';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(
      hx + Math.cos(w.dir) * r * 0.6 + Math.cos(w.dir + s * Math.PI / 2) * r * 0.5,
      hy + Math.sin(w.dir) * r * 0.6 + Math.sin(w.dir + s * Math.PI / 2) * r * 0.5,
      r * 0.14, 0, Math.PI * 2
    );
    ctx.fill();
  }

  // name
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `${13 / cam.zoom}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(w.id === myId ? 'You' : w.name || `W${w.id}`, hx, hy - r - 8 / cam.zoom);
}

function renderMinimap() {
  const s = mmCv.width;
  mmCtx.clearRect(0, 0, s, s);
  mmCtx.fillStyle = 'rgba(10,14,26,0.75)';
  mmCtx.beginPath();
  mmCtx.arc(s / 2, s / 2, s / 2 - 2, 0, Math.PI * 2);
  mmCtx.fill();
  const scale = (s / 2 - 4) / ARENA_R;
  for (const w of worms.values()) {
    const isMe = w.id === myId;
    mmCtx.fillStyle = isMe ? '#ffffff' : `hsl(${w.hue},80%,55%)`;
    mmCtx.beginPath();
    mmCtx.arc(s / 2 + w.x * scale, s / 2 + w.y * scale, isMe ? 3.5 : 2.5, 0, Math.PI * 2);
    mmCtx.fill();
  }
}

// ---------- room code copy ----------
$('room-pill').addEventListener('click', () => {
  const code = $('room-code').textContent;
  const done = () => {
    $('room-pill').classList.add('copied');
    $('room-pill').querySelector('.pill-hint').textContent = 'copied!';
    setTimeout(() => {
      $('room-pill').classList.remove('copied');
      $('room-pill').querySelector('.pill-hint').textContent = 'click to copy';
    }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(() => done());
  } else { done(); }
});

// ---------- death screen buttons ----------
$('btn-respawn').addEventListener('click', () => {
  show($('death'), false);
  dead = false;
  document.body.classList.add('playing');
  show($('room-pill'), true);
  send({ t: 'respawn', name: $('join-name').value.trim() || $('host-name').value.trim() || 'Player', skin: 0 });
});
$('btn-lobby').addEventListener('click', () => {
  show($('death'), false);
  show($('lobby'), true);
  show($('hud'), false);
  show($('room-pill'), false);
  document.body.classList.remove('playing');
  myId = null;
  worms.clear(); foods.clear(); pellets.clear();
  try { if (ws) ws.close(); } catch (e) {}
});
