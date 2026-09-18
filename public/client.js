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

// Capped DPR: full devicePixelRatio on hi-dpi screens = 4x pixel fill = lag.
let DPR = Math.min(window.devicePixelRatio || 1, 1.5);
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  cv.width = window.innerWidth * DPR;
  cv.height = window.innerHeight * DPR;
  cv.style.width = window.innerWidth + 'px';
  cv.style.height = window.innerHeight + 'px';
}
window.addEventListener('resize', resize);
resize();

// ---------- lobby UI ----------
function show(el, on) { el.classList.toggle('hidden', !on); }

// Selected snake color (hue 0-359), persisted locally
let myHue = parseInt(localStorage.getItem('wa_hue') || '130', 10);
if (!Number.isFinite(myHue)) myHue = 130;

const SWATCH_HUES = [0, 25, 45, 130, 160, 200, 230, 280, 320, 350, 90, 55];

function buildSwatches() {
  const wrap = $('color-swatches');
  wrap.innerHTML = '';
  for (const h of SWATCH_HUES) {
    const b = document.createElement('button');
    b.className = 'swatch' + (h === myHue ? ' sel' : '');
    b.style.background = `hsl(${h},85%,55%)`;
    b.dataset.hue = h;
    b.addEventListener('click', () => {
      myHue = h;
      localStorage.setItem('wa_hue', String(myHue));
      $('hue-slider').value = h;
      $('hue-val').textContent = h;
      buildSwatches();
      drawPreview();
    });
    wrap.appendChild(b);
  }
}

// Animated worm preview in the inventory card
function drawPreview() {
  const c = $('snake-preview');
  const x2 = c.getContext('2d');
  const W = c.width, H = c.height;
  x2.clearRect(0, 0, W, H);
  const r = 16;
  const pts = [];
  const t = performance.now() / 600;
  for (let i = 0; i < 14; i++) {
    pts.push([W * 0.82 - i * 20, H / 2 + Math.sin(t + i * 0.55) * 14]);
  }
  const stroke = (ptsArr, w, col) => {
    x2.lineCap = 'round'; x2.lineJoin = 'round';
    x2.strokeStyle = col; x2.lineWidth = w;
    x2.beginPath();
    x2.moveTo(ptsArr[0][0], ptsArr[0][1]);
    for (let i = 1; i < ptsArr.length; i++) x2.lineTo(ptsArr[i][0], ptsArr[i][1]);
    x2.stroke();
  };
  stroke(pts, r * 2 + 4, `hsla(${myHue},70%,18%,0.95)`);
  stroke(pts, r * 2, `hsl(${myHue},85%,60%)`);
  x2.save();
  x2.translate(0, -r * 0.42);
  stroke(pts, r * 0.75, `hsla(${myHue},95%,80%,0.4)`);
  x2.restore();
  // eyes on the head
  const dir = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]);
  for (const s of [-1, 1]) {
    const ex = pts[0][0] + Math.cos(dir) * 4 + Math.cos(dir + s * Math.PI / 2) * r * 0.5;
    const ey = pts[0][1] + Math.sin(dir) * 4 + Math.sin(dir + s * Math.PI / 2) * r * 0.5;
    x2.fillStyle = '#fff';
    x2.beginPath(); x2.arc(ex, ey, r * 0.34, 0, Math.PI * 2); x2.fill();
    x2.fillStyle = '#101018';
    x2.beginPath(); x2.arc(ex, ey, r * 0.17, 0, Math.PI * 2); x2.fill();
  }
}

// Coming-soon toast
let soonTimer = null;
function soonToast(name) {
  let el = document.getElementById('soon-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'soon-toast';
    document.body.appendChild(el);
  }
  el.textContent = `🔒 ${name} — Coming soon!`;
  el.classList.add('show');
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// Bottom nav + hero menu wiring — EVENT DELEGATION (single listener, never
// depends on per-button attach order; robust against load timing)
function initLobby() {
  buildSwatches();
  $('hue-slider').value = myHue;
  $('hue-val').textContent = myHue;
  $('lb-pname').textContent = localStorage.getItem('wa_name') || 'Player';

  const previewLoop = () => {
    if (!$('inventory').classList.contains('hidden')) drawPreview();
    requestAnimationFrame(previewLoop);
  };
  requestAnimationFrame(previewLoop);
}
initLobby();

// One delegated click handler for ALL lobby interactions
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const id = t.id;
  if (t.classList.contains('swatch')) {
    myHue = parseInt(t.dataset.hue, 10);
    localStorage.setItem('wa_hue', String(myHue));
    $('hue-slider').value = myHue;
    $('hue-val').textContent = myHue;
    buildSwatches();
    drawPreview();
    return;
  }
  switch (id) {
    case 'nav-inventory':
      show($('inventory'), true);
      document.querySelectorAll('.lb-nav-btn').forEach((b) => b.classList.remove('active'));
      t.classList.add('active');
      break;
    case 'inv-close':
      show($('inventory'), false);
      document.querySelectorAll('.lb-nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelector('.lb-nav-btn[data-nav=home]').classList.add('active');
      break;
    case 'lb-play':
      $('host-name').value = localStorage.getItem('wa_name') || 'Player';
      $('host-max').value = '10';
      hostGame();
      break;
    case 'lb-create':
      show($('lb-hostform'), true);
      show($('lb-joinform'), false);
      $('host-name').focus();
      break;
    case 'lb-join':
      show($('lb-joinform'), true);
      show($('lb-hostform'), false);
      $('join-name').focus();
      break;
    default:
      if (t.dataset && t.dataset.soon) soonToast(t.dataset.soon);
      break;
  }
});

