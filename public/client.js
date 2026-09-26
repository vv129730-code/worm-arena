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

// Interpolation: server sends ~20 snapshots/sec, we render at 60fps. Each worm
// keeps a from->to segment (in local perf time) that we smoothly traverse —
// removes the every-3rd-frame "teleport" stutter completely.
const INTERP_MS = 55;             // half the snapshot period — smooth, still responsive
let snapPeriodMs = 50;            // EMA of measured inter-snapshot gap
let lastSnapPerfAt = 0;
let selfMissingSince = 0; // death-watchdog: when my worm first vanished from snapshots

// Preallocated polyline buffer for worm bodies — zero per-frame allocation,
// no GC pauses mid-game.
const PTS_MAX = 2048;
const ptsX = new Float64Array(PTS_MAX);
const ptsY = new Float64Array(PTS_MAX);
let ptsN = 0;

// Cached DOM handles — per-frame getElementById calls are wasteful
const elHudKills = $('hud-kills');
const elLbList = $('lb-list');
const elKillFeed = $('kill-feed');

// Capped DPR: full devicePixelRatio on hi-dpi screens = 4x pixel fill = lag.
// The perf governor may force DPR 1.0 on weak devices (perfStep calls resize).
let DPR = Math.min(window.devicePixelRatio || 1, 1.5);
let forcedDpr = 0; // 0 = auto, otherwise governor-set DPR
// Declared BEFORE resize() — resize runs at load time and mutates these
// (a later `let` would be a temporal-dead-zone ReferenceError).
let bgCanvas = null;
let camPendDirty = true, _vrCache = 1200, _vrKey = '';
function resize(forceDpr) {
  if (forceDpr !== undefined) forcedDpr = forceDpr;
  DPR = forcedDpr || Math.min(window.devicePixelRatio || 1, 1.5);
  cv.width = window.innerWidth * DPR;
  cv.height = window.innerHeight * DPR;
  cv.style.width = window.innerWidth + 'px';
  cv.style.height = window.innerHeight + 'px';
  bgCanvas = null; // backdrop must re-bake at the new resolution
  camPendDirty = true;
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
      // QUICK MATCH: server public room me match karega (jo bhi us waqt play
      // kar rahe hain unke saath) — private rooms kabhi nahi.
      quickMatch();
      break;
    case 'lb-create':
      show($('lb-hostform'), true);
      show($('lb-joinform'), false);
      break;
    case 'lb-join':
      show($('lb-joinform'), true);
      show($('lb-hostform'), false);
      $('join-code').focus();
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
    // Stale-socket guard: agar purana connection abhi khula hai, use close
    // karke uska onclose fire hone do — warna dobara PLAY karne par purana
    // close handler naye session ka 'playing' class ura deta hai.
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
    const sock = new WebSocket(`${proto}//${location.host}`);
    ws = sock;
    sock.onopen = () => resolve();
    sock.onerror = () => reject(new Error('Connection failed'));
    sock.onclose = () => {
      // Stale socket ka close ignore karo (current ws ab sock nahi hai)
      if (ws !== sock) return;
      ws = null;
      // Only treat as a disconnect if we're not already on the death/lobby screen
      if (!dead && myId !== null) {
        $('lobby-status').textContent = 'Disconnected from server.';
        document.body.classList.remove('playing');
        show($('lobby'), true);
        show($('hud'), false);
        show($('death'), false);
      }
    };
  });
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Shared player name (single field drives quick play / create / join / respawn)
function playerName() {
  const n = $('player-name').value.trim() || localStorage.getItem('wa_name') || 'Player';
  localStorage.setItem('wa_name', n);
  return n;
}

async function quickMatch() {
  $('lobby-status').textContent = 'Finding players…';
  try {
    await connect();
    ws.onmessage = onMessage;
    send({ t: 'quick', name: playerName(), skin: 0, hue: myHue, maxPlayers: 10 });
  } catch (e) {
    $('lobby-status').textContent = e.message;
  }
}

async function hostGame() {
  const name = playerName();
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
  const name = playerName();
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
      portraitHintDone = false; // fresh session — hint may show again if needed
      document.body.classList.add('playing');
      show($('lobby'), false);
      show($('inventory'), false);
      show($('hud'), true);
      show($('death'), false);
      show($('room-pill'), true);
      $('room-code').textContent = roomCode;
      $('room-kind').textContent = msg.isPrivate ? 'PRIVATE' : 'QUICK';
      $('lobby-status').textContent = '';
      break;
    case 'error':
      $('lobby-status').textContent = msg.msg;
      $('death-stats').textContent = msg.msg;
      try { ws.close(); } catch (e) {}
      break;
    case 'closed':
      // Room was GC'd server-side (everyone dead/idle too long). Drop the
      // player back to the lobby instead of leaving them on a frozen screen.
      $('lobby-status').textContent = 'Room closed — everyone left the arena.';
      try { ws.close(); } catch (e) {}
      break;
    case 'snap':
      applySnapshot(msg);
      updateHud(); // HUD is event-driven now (was per-frame)
      break;
    case 'died':
      onDied(msg.by);
      break;
    case 'chat':
      // SYSTEM join/leave lines go to the kill-feed area (same slot, fades via key-change)
      addKillFeed(msg.name === 'SYSTEM' ? `⚡ ${msg.text}` : `${msg.name}: ${msg.text}`);
      break;
    case 'pong':
      break;
  }
}

