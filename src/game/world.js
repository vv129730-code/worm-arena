'use strict';

const { CFG } = require('./constants');
const { radiusAt } = require('./worm');

const SEG = 6;    // body points are ~6 units apart
const SKIP = 6;   // skip the first ~36 units of a body when checking collisions

class SpatialHash {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }

  clear() {
    this.map.clear();
  }

  key(cx, cy) {
    return cx * 100000 + cy;
  }

  insert(item, x, y) {
    const key = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let arr = this.map.get(key);
    if (!arr) {
      arr = [];
      this.map.set(key, arr);
    }
    arr.push(item);
  }

  queryCircle(x, y, r, out) {
    out.length = 0;
    const minCx = Math.floor((x - r) / this.cell);
    const maxCx = Math.floor((x + r) / this.cell);
    const minCy = Math.floor((y - r) / this.cell);
    const maxCy = Math.floor((y + r) / this.cell);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const arr = this.map.get(this.key(cx, cy));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) out.push(arr[i]);
      }
    }
  }
}

function nowMs() {
  return Date.now();
}

class World {
  constructor() {
    this.food = new Map();     // id -> {id,x,y,r,v,hue}
    this.nextFoodId = 1;
    this.pellets = new Map();  // id -> {id,x,y,r,v,hue,born}
    this.pelletSeq = 1;
    this.hash = new SpatialHash(CFG.SECTOR);  // generic hash (unused spare)
    this.bodyHash = new SpatialHash(CFG.SECTOR); // worm body points hash
    this.foodHash = new SpatialHash(CFG.SECTOR);
    this.pelletHash = new SpatialHash(CFG.SECTOR);
  }

  ensureFood() {
    while (this.food.size < CFG.FOOD_COUNT) {
      this.spawnFood();
    }
  }

  spawnFood() {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (CFG.ARENA_R - 60);
    const id = this.nextFoodId++;
    this.food.set(id, {
      id,
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      r: CFG.FOOD_R + Math.random() * 2,
      v: CFG.FOOD_VALUE + (Math.random() < 0.08 ? 4 : 0), // 8% big food
      hue: Math.floor(Math.random() * 360),
    });
  }

  spawnDeathPellets(w, pelletsOut) {
    const totalLen = w.len * CFG.DEATH_PELLET_RATIO;
    const n = Math.min(CFG.MAX_DEATH_PELLETS, Math.ceil(totalLen / CFG.PELLET_VALUE));
    if (n <= 0) return 0;
    const per = totalLen / n;
    const pts = w.points;
    const step = Math.max(1, Math.floor(pts.length / n));
    let placed = 0;
    for (let i = 0; i * step < pts.length && placed < n; i++) {
      const p = pts[i * step];
      const id = this.pelletSeq++;
      const pel = {
        id,
        x: p[0],
        y: p[1],
        r: CFG.PELLET_R_BASE + Math.min(6, per * 0.3),
        v: per,
        hue: w.hue,
        born: nowMs(),
      };
      this.pellets.set(id, pel);
      pelletsOut.push(pel);
      placed++;
    }
    return placed;
  }

  spawnBoostPellet(w) {
    const pts = w.points;
    const tail = pts[pts.length - 1];
    const a = Math.random() * Math.PI * 2;
    const id = this.pelletSeq++;
    const pel = {
      id,
      x: tail[0] + Math.cos(a) * 6,
      y: tail[1] + Math.sin(a) * 6,
      r: 5,
      v: 2,
      hue: w.hue,
      born: nowMs(),
    };
    this.pellets.set(id, pel);
    return pel;
  }

  prunePellets(nowMsVal) {
    for (const [id, p] of this.pellets) {
      if (nowMsVal - p.born > CFG.PELLET_LIFE * 1000) this.pellets.delete(id);
    }
  }

  // Head vs other worms' bodies. Returns the worm whose body was hit, or null.
  // Uses a spatial hash over every other worm's body points (rebuilt each tick).
  collideHead(w, worms, bodyIndex) {
    const myR = radiusAt(w.len) + 2;
    const cand = [];
    bodyIndex.queryCircle(w.x, w.y, myR + 24, cand);
    // Dedup via Set (a worm body inserted many times)
    const seen = new Set();
    for (const other of cand) {
      if (seen.has(other.id)) continue;
      seen.add(other.id);
      if (other === w || other.dead) continue;
      const orad = radiusAt(other.len) + 2;
      const radSum = myR + orad - 2;
      const radSum2 = radSum * radSum;
      const pts = other.points;
      // check own head against its body, skipping the first SKIP points
      for (let i = SKIP; i < pts.length; i++) {
        const dx = pts[i][0] - w.x;
        const dy = pts[i][1] - w.y;
        if (dx * dx + dy * dy <= radSum2) return other;
      }
    }
    return null;
  }

  // Rebuild the body-point spatial index (call once per tick before collideHead).
  buildBodyIndex(worms) {
    const hash = this.bodyHash;
    hash.clear();
    for (const w of worms) {
      if (w.dead) continue;
      const pts = w.points;
      for (let i = 0; i < pts.length; i++) {
        hash.insert(w, pts[i][0], pts[i][1]);
      }
    }
    return hash;
  }

  rebuildFoodHash() {
    const hash = this.foodHash;
    hash.clear();
    for (const f of this.food.values()) hash.insert(f, f.x, f.y);
    return hash;
  }

  rebuildPelletHash() {
    const hash = this.pelletHash;
    hash.clear();
    for (const p of this.pellets.values()) hash.insert(p, p.x, p.y);
    return hash;
  }
}

module.exports = { World, SpatialHash, SKIP };