// Delegated slider input
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'hue-slider') {
    myHue = parseInt(e.target.value, 10);
    $('hue-val').textContent = myHue;
    localStorage.setItem('wa_hue', String(myHue));
    buildSwatches();
    drawPreview();
  }
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
  localStorage.setItem('wa_name', name);
  const max = Math.max(2, Math.min(50, parseInt($('host-max').value, 10) || 10));
  $('lobby-status').textContent = 'Connecting…';
  try {
    await connect();
    ws.onmessage = onMessage;
    send({ t: 'create', name, maxPlayers: max, skin: 0, hue: myHue });
  } catch (e) {
    $('lobby-status').textContent = e.message;
  }
}

async function joinGame() {
  const name = $('join-name').value.trim() || 'Player';
  localStorage.setItem('wa_name', name);
  const code = $('join-code').value.trim();
  if (!/^\d{6}$/.test(code)) {
    $('lobby-status').textContent = 'Room code 6 digits ka hona chahiye.';
    return;
  }
  $('lobby-status').textContent = 'Connecting…';
  try {
    await connect();
    ws.onmessage = onMessage;
    send({ t: 'join', name, code, skin: 0, hue: myHue });
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
      show($('inventory'), false);
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

// touch detection + mobile joystick steering
const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
if (isTouch) document.body.classList.add('touch');

let joyDir = null;      // last joystick heading (rad); persists when finger lifts
let touchBoost = false;
let joyTouchId = null;  // identifier of the finger controlling the stick

if (isTouch) {
  document.body.classList.add('touch');
  // CRITICAL: the #joy div ships with class="hidden" (.hidden = display:none
  // !important) which would permanently beat the body.playing.touch CSS rule.
  // Remove it once — CSS gates visibility from here on.
  $('joy').classList.remove('hidden');
  const joyEl = $('joy');
  const base = $('joy-base');
  const stick = $('joy-stick');
  const MAX_R = 44;

  function joyHandle(t) {
    joyTouchId = t.identifier;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    let dx = t.clientX - cx, dy = t.clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > MAX_R) { dx = dx / d * MAX_R; dy = dy / d * MAX_R; }
    stick.style.transform = `translate(${dx}px, ${dy}px)`;
    if (Math.hypot(dx, dy) > 8) joyDir = Math.atan2(dy, dx);
  }
  base.addEventListener('touchstart', (e) => { joyHandle(e.changedTouches[0]); e.preventDefault(); }, { passive: false });
  base.addEventListener('touchmove', (e) => {
    // Use the touch that STARTED on the base (changedTouches), not touches[0] —
    // otherwise pressing BOOST with a second finger yanks the stick.
    for (const t of e.changedTouches) { if (joyTouchId !== null && t.identifier === joyTouchId) joyHandle(t); }
    e.preventDefault();
  }, { passive: false });
  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (joyTouchId !== null && t.identifier === joyTouchId) {
        joyTouchId = null;
        stick.style.transform = 'translate(0,0)'; // finger lifted: keep last heading
      }
    }
  };
  base.addEventListener('touchend', endTouch);
  base.addEventListener('touchcancel', endTouch);

  const boostBtn = $('joy-boost');
  boostBtn.addEventListener('touchstart', (e) => { touchBoost = true; boostBtn.classList.add('on'); e.preventDefault(); }, { passive: false });
  const endBoost = () => { touchBoost = false; boostBtn.classList.remove('on'); };
  boostBtn.addEventListener('touchend', endBoost);
  boostBtn.addEventListener('touchcancel', endBoost);
}