function applySnapshot(s) {
  lastSnapTick = s.tick;
  serverTimeOffset = s.time - performance.now();

  // CLIENT-SIDE DEATH WATCHDOG: the server deletes dead worms from the room.
  // If MY worm vanishes from snapshots while I still think I'm alive (the
  // single 'died' message was lost/throttled), mark myself dead after 1.5s
  // instead of freezing on a zombie screen forever.
  if (!dead && myId !== null) {
    const present = s.worms.some((row) => row[0] === myId);
    if (!present) {
      if (!selfMissingSince) selfMissingSince = performance.now();
      else if (performance.now() - selfMissingSince > 1500) {
        selfMissingSince = 0;
        onDied('the arena');
      }
    } else {
      selfMissingSince = 0;
    }
  }

  // Measure the real snapshot cadence (EMA) — drives the interpolator.
  const nowP = performance.now();
  if (lastSnapPerfAt) {
    const gap = Math.min(400, Math.max(10, nowP - lastSnapPerfAt));
    snapPeriodMs = snapPeriodMs * 0.8 + gap * 0.2;
  }
  lastSnapPerfAt = nowP;

  // worms — head updates arrive at NET_HZ; we record a position history so the
  // client can rebuild each worm's body path (server only sends the head).
  const seen = new Set();
  for (const row of s.worms) {
    const [id, hue, skin, x, y, dir, len, boost, protect] = row;
    seen.add(id);
    let w = worms.get(id);
    if (!w) {
      w = {
        id, hue, skin, x, y, dir, len, boost, protect, history: [],
        // interpolation segment (new worms start parked on their spawn point)
        fx: x, fy: y, tx: x, ty: y, fd: dir, td: dir, segAt: nowP, segAlpha: 1,
      };
      worms.set(id, w);
    } else {
      // Slide the segment: the position we're currently displaying becomes the
      // new origin, so motion stays continuous even with jitter/missed packets.
      wormInterp(w, nowP);
      w.fx = _ix; w.fy = _iy;
      w.fd = angleLerp(w.fd, w.td, w.segAlpha);
      w.tx = x; w.ty = y; w.td = dir;
      w.segAt = nowP; w.segAlpha = 0;
      // keep raw server position fresh too — minimap, watchdogs and HUD read
      // w.x/w.y directly (rendering uses the interpolated fx/fy instead)
      w.x = x; w.y = y;
      w.len = len; w.boost = boost; w.protect = protect;
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
  youKills = s.youKills | 0;
  // stamp arrival time on kill-feed entries so updateHud can expire them (3s)
  if (s.kills && s.kills.length) {
    const prevIds = new Set(kills.map((k) => k.tick + ':' + k.victimName));
    for (const k of s.kills) {
      const key = k.tick + ':' + k.victimName;
      if (!prevIds.has(key) && !k.at) k.at = Date.now();
    }
  }
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

// ---------- mobile: fullscreen + landscape lock ----------
// Browsers fullscreen aur screen.orientation.lock() ko sirf user-gesture ke
// andar allow karte hain — page load pe automatically nahi ho sakta. Isliye
// FIRST touch/click anywhere (site kholte hi) + PLAY/CREATE/JOIN/RESPAWN taps
// pe trigger karte hain — game start hone tak landscape already locked.
let lockTries = 0;
function tryOrientationLock() {
  const so = screen.orientation;
  if (so && so.lock) {
    // lock() ko fullscreen settle hone ke baad call karna padta hai — short
    // delay, plus a second retry (some browsers drop the first attempt).
    setTimeout(() => {
      try { const p = so.lock('landscape'); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }, 120);
    if (lockTries++ < 3) setTimeout(() => {
      try { const p = so.lock('landscape'); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }, 600);
  }
}
function goFullscreenLandscape() {
  if (!isTouch) return;
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.webkitRequestFullScreen;
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  if (req && !active) {
    try {
      const p = req.call(root, { navigationUI: 'hide' });
      if (p && p.then) p.then(tryOrientationLock).catch(tryOrientationLock);
      else tryOrientationLock();
    } catch (e) { tryOrientationLock(); }
  } else {
    tryOrientationLock();
  }
}
if (isTouch) {
  // FIRST interaction anywhere on the site (lobby hi kafi hai) — not just PLAY
  document.addEventListener('touchstart', goFullscreenLandscape, { once: true, passive: true });
  document.addEventListener('click', goFullscreenLandscape, { once: true });
  // Re-assert when returning to the tab / rotating (best-effort, harmless if denied)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) goFullscreenLandscape(); });
  addEventListener('orientationchange', () => setTimeout(goFullscreenLandscape, 300));
  for (const id of ['lb-play', 'lb-create', 'lb-join', 'btn-respawn']) {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', goFullscreenLandscape);
  }
}

// Portrait hint — NON-BLOCKING: landscape+fullscreen is now forced on the
// very first touch, so a permanent blocker mid-game is just a nag. If the
// device somehow is still portrait while playing (iPhone Safari etc.), show
// a small hint ONCE for 2.5s — never interrupt the actual gameplay.
let portraitHintDone = false;
let portraitHintTimer = null;
function updatePortraitHint() {
  if (!isTouch) return;
  const portrait = innerHeight > innerWidth;
  if (!portrait) { show($('portrait-overlay'), false); return; }
  const playing = document.body.classList.contains('playing') && !dead;
  if (playing && !portraitHintDone) {
    portraitHintDone = true;
    show($('portrait-overlay'), true);
    clearTimeout(portraitHintTimer);
    portraitHintTimer = setTimeout(() => show($('portrait-overlay'), false), 2500);
  }
}
if (isTouch) {
  addEventListener('resize', updatePortraitHint);
  addEventListener('orientationchange', updatePortraitHint);
  setInterval(updatePortraitHint, 1000);
}

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

// Where the player is POINTING (mouse on desktop, joystick on touch) — eyes
// track this. Falls back to movement dir when no input yet this session.
function eyeDir() {
  if (isTouch && joyDir !== null) return joyDir;
  if (mouse.x || mouse.y) return aimDir();
  return null;
}

// ack for delta tracking
setInterval(() => { if (ws && ws.readyState === 1) send({ t: 'ack', tick: lastSnapTick }); }, 500);

// STALE-CONNECTION WATCHDOG: preview webviews/background tabs can freeze a
// WebSocket's RECEIVE path while readyState still says OPEN (send works,
// nothing comes back). If we're playing and no snapshot arrives for 4s,
// hard-reconnect — a healthy server sends 20 snaps/sec, so 4s = dead line.
setInterval(() => {
  if (dead || myId === null || !ws || ws.readyState !== 1) return;
  if (performance.now() - lastSnapPerfAt > 1500 && lastSnapPerfAt > 0) {
    try { ws.onclose = null; ws.close(); } catch (e) {}
    ws = null;
    reconnectAndResume();
  }
}, 1500);

// Reconnect into the SAME room and auto-respawn (keeps room code, name, hue)
async function reconnectAndResume() {
  try {
    await connect();
    ws.onmessage = onMessage;
    send({ t: 'join', name: playerName(), code: roomCode, skin: 0, hue: myHue });
    // server may GC the room while we were disconnected — welcome/error will tell
  } catch (e) {
    $('lobby-status').textContent = 'Reconnect failed — back to lobby.';
    document.body.classList.remove('playing');
    show($('lobby'), true);
    show($('hud'), false);
  }
}

// ---------- game loop ----------
let lastFrame = performance.now();
let hudLen = 10;
let frameCount = 0;
let nowFrame = lastFrame; // shared per-frame clock — wormInterp/drawWorm read this

// ---------- PERFORMANCE GOVERNOR ----------
// Measures real frame time (EMA). Sustained slow frames => drop expensive
// render layers + reduce DPR; when fast again, restore quality. This is what
// keeps weak phones at a rock-steady fps instead of periodic stutter.
const perf = {
  ema: 16.7,       // ms per frame, exponential moving average
  mode: 1,         // 2 = full quality, 1 = reduced, 0 = minimal (survival)
  lastSwitch: 0,
};
function perfStep(now) {
  const dt = now - lastFrame;
  if (dt > 0 && dt < 250) perf.ema += (dt - perf.ema) * 0.05;
  if (now - perf.lastSwitch < 1500) return; // let each mode settle before judging
  if (perf.ema > 24 && perf.mode > 0) {          // < ~40fps sustained
    perf.mode--;
    perf.lastSwitch = now;
    if (perf.mode === 1) resize(1.0);            // drop DPR first (biggest win)
  } else if (perf.ema < 17.5 && perf.mode < 2) { // comfortably at 60fps again
    perf.mode++;
    perf.lastSwitch = now;
    if (perf.mode === 2) resize();               // restore DPR
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  lastFrame = now;
  nowFrame = now;
  frameCount++;

  perfStep(now);
  updateCamera();
  // Housekeeping runs on a schedule, not per frame — pruneFarFood walks a
  // ~2600-entry Map and viewRadius() does two divides + a sqrt.
  if (frameCount % 8 === 0) { pruneFarFood(); camPendDirty = true; }
  render(now);
  if (frameCount % 6 === 0) renderMinimap(); // 10Hz is plenty for a minimap
  // HUD updates are EVENT-DRIVEN (updateHud is called from applySnapshot and
  // the expiry timers) — per-frame leaderboard string building is gone.
}
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

// Housekeeping throttle: pruneFarFood (a ~2600-entry Map walk) twice a
// second is invisible — per-frame was wasteful.
setInterval(() => { if (!document.hidden) { pruneFarFood(); camPendDirty = true; } }, 500);

// Hybrid loop: rAF for smooth 60fps, PLUS a 4Hz setInterval backstop that
// keeps rendering when the tab is throttled/backgrounded. rAF stops firing in
// background tabs — without the backstop the minimap (and everything else)
// freezes until the tab is foregrounded again. Double-draw is harmless.
setInterval(() => { if (document.hidden) frame(performance.now()); }, 250);
requestAnimationFrame(frame);
function radiusAt(len) {
  const SOFT = 240, K1 = 3.2, K2 = 0.22;
  const over = Math.max(0, len - 10);
  if (over <= SOFT) return 9 + K1 * Math.sqrt(over);
  const base = 9 + K1 * Math.sqrt(SOFT);
  return base + K2 * Math.log1p((over - SOFT) / 40);
}

// Smoothly traverse a worm's current from->to segment (60fps motion from
// 20Hz snapshots). Slight overshoot (1.25x) keeps giants gliding if a
// snapshot arrives late. Stores segAlpha for angle blending.
// PERF: writes into shared scratch vars (_ix/_iy) instead of allocating a
// [x,y] array per call — this runs ~5x per worm per frame (body, camera,
// minimap) and was a major GC churn source at 60fps.
let _ix = 0, _iy = 0;
function wormInterp(w, now) {
  const t = (now - w.segAt) / Math.max(snapPeriodMs, 20);
  const a = t < 0 ? 0 : t > 1.25 ? 1.25 : t;
  w.segAlpha = a;
  _ix = w.fx + (w.tx - w.fx) * a;
  _iy = w.fy + (w.ty - w.fy) * a;
  return a;
}

// Shortest-arc angle interpolation (no 350°->0° spins)
function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (t > 1 ? 1 : t);
}

function updateCamera() {
  const target = worms.get(myId);
  if (target && !dead) {
    // Camera rides the INTERPOLATED head — buttery pan, no 20Hz snapping.
    wormInterp(target, nowFrame);
    cam.x = _ix;
    cam.y = _iy;
  }
  const len = target ? target.len : hudLen;
  const r = radiusAt(len);
  const targetZoom = Math.max(0.35, Math.min(1.1, 42 / (r + 26)));
  // PERF: cache the raw target zoom; the exponential smoothing is applied in
  // render() using the real frame delta so speed is frame-rate independent.
  cam.targetZoom = targetZoom;
  return r;
}

// Cache of radiusAt(len) — same (len) must map to the same radius within one
// frame; drawWorm previously recomputed it per worm per layer.
let _radiusCacheLen = -1, _radiusCacheVal = 9;
function radiusAtCached(len) {
  if (len !== _radiusCacheLen) {
    _radiusCacheLen = len;
    _radiusCacheVal = radiusAt(len);
  }
  return _radiusCacheVal;
}

// Chat / SYSTEM lines share the kill-feed slot (top-center pills)
let chatLines = [];
function addKillFeed(text) {
  chatLines.push({ text, at: Date.now() });
  if (chatLines.length > 4) chatLines.shift();
  elKillFeed.innerHTML = chatLines.map((c) =>
    `<div class="feed-line">${escapeHtml(c.text)}</div>`
  ).join('');
  clearTimeout(addKillFeed._t);
  addKillFeed._t = setTimeout(() => {
    chatLines = [];
    elKillFeed.innerHTML = '';
  }, 4000);
}

// ---------- EVENT-DRIVEN HUD ----------
// updateHud() is called on SNAPSHOT arrivals and on a 500ms expiry timer —
// never per frame. Previously it ran at 60Hz building lb/feed strings even
// when nothing changed (allocation + layout-check churn).
function updateHud() {
  const me = worms.get(myId);
  if (me) hudLen = Math.floor(me.len);
  // youKills comes straight from the server each snapshot (top-10 leaderboard
  // drop hone par bhi kill count sahi rehta hai).
  elHudKills.textContent = (typeof youKills === 'number') ? youKills : 0;

  // PERF: rebuild DOM only when content actually changed — per-frame innerHTML
  // writes were the #1 stutter source (layout thrash at 60fps).
  const lbKey = leaderboard.slice(0, 10).map((e) => `${e.id},${e.score}`).join('|');
  if (lbKey !== lastLbKey) {
    lastLbKey = lbKey;
    elLbList.innerHTML = leaderboard.slice(0, 10).map((e, i) =>
      `<li${e.id === myId ? ' class="me"' : ''}><span>${i + 1}. ${escapeHtml(e.name)}</span><b>${e.score}</b></li>`
    ).join('');
  }

  // Kill feed: server list is append-only, so show only entries newer than
  // 3s — old ones vanish without any DOM work when nothing new arrives.
  const nowMs = Date.now();
  const recent = kills.filter((k) => (nowMs - (k.at || 0)) < 3000);
  const feedKey = recent.map((k) => `${k.killerName}>${k.victimName}`).join('|');
  if (feedKey !== lastFeedKey) {
    lastFeedKey = feedKey;
    elKillFeed.innerHTML = recent.slice(-4).map((k) =>
      `<div class="feed-line">☠ ${escapeHtml(k.killerName)} ➜ ${escapeHtml(k.victimName)}</div>`
    ).join('');
  }
}
setInterval(() => { if (lastFeedKey) updateHud(); }, 500); // expire kill-feed entries

// Score + kill counter now refresh on SNAPSHOT events (5-20Hz) instead of
// per frame — the values change at most at snapshot rate anyway.
setInterval(updateScoreHud, 100);
function updateScoreHud() {
  const me = worms.get(myId);
  if (me) {
    const l = Math.floor(me.len);
    if (l !== hudLen) { hudLen = l; scoreDirty = true; }
  }
  if (scoreDirty) {
    scoreDirty = false;
    const sc = $('score');
    if (sc) sc.textContent = hudLen;
    const kl = $('hud-kills');
    if (kl) kl.textContent = (typeof youKills === 'number') ? youKills : 0;
  }
}
let scoreDirty = false;
let lastLbKey = '', lastFeedKey = '', youKills = 0;

// Scratch array for the visible-food batch in render() — reused every frame.
const foodDrawScratch = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- rendering ----------
const ARENA_R = 3800;

// Camera pan smoothing (world units): the view chases the head so boost
// surges and speed changes glide instead of jolting. Zoom stays in updateCamera.
let camPanX = 0, camPanY = 0, camPanInit = false;
// Visible half-extents (world units) — set each frame in render(), used by
// drawWorm to stop building body polylines that are far off-screen.
let viewHalfW = 800, viewHalfH = 600;
// (camPendDirty/_vrCache/_vrKey declared near resize() — see top of file.)
function viewRadius() {
  const key = cv.clientWidth + 'x' + cv.clientHeight + '@' + (cam.zoom * 100 | 0);
  if (camPendDirty || key !== _vrKey) {
    _vrKey = key;
    camPendDirty = false;
    const halfW = cv.clientWidth / 2 / Math.max(cam.zoom, 0.01);
    const halfH = cv.clientHeight / 2 / Math.max(cam.zoom, 0.01);
    _vrCache = Math.sqrt(halfW * halfW + halfH * halfH) + 120;
  }
  return _vrCache;
}

// Pre-rendered static backdrop (radial depth + vignette) — rebuilt only when
// the canvas size changes. One drawImage per frame instead of per-pixel work.
// (bgCanvas itself is declared near resize() — see top of file.)
function makeBackdrop() {
  const w = cv.width, h = cv.height;
  if (!w || !h) return;
  if (!bgCanvas) bgCanvas = document.createElement('canvas');
  if (bgCanvas.width !== w || bgCanvas.height !== h) { bgCanvas.width = w; bgCanvas.height = h; }
  const g = bgCanvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  const grad = g.createRadialGradient(w / 2, h * 0.46, 40, w / 2, h / 2, Math.max(w, h) * 0.75);
  grad.addColorStop(0, '#161c32');
  grad.addColorStop(0.55, '#0e1223');
  grad.addColorStop(1, '#070910');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);
}

// ---------- BAKED SPRITE FACTORIES (one-time cost, then pure drawImage) ----------

// GRID: baked tile + createPattern — replaces ~100 moveTo/lineTo per frame.
// Re-bakes only when zoom crosses a 3% step (zf quantized in render()).
let gridPattern = null, gridPatternZoom = -1;
function bakeGrid(zf) {
  gridPatternZoom = zf;
  const step = 120 * zf;                    // 120 world units, scaled
  const size = Math.max(8, Math.round(step));
  const t = document.createElement('canvas');
  t.width = size; t.height = size;
  const g = t.getContext('2d');
  g.strokeStyle = 'rgba(90,110,180,0.10)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0.5, 0); g.lineTo(0.5, size);    // vertical line at tile left edge
  g.moveTo(0, 0.5); g.lineTo(size, 0.5);    // horizontal line at tile top edge
  g.stroke();
  gridPattern = ctx.createPattern(t, 'repeat');
}

// GLOW: radial gradient baked once per hue bucket — the per-frame
// createRadialGradient for every boosting worm is gone.
const glowCache = new Map();
function glowSprite(hue, boost) {
  const key = (hue / 15 | 0) * 2 + boost;   // 24 hues x 2 modes
  let c = glowCache.get(key);
  if (c) return c;
  const S = 128;
  c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(S / 2, S / 2, S * 0.06, S / 2, S / 2, S / 2);
  rg.addColorStop(0, `hsla(${hue},95%,70%,${boost ? 0.40 : 0.22})`);
  rg.addColorStop(1, 'hsla(0,0%,0%,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  glowCache.set(key, c);
  return c;
}

// NAME TAGS: text rendered once per name+variant to an offscreen canvas —
// fillText of the same string every frame re-triggers shaping work.
const nameCache = new Map();
function nameSprite(name, me) {
  const key = name + (me ? '\u0001' : '');
  let c = nameCache.get(key);
  if (c) return c;
  const H = 22;
  const probe = ctx.measureText(name);
  const W = Math.ceil(probe.width) + 8;
  c = document.createElement('canvas');
  c.width = Math.max(2, W); c.height = H;
  const g = c.getContext('2d');
  g.font = '13px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = me ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.85)';
  if (me) {
    g.shadowColor = 'rgba(120,220,160,0.9)';
    g.shadowBlur = 4;
  }
  g.fillText(name, W / 2, H / 2 + 1);
  nameCache.set(key, c);
  return c;
}

function worldToScreen(x, y) {
  return [
    (x - cam.x) * cam.zoom + cv.width / 2,
    (y - cam.y) * cam.zoom + cv.height / 2,
  ];
}

function render(now) {
  const w = cv.width, h = cv.height;
  makeBackdrop();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (bgCanvas && bgCanvas.width) ctx.drawImage(bgCanvas, 0, 0);
  else { ctx.fillStyle = '#0b0e1a'; ctx.fillRect(0, 0, w, h); }

  if (!camPanInit) { camPanX = cam.x; camPanY = cam.y; camPanInit = true; }
  camPanX += (cam.x - camPanX) * 0.22;
  camPanY += (cam.y - camPanY) * 0.22;
  // PERF: zoom smoothing with real frame delta (frame-rate independent) and a
  // quantized write — without quantization every frame dirties style/font
  // caches downstream; 0.3% steps are invisible but hit the fast path.
  cam.zoom += (cam.targetZoom - cam.zoom) * (1 - Math.exp(-(now - lastFrame + 8) / 220));
  cam.zoom = (cam.zoom * 333 + 0.5 | 0) / 333;
  const vx = camPanX, vy = camPanY;

  ctx.save();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const cw = w / DPR, ch = h / DPR;
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-vx, -vy);

  // grid — PATTERN-FILL: one fillRect instead of ~100 moveTo/lineTo segments
  // per frame. The tile re-bakes only when zoom crosses a 3% step.
  const zf = (cam.zoom * 32 | 0) / 32;
  if (gridPatternZoom !== zf) bakeGrid(zf);
  if (gridPattern) {
    ctx.fillStyle = gridPattern;
    const gx0 = vx - cw / 2 / cam.zoom, gy0 = vy - ch / 2 / cam.zoom;
    ctx.save();
    ctx.scale(1 / zf, 1 / zf);
    ctx.fillRect(gx0 * zf, gy0 * zf, (cw / cam.zoom) * zf, (ch / cam.zoom) * zf);
    ctx.restore();
  }

  // arena border: neon double ring (2 strokes — outer haze + bright core)
  ctx.beginPath();
  ctx.arc(0, 0, ARENA_R + 8, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,70,90,0.14)';
  ctx.lineWidth = 40 / cam.zoom;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, ARENA_R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,85,105,0.8)';
  ctx.lineWidth = 5 / cam.zoom;
  ctx.stroke();

  // food — EMOJI fruits from a SPRITE CACHE with the ground shadow BAKED IN:
  // exactly one drawImage per food (was two + a globalAlpha state switch).
  // Off-screen items are culled cheaply. Global alpha batching around the loop
  // removes per-item state churn.
  const halfW = cw / 2 / cam.zoom + 60, halfH = ch / 2 / cam.zoom + 60;
  viewHalfW = halfW; viewHalfH = halfH;
  const camL = vx - halfW, camR = vx + halfW, camT = vy - halfH, camB = vy + halfH;
  const tSec = now / 1000;
  const foodList = foodDrawScratch;
  foodList.length = 0;
  for (const f of foods.values()) {
    if (f.x < camL || f.x > camR || f.y < camT || f.y > camB) continue;
    foodList.push(f);
  }
  ctx.globalAlpha = 1;
  for (let fi = 0; fi < foodList.length; fi++) {
    const f = foodList[fi];
    const pulse = 1 + 0.1 * Math.sin(tSec * 2.2 + f.i % 10);
    const r = f.r * pulse;
    const em = (f.v >= 5) ? '\u2B50' : FOOD_EMOJIS[f.i % FOOD_EMOJIS.length];
    const s = r * 2.9;
    const g = emojiSprite(em);
    ctx.drawImage(g, f.x - s / 2, f.y - s / 2, s, s);
  }

  // pellets — death drops: same single-blit baked-shadow sprites
  for (const p of pellets.values()) {
    if (p.x < camL || p.x > camR || p.y < camT || p.y > camB) continue;
    const em = PELLET_EMOJI[p.i % PELLET_EMOJI.length];
    const s = p.r * 2.7;
    const g = emojiSprite(em);
    ctx.drawImage(g, p.x - s / 2, p.y - s / 2, s, s);
  }

  // worms — cull off-screen bodies (minimap still shows them)
  // Name font is set ONCE per frame (per-worm ctx.font was another GC/parser hit)
  ctx.textAlign = 'center';
  ctx.font = `${13 / cam.zoom}px system-ui, sans-serif`;
  for (const wm of worms.values()) {
    const wr = radiusAtCached(wm.len) + 40;
    if (wm.id !== myId && (wm.x < camL - wr || wm.x > camR + wr || wm.y < camT - wr || wm.y > camB + wr)) continue;
    drawWorm(wm, now);
  }

  ctx.restore();
  ctx.globalAlpha = 1;
}

// Stroke the preallocated ptsX/ptsY buffer using current stroke settings —
// zero allocation (old version built a fresh array per layer per worm per frame).
let dashBucket = -1; // setLineDash state cache — avoid redundant state changes
function strokePath() {
  ctx.beginPath();
  ctx.moveTo(ptsX[0], ptsY[0]);
  for (let i = 1; i < ptsN; i++) ctx.lineTo(ptsX[i], ptsY[i]);
  ctx.stroke();
}

// Stroke only points [from..to) of the shared buffer — used for the tapering
// tail (2 extra thin strokes, no allocation).
function strokePathRange(from, to) {
  if (to - from < 2) return;
  ctx.beginPath();
  ctx.moveTo(ptsX[from], ptsY[from]);
  for (let i = from + 1; i < to; i++) ctx.lineTo(ptsX[i], ptsY[i]);
  ctx.stroke();
}

function drawWorm(w, now) {
  const r = radiusAtCached(w.len);
  const r2 = r * 2;
  const h = w.history;
  if (h.length === 0) return;

  // Interpolated head position — the whole worm is drawn from here so bodies
  // glide instead of stepping at snapshot rate. (Zero-alloc: writes _ix/_iy.)
  wormInterp(w, now);
  const hx = _ix, hy = _iy;

  // Long worm far off-screen? Skip the whole polyline build (history walk is
  // the most expensive part of drawing a giant).
  if (w.id !== myId && (hx < cam.x - viewHalfW - 600 || hx > cam.x + viewHalfW + 600 ||
      hy < cam.y - viewHalfH - 600 || hy > cam.y + viewHalfH + 600)) return;

  // Build the visible body polyline into the shared buffer (head -> tail).
  const need = w.len * 3;
  let drawn = 0;
  let px = hx, py = hy;
  ptsX[0] = hx; ptsY[0] = hy; ptsN = 1;
  for (let i = h.length - 1; i >= 0 && drawn < need && ptsN < PTS_MAX; i--) {
    const p = h[i];
    const dx = p.x - px, dy = p.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 > 40000) break; // history gap (respawn) — stop here (200^2)
    drawn += Math.sqrt(d2);
    ptsX[ptsN] = p.x; ptsY[ptsN] = p.y; ptsN++;
    px = p.x; py = p.y;
  }
  if (ptsN < 2) {
    ptsX[1] = hx - Math.cos(w.dir) * r;
    ptsY[1] = hy - Math.sin(w.dir) * r;
    ptsN = 2;
  }

  const boostGlow = w.boost ? 1 : 0;

  // ----- QUALITY LOD (set by the perf governor) -----
  // mode 2 = everything; 1 = drop bands/highlight/tail layers; 0 = outline +
  // body + eyes only. Tiny worms always skip layers anyway.
  const lod = perf.mode;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Layer 1: dark outline (slightly wider) for separation from background
  ctx.strokeStyle = w.protect ? `hsla(${w.hue},80%,60%,0.45)` : `hsla(${w.hue},70%,18%,0.9)`;
  ctx.lineWidth = r2 + 5;
  strokePath();

  // Layer 2: main body (bright core color)
  ctx.strokeStyle = w.protect ? `hsla(${w.hue},80%,60%,0.5)` : `hsl(${w.hue},85%,60%)`;
  ctx.lineWidth = r2;
  strokePath();

  // Layer 3: dark scale BANDS — dashed stroke over the body. setLineDash is
  // kept per radius bucket (state change is what costs, not the value) and
  // the whole layer is skipped for small/far worms and in low quality modes.
  if (lod > 0 && ptsN > 6 && !w.protect && r > 6) {
    const bucket = (r | 0);
    if (dashBucket !== bucket) {
      dashBucket = bucket;
      ctx.setLineDash([bucket * 0.9, bucket * 2.6]);
    }
    ctx.strokeStyle = `hsla(${w.hue},75%,30%,0.35)`;
    ctx.lineWidth = r * 1.05;
    strokePath();
    if (dashBucket >= 0) { ctx.setLineDash([]); dashBucket = -1; }
  }

  // Layer 4: highlight stripe along the top edge — offset path via plain math
  // (save/translate/restore per worm per frame was measurable).
  if (lod > 0 && !w.protect && r > 5) {
    const off = r * 0.45;
    const ox = Math.cos(w.dir - Math.PI / 2) * off, oy = Math.sin(w.dir - Math.PI / 2) * off;
    ctx.strokeStyle = `hsla(${w.hue},95%,78%,0.35)`;
    ctx.lineWidth = r * 0.8;
    ctx.beginPath();
    ctx.moveTo(ptsX[0] + ox, ptsY[0] + oy);
    for (let i = 1; i < ptsN; i++) ctx.lineTo(ptsX[i] + ox, ptsY[i] + oy);
    ctx.stroke();
  }

  // Tapered tail: two progressively thinner strokes over the last segments.
  if (lod > 0 && ptsN > 12 && !w.protect) {
    ctx.strokeStyle = `hsl(${w.hue},85%,60%)`;
    ctx.lineWidth = r * 1.25;
    strokePathRange(Math.floor(ptsN * 0.78), ptsN);
    ctx.lineWidth = r * 0.6;
    strokePathRange(Math.floor(ptsN * 0.9), ptsN);
  }

  // Head glow — PRE-BAKED sprite per hue bucket: one drawImage instead of a
  // createRadialGradient (gradient construction was the costliest op in the
  // whole frame when several worms boost at once).
  if (w.id === myId || w.boost) {
    const gr = r * (w.boost ? 3.2 : 2.2);
    const gsz = gr * 2;
    const gcan = glowSprite(w.hue, w.boost ? 1 : 0);
    ctx.drawImage(gcan, hx - gr, hy - gr, gsz, gsz);
  }

  // Boost trail: fading circles at the tail while boosting
  if (w.boost && ptsN > 2) {
    for (let k = 1; k <= 3; k++) {
      const idx = ptsN - 1 - k * 4;
      if (idx < 0) break;
      const tx = ptsX[idx], ty = ptsY[idx];
      ctx.fillStyle = `hsla(${w.hue},95%,70%,${0.22 / k})`;
      ctx.beginPath();
      ctx.arc(tx, ty, r * (1.1 + k * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Eyes: two symmetric eyes straddling the movement axis (±~55°). The pupils
  // LOOK where the player is pointing (mouse/joystick), smoothly interpolated —
  // other snakes just look where they're heading.
  // PERF: eyes collapse into a single small circle when the worm on screen is
  // tiny (er < 3px) or in low quality modes — 8 canvas ops saved per worm.
  if (w.gazeDir === undefined) w.gazeDir = w.dir;
  const gazeTarget = (w.id === myId ? eyeDir() : null) ?? w.dir;
  let gd = gazeTarget - w.gazeDir;
  gd = ((gd + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  w.gazeDir += gd * 0.2; // smooth gaze swing, no snapping
  const er = r * 0.36;
  if (er >= 3 && lod === 2) {
    for (const s of [-1, 1]) {
      const ea = w.dir + s * 0.95;
      const ex = hx + Math.cos(ea) * r * 0.62;
      const ey = hy + Math.sin(ea) * r * 0.62;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ex, ey, er, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.06);
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.stroke();
      // iris + pupil track the gaze direction
      const px = ex + Math.cos(w.gazeDir) * er * 0.36;
      const py = ey + Math.sin(w.gazeDir) * er * 0.36;
      ctx.fillStyle = `hsl(${(w.hue + 40) % 360},90%,42%)`;
      ctx.beginPath();
      ctx.arc(px, py, er * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#101018';
      ctx.beginPath();
      ctx.arc(px + Math.cos(w.gazeDir) * er * 0.14, py + Math.sin(w.gazeDir) * er * 0.14, er * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (er >= 1.5) {
    const ea = w.dir;
    const ex = hx + Math.cos(ea) * r * 0.62;
    const ey = hy + Math.sin(ea) * r * 0.62;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(ex, ey, er, 0, Math.PI * 2);
    ctx.fill();
  }

  // Nose dot — face depth cue
  ctx.fillStyle = `hsla(${w.hue},85%,35%,0.8)`;
  ctx.beginPath();
  ctx.arc(hx + Math.cos(w.dir) * r * 0.72, hy + Math.sin(w.dir) * r * 0.72, r * 0.16, 0, Math.PI * 2);
  ctx.fill();

  // Spawn protection shimmer ring — skipped in low quality modes
  if (w.protect && lod > 0) {
    ctx.strokeStyle = `hsla(${w.hue},90%,75%,${0.5 + 0.3 * Math.sin(now / 120)})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(hx, hy, r + 9, 0, Math.PI * 2);
    ctx.stroke();
  }

  // NAME SPRITE: rendered once per name to an offscreen canvas — per-frame
  // fillText of the same string re-did shaping work. 1:1 world-unit blit
  // (scaled by zoom only via the world transform).
  const tag = nameSprite(w.id === myId ? 'You' : (w.name || `W${w.id}`), w.id === myId);
  ctx.drawImage(tag, hx - tag.width / 2, hy - r - tag.height / 2 - 9 / cam.zoom);
}

// Food emojis cycled by food id (server sends i, x, y, r, v, h per item)
const FOOD_EMOJIS = ['\uD83C\uDF4E', '\uD83C\uDF4A', '\uD83C\uDF4B', '\uD83C\uDF4F', '\uD83C\uDF47', '\uD83C\uDF53', '\uD83C\uDF52', '\uD83C\uDF51', '\uD83E\uDD5D', '\uD83C\uDF49'];
const PELLET_EMOJI = ['\uD83E\uDD69', '\uD83C\uDF67', '\uD83C\uDF6A'];

// PERF: emoji sprite cache — render each emoji ONCE to an offscreen canvas,
// then drawImage() every frame (GPU blit, no font parsing). The soft ground
// shadow is BAKED into the same canvas (radial gradient drawn once at bake
// time) — the old per-frame shadow blit + globalAlpha switch per food is gone.
const emojiCache = new Map();
function emojiSprite(em) {
  let c = emojiCache.get(em);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = 96; c.height = 96;
  const g = c.getContext('2d');
  // baked ground shadow (bottom area)
  const sh = g.createRadialGradient(48, 62, 4, 48, 62, 30);
  sh.addColorStop(0, 'rgba(0,0,0,0.30)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = sh;
  g.beginPath();
  g.ellipse(48, 62, 30, 12, 0, 0, Math.PI * 2);
  g.fill();
  g.font = '58px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(em, 48, 42);
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
  const now = nowFrame;
  for (const w of worms.values()) {
    const isMe = w.id === myId;
    // interpolated position — dot glides like the worm on screen
    wormInterp(w, now);
    const px = _ix, py = _iy;
    mmCtx.fillStyle = isMe ? '#ffffff' : `hsl(${w.hue},80%,55%)`;
    mmCtx.beginPath();
    mmCtx.arc(s / 2 + px * scale, s / 2 + py * scale, isMe ? 3.5 : 2.5, 0, Math.PI * 2);
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
  selfMissingSince = 0;
  document.body.classList.add('playing');
  show($('room-pill'), true);
  send({ t: 'respawn', name: playerName(), skin: 0, hue: myHue });
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

// ---------- lobby init: name pre-fill + online counter ----------
(function initLobbyExtras() {
  $('player-name').value = localStorage.getItem('wa_name') || '';
  const refresh = async () => {
    try {
      const r = await fetch('/api/stats');
      const j = await r.json();
      $('online-count').textContent = j.players;
    } catch (e) { /* ignore */ }
  };
  refresh();
  setInterval(refresh, 5000);
})();
