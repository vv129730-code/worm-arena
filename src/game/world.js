'use strict';

const { CFG } = require('./constants');
const { radiusAt } = require('./worm');

const SEG = 6;    // body points are ~6 units apart
const SKIP = 6;   // skip the first ~36 units of a body when checking collisions

// PERF: reverse index (item.id -> cell key) makes remove() O(1). The old
// design had NO removal, forcing a FULL rebuild of the food hash every tick
// (2600 inserts x 30Hz) and a full body-point rebuild every tick.
class SpatialHash {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
    this.keys = new Map(); // item.id -> cell key (for O(1) removal)
  }

  clear() {
    this.map.clear();
    this.keys.clear();
  }

  key(cx, cy) {
    return cx * 100000 + cy;
  }

  insert(item, x, y) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let arr = this.map.get(k);
    if (!arr) {
      arr = [];
      this.map.set(k, arr);
    }
    arr.push(item);
    this.keys.set(item.id, k);
  }

  // O(1): swap-remove the item from its recorded cell.
  remove(item) {
    const k = this.keys.get(item.id);
    if (k === undefined) return;
    this.keys.delete(item.id);
    const arr = this.map.get(k);
    if (!arr) return;
    const i = arr.indexOf(item);
    if (i >= 0) {
      arr[i] = arr[arr.length - 1];
      arr.pop();
      if (arr.length === 0) this.map.delete(k);
    }
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
    let x, y;
    // Most respawns cluster near existing food so eaten areas refill quickly;
    // the rest spread anywhere so the map never develops dead zones.
    if (this.food.size > 0 && Math.random() < CFG.FOOD_RESPAWN_NEAR_FRAC) {
      const foods = [...this.food.values()];
      const anchor = foods[(Math.random() * foods.length) | 0];
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * CFG.ARENA_R * CFG.FOOD_RESPAWN_NEAR_DIST;
      x = anchor.x + Math.cos(a) * d;
      y = anchor.y + Math.sin(a) * d;
    } else {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * (CFG.ARENA_R - 60);
      x = Math.cos(a) * r;
      y = Math.sin(a) * r;
    }
    // Keep inside the arena circle
    const dist = Math.sqrt(x * x + y * y);
    if (dist > CFG.ARENA_R - 60) {
      const k = (CFG.ARENA_R - 60) / (dist || 1e-9);
      x *= k;
      y *= k;
    }
    const id = this.nextFoodId++;
    const f = {
      id,
      x,
      y,
      r: CFG.FOOD_R + Math.random() * 2,
      v: CFG.FOOD_VALUE + (Math.random() < 0.08 ? 4 : 0), // 8% big food
      hue: Math.floor(Math.random() * 360),
    };
    this.food.set(id, f);
    this.foodHash.insert(f, f.x, f.y); // incremental — no per-tick rebuild
    return f;
  }

  // Eat-time removal: O(1) out of the map AND the spatial hash.
  removeFood(f) {
    this.food.delete(f.id);
    this.foodHash.remove(f);
  }

  // Rare safety net (called every 30s per room): rebuild hashes from truth so
  // any drift from the incremental path self-heals.
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
      this.pelletHash.insert(pel, pel.x, pel.y); // incremental
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
    this.pelletHash.insert(pel, pel.x, pel.y); // incremental
    return pel;
  }

  removePellet(p) {
    this.pellets.delete(p.id);
    this.pelletHash.remove(p);
  }

  prunePellets(nowMsVal) {
    for (const [id, p] of this.pellets) {
      if (nowMsVal - p.born > CFG.PELLET_LIFE * 1000) this.removePellet(p);
    }
  }

  // Head vs other worms' bodies. Returns the worm whose body was hit, or null.
  // Uses the INCREMENTAL body spatial hash (maintained by the room each tick).
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

  // ===== INCREMENTAL BODY INDEX =====
  // The room calls addBodyPoint() for every new path point (a handful per worm
  // per tick) and removeBodyPoint() for trimmed tail points. A 10-worm game
  // previously re-inserted ~5,000+ points EVERY tick; now it's ~40.
  addBodyPoint(w, x, y) {
    this.bodyHash.insert(w, x, y);
  }

  removeBodyPoint(w, x, y) {
    // swap-remove ONE matching entry for this worm in its cell (points repeat
    // the same coords rarely; scanning the cell's small array is fine).
    const k = this.bodyHash.key(Math.floor(x / this.bodyHash.cell), Math.floor(y / this.bodyHash.cell));
    const arr = this.bodyHash.map.get(k);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === w) {
        arr[i] = arr[arr.length - 1];
        arr.pop();
        if (arr.length === 0) this.bodyHash.map.delete(k);
        return;
      }
    }
  }

  // Full rebuild kept for: room bootstrap, 30s self-heal resync, and tests.
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
}

module.exports = { World, SpatialHash, SKIP };
