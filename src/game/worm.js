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

function radiusAt(len) {
  return 9 + 3.2 * Math.sqrt(Math.max(0, len - 10));
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
      w.points.unshift([w.x, w.y]);
      w.pathLen += w.acc;
      w.acc = 0;
      w.pointsAdded++;
    }
  }
}

// Trim path so its total length == len * PATH_PER_LEN. Returns tail cut point or null.
function trimPath(w) {
  const need = w.len * CFG.PATH_PER_LEN;
  const pts = w.points;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]);
    if (total + d >= need) {
      const remain = need - total;
      const t = remain / (d || 1e-9);
      const tx = pts[i + 1][0] + (pts[i][0] - pts[i + 1][0]) * t;
      const ty = pts[i + 1][1] + (pts[i][1] - pts[i + 1][1]) * t;
      pts.splice(i + 1);
      pts.push([tx, ty]);
      w.pathLen = total + remain;
      return [tx, ty];
    }
    total += d;
  }
  // Path shorter than needed (just spawned/grown) — it will grow naturally.
  w.pathLen = total;
  return null;
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
  w.len = Math.min(w.len + lenGain, CFG.MAX_LEN);
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
  newWorm,
  advance,
  trimPath,
  steer,
  stepHeading,
  gain,
  boostDrainPerSec,
  boostEmitLen,
};
