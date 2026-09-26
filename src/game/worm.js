'use strict';

const { CFG } = require('./constants');

const SEG = 6;          // path point spacing
const SUBSTEP = 4;      // max movement substep per tick

function randDir() {
  return Math.random() * Math.PI * 2;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// All growth is in "length units" (len). Body path length = len * CFG.PATH_PER_LEN.
function speedAt(len) {
  return CFG.BASE_SPEED * (0.92 + 0.08 / (1 + len / 500));
}

function turnRateAt(len) {
  const t = clamp((len - 10) / 260, 0, 1);
  return CFG.TURN_RATE - (CFG.TURN_RATE - CFG.TURN_RATE_MIN) * t;
}

// Thickness: sqrt growth up to RADIUS_SOFT, then a much slower log phase so
// huge worms still thicken but never balloon (keeps lanes navigable).
function radiusAt(len) {
  const over = Math.max(0, len - 10);
  if (over <= CFG.RADIUS_SOFT) {
    return 9 + CFG.RADIUS_K1 * Math.sqrt(over);
  }
  const base = 9 + CFG.RADIUS_K1 * Math.sqrt(CFG.RADIUS_SOFT);
  return base + CFG.RADIUS_K2 * Math.log1p((over - CFG.RADIUS_SOFT) / 40);
}

// Growth value taper: full value below GROWTH_SOFT_CAP, easing down to
// GROWTH_TAPER_MIN by ~10x the cap.
function growthWeight(len) {
  const cap = CFG.GROWTH_SOFT_CAP;
  if (len <= cap) return 1;
  const t = 1 - Math.exp(-(len - cap) / (cap * 2));
  return 1 - t * (1 - CFG.GROWTH_TAPER_MIN);
}

function newWorm(id, name, hue, skin, x, y) {
  const dir = randDir();
  return {
    id,
    name,
    hue,
    skin: skin | 0,
    x,
    y,
    dir,
    targetDir: dir,
    len: CFG.START_LEN,
    boostWish: false,
    boosting: false,
    boostEmitT: 0,
    points: [[x, y]],
    // PERF: stored per-point segment lengths (dist to PREVIOUS point, [0]=0).
    // trimPath becomes amortized O(1) — no full-path walk per tick.
    segLens: [0],
    // Parallel flag per point: 1 = already in the room's body spatial hash.
    // Lets the room keep the body index incremental with zero drift.
    ptIns: [0],
    pathLen: 0,
    acc: 0,          // distance traveled since last recorded path point
    dead: false,
    kills: 0,
    protectT: CFG.SPAWN_PROTECT,
    score: 0,
    ping: 0,
    pointsAdded: 0,
  };
}

// Move head forward by dist along w.dir, recording path points every SEG units.
function advance(w, dist) {
  let remaining = dist;
  while (remaining > 1e-9) {
    const s = Math.min(SUBSTEP, remaining);
    w.x += Math.cos(w.dir) * s;
    w.y += Math.sin(w.dir) * s;
    w.acc += s;
    remaining -= s;
    if (w.acc >= SEG) {
      // PERF: inline hypot — the previous point is exactly (w.x-cos*acc,
      // w.y-sin*acc), avoiding an array dereference per path point.
      w.segLens.push(w.acc);
      w.points.push([w.x, w.y]);
      w.ptIns.push(0);
      w.pathLen += w.acc;
      w.acc = 0;
      w.pointsAdded++;
    }
  }
}

// Trim path so its total length == len * PATH_PER_LEN.
// PERF: amortized O(1) — pops whole tail segments using stored segLens and
// makes ONE exact cut. The old version re-walked the ENTIRE path every tick
// (O(n) per worm per tick at 30Hz; giants have ~500-1600 points).
function trimPath(w) {
  const need = w.len * CFG.PATH_PER_LEN;
  const pts = w.points;
  if (pts.length < 2) { w.pathLen = 0; return null; }

  // Fast path: whole segments can be popped from the tail.
  while (pts.length > 1 && w.pathLen - w.segLens[pts.length - 1] > need) {
    const p = pts.pop();
    w.pathLen -= w.segLens.pop();
    removedIns.push(w.ptIns.pop() || 0);
    removedPts.push(p);
  }
  if (pts.length === 1) { w.pathLen = 0; return pts[0]; }

  // Exact cut inside the last segment (single hypot, no walk).
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const segLen = w.segLens[pts.length - 1];
  const over = w.pathLen - need;
  if (over > 0 && segLen > 1e-9) {
    const t = over / segLen;
    const tx = last[0] + (prev[0] - last[0]) * t;
    const ty = last[1] + (prev[1] - last[1]) * t;
    last[0] = tx; last[1] = ty;
    w.pathLen = need;
    w.segLens[pts.length - 1] = segLen - over;
  }
  return last;
}

// PERF: shared scratch to hand trimmed tail points + their hash-insert flags
// to the room (keeps the incremental body index exact) — zero allocation.
const removedPts = [];
const removedIns = [];
const removedOut = { points: removedPts, flags: removedIns };
function takeRemovedPoints() {
  removedPts.length = 0;
  removedIns.length = 0;
  return removedOut;
}

function steer(w, dir) {
  // normalize into (-PI, PI]
  dir = dir % (Math.PI * 2);
  if (dir > Math.PI) dir -= Math.PI * 2;
  if (dir <= -Math.PI) dir += Math.PI * 2;
  w.targetDir = dir;
}

function stepHeading(w, dt) {
  const maxTurn = turnRateAt(w.len) * dt;
  let diff = w.targetDir - w.dir;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxTurn) w.dir = w.targetDir;
  else w.dir += Math.sign(diff) * maxTurn;
}

function gain(w, lenGain) {
  const weighted = lenGain * growthWeight(w.len);
  w.len = Math.min(w.len + weighted, CFG.MAX_LEN);
  w.score = Math.max(w.score, Math.floor(w.len));
}

function boostDrainPerSec(w) {
  return 8 + w.len * 0.04;   // length units/sec
}

// Length dropped as pellets per emit while boosting.
function boostEmitLen(w) {
  return boostDrainPerSec(w) * CFG.BOOST_PELLET_EVERY * 0.55;
}

module.exports = {
  SEG,
  SUBSTEP,
  randDir,
  clamp,
  speedAt,
  turnRateAt,
  radiusAt,
  growthWeight,
  newWorm,
  advance,
  trimPath,
  takeRemovedPoints,
  steer,
  stepHeading,
  gain,
  boostDrainPerSec,
  boostEmitLen,
};