setInterval(() => {
  if (!ws || ws.readyState !== 1 || myId === null || dead) return;
  const dir = (isTouch && joyDir !== null) ? joyDir : aimDir();
  send({ t: 'input', dir, boost: (mouse.down || spaceDown || touchBoost), vr: viewRadius() });
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

// Mirror of server radiusAt() (src/game/worm.js) — keep in sync!
function radiusAt(len) {
  const SOFT = 240, K1 = 3.2, K2 = 0.22;
  const over = Math.max(0, len - 10);
  if (over <= SOFT) return 9 + K1 * Math.sqrt(over);
  const base = 9 + K1 * Math.sqrt(SOFT);
  return base + K2 * Math.log1p((over - SOFT) / 40);
}

function updateCamera() {
  const target = worms.get(myId);
  if (target && !dead) {
    cam.x = target.x;
    cam.y = target.y;
  }
  const len = target ? target.len : hudLen;
  const r = radiusAt(len);
  const targetZoom = Math.max(0.35, Math.min(1.1, 42 / (r + 26)));
  cam.zoom += (targetZoom - cam.zoom) * 0.05;
}

function updateHud() {
  const me = worms.get(myId);
  if (me) hudLen = Math.floor(me.len);
  const meEntry = leaderboard.find((e) => e.id === myId);
  $('hud-kills').textContent = meEntry ? meEntry.kills : 0;

  // PERF: rebuild DOM only when content actually changed — per-frame innerHTML
  // writes were the #1 stutter source (layout thrash at 60fps).
  const ol = $('lb-list');
  const lbKey = leaderboard.slice(0, 10).map((e) => `${e.id},${e.score}`).join('|');
  if (lbKey !== lastLbKey) {
    lastLbKey = lbKey;
    ol.innerHTML = leaderboard.slice(0, 10).map((e, i) =>
      `<li${e.id === myId ? ' class="me"' : ''}><span>${i + 1}. ${escapeHtml(e.name)}</span><b>${e.score}</b></li>`
    ).join('');
  }

  const feed = $('kill-feed');
  const feedKey = kills.map((k) => `${k.killerName}>${k.victimName}`).join('|');
  if (feedKey !== lastFeedKey) {
    lastFeedKey = feedKey;
    feed.innerHTML = kills.slice(-4).map((k) =>
      `<div class="feed-line">☠ ${escapeHtml(k.killerName)} ➜ ${escapeHtml(k.victimName)}</div>`
    ).join('');
  }
}
let lastLbKey = '', lastFeedKey = '';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- rendering ----------
const ARENA_R = 3800;

function worldToScreen(x, y) {
  return [
    (x - cam.x) * cam.zoom + cv.width / 2,
    (y - cam.y) * cam.zoom + cv.height / 2,
  ];
}

function render(now) {
  const w = cv.width, h = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0b0e1a';
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const cw = w / DPR, ch = h / DPR;
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

  // food — EMOJI fruits from a SPRITE CACHE: each emoji is rendered to an
  // offscreen canvas once, then blitted. Setting ctx.font + fillText for every
  // food every frame was the #2 lag source (font parse ~hundreds/frame).
  // Off-screen items are culled cheaply.
  const halfW = cw / 2 / cam.zoom + 60, halfH = ch / 2 / cam.zoom + 60;
  const camL = cam.x - halfW, camR = cam.x + halfW, camT = cam.y - halfH, camB = cam.y + halfH;
  const tSec = now / 1000;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const f of foods.values()) {
    if (f.x < camL || f.x > camR || f.y < camT || f.y > camB) continue;
    const pulse = 1 + 0.1 * Math.sin(tSec * 2.2 + f.i % 10);
    const r = f.r * pulse;
    const em = (f.v >= 5) ? '\u2B50' : FOOD_EMOJIS[f.i % FOOD_EMOJIS.length];
    const s = r * 2.6;
    ctx.drawImage(emojiSprite(em), f.x - s / 2, f.y - s / 2, s, s);
  }

  // pellets — death drops: emoji only, no glow
  for (const p of pellets.values()) {
    if (p.x < camL || p.x > camR || p.y < camT || p.y > camB) continue;
    const em = PELLET_EMOJI[p.i % PELLET_EMOJI.length];
    const s = p.r * 2.4;
    ctx.drawImage(emojiSprite(em), p.x - s / 2, p.y - s / 2, s, s);
  }

  // worms — cull off-screen bodies (minimap still shows them)
  for (const w of worms.values()) {
    const wr = radiusAt(w.len) + 40;
    if (w.id !== myId && (w.x < camL - wr || w.x > camR + wr || w.y < camT - wr || w.y > camB + wr)) continue;
    drawWorm(w, now);
  }

  ctx.restore();
}

// Stroke a polyline through pts ([[x,y],...]) using current stroke settings.
function strokePath(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

function drawWorm(w, now) {
  const r = radiusAt(w.len);
  const h = w.history;
  if (h.length === 0) return;

  // Build the visible body polyline once (head -> tail)
  const need = w.len * 3;
  const pts = [[w.x, w.y]];
  let drawn = 0;
  let px = w.x, py = w.y;
  for (let i = h.length - 1; i >= 0 && drawn < need; i--) {
    const p = h[i];
    const d = Math.hypot(p.x - px, p.y - py);
    if (d > 200) break; // history gap (respawn) — stop here
    pts.push([p.x, p.y]);
    drawn += d;
    px = p.x; py = p.y;
  }
  if (pts.length < 2) pts.push([w.x - Math.cos(w.dir) * r, w.y - Math.sin(w.dir) * r]);

  const boostGlow = w.boost ? 1 : 0;

  // Layer 1: dark outline (slightly wider) for separation from background
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = w.protect ? `hsla(${w.hue},80%,60%,0.45)` : `hsla(${w.hue},70%,18%,0.9)`;
  ctx.lineWidth = r * 2 + 5;
  strokePath(pts);

  // Layer 2: main body (bright core color)
  ctx.strokeStyle = w.protect ? `hsla(${w.hue},80%,60%,0.5)` : `hsl(${w.hue},85%,60%)`;
  ctx.lineWidth = r * 2;
  strokePath(pts);

  // Layer 3: highlight stripe along the top edge — gives a round, lit look.
  // Offset the same path toward the head direction's left by ~35% of radius.
  if (!w.protect) {
    ctx.strokeStyle = `hsla(${w.hue},95%,78%,0.35)`;
    ctx.lineWidth = r * 0.8;
    const off = r * 0.45;
    ctx.save();
    ctx.translate(Math.cos(w.dir - Math.PI / 2) * off, Math.sin(w.dir - Math.PI / 2) * off);
    strokePath(pts);
    ctx.restore();
  }

  // Boost trail: fading circles at the tail while boosting
  if (boostGlow && pts.length > 2) {
    for (let k = 1; k <= 3; k++) {
      const idx = Math.max(0, Math.min(pts.length - 1, pts.length - 1 - k * 4));
      const [tx, ty] = pts[idx];
      ctx.fillStyle = `hsla(${w.hue},95%,70%,${0.22 / k})`;
      ctx.beginPath();
      ctx.arc(tx, ty, r * (1.1 + k * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Eyes: white sclera + colored iris + dark pupil (looks alive)
  const hx = w.x, hy = w.y;
  for (const s of [-1, 1]) {
    const ex = hx + Math.cos(w.dir) * r * 0.45 + Math.cos(w.dir + s * Math.PI / 2) * r * 0.5;
    const ey = hy + Math.sin(w.dir) * r * 0.45 + Math.sin(w.dir + s * Math.PI / 2) * r * 0.5;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(ex, ey, r * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsl(${(w.hue + 40) % 360},90%,45%)`;
    ctx.beginPath();
    ctx.arc(ex + Math.cos(w.dir) * r * 0.1, ey + Math.sin(w.dir) * r * 0.1, r * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#101018';
    ctx.beginPath();
    ctx.arc(ex + Math.cos(w.dir) * r * 0.14, ey + Math.sin(w.dir) * r * 0.14, r * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // Spawn protection shimmer ring
  if (w.protect) {
    ctx.strokeStyle = `hsla(${w.hue},90%,75%,${0.5 + 0.3 * Math.sin(now / 120)})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(hx, hy, r + 9, 0, Math.PI * 2);
    ctx.stroke();
  }

  // name
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `${13 / cam.zoom}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(w.id === myId ? 'You' : w.name || `W${w.id}`, hx, hy - r - 8 / cam.zoom);
}

// Food emojis cycled by food id (server sends i, x, y, r, v, h per item)
const FOOD_EMOJIS = ['\uD83C\uDF4E', '\uD83C\uDF4A', '\uD83C\uDF4B', '\uD83C\uDF4F', '\uD83C\uDF47', '\uD83C\uDF53', '\uD83C\uDF52', '\uD83C\uDF51', '\uD83E\uDD5D', '\uD83C\uDF49'];
const PELLET_EMOJI = ['\uD83E\uDD69', '\uD83C\uDF67', '\uD83C\uDF6A'];

// PERF: emoji sprite cache — render each emoji ONCE to an offscreen canvas,
// then drawImage() every frame (GPU blit, no font parsing).
const emojiCache = new Map();
function emojiSprite(em) {
  let c = emojiCache.get(em);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = 72; c.height = 72;
  const g = c.getContext('2d');
  g.font = '58px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(em, 36, 39);
  emojiCache.set(em, c);
  return c;
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
  send({ t: 'respawn', name: $('join-name').value.trim() || $('host-name').value.trim() || 'Player', skin: 0, hue: myHue });
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
