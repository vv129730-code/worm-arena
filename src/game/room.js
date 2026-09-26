'use strict';

const crypto = require('crypto');
const { CFG } = require('./constants');
const worm = require('./worm');
const worldMod = require('./world');

const World = worldMod.World;
const {
  newWorm, advance, trimPath, steer, stepHeading,
  gain, speedAt, radiusAt, clamp, takeRemovedPoints,
} = worm;

function clampPlayerLimit(n) {
  n = Math.floor(Number(n) || CFG.DEFAULT_MAX_PLAYERS);
  return Math.max(2, Math.min(CFG.MAX_PLAYERS_HARD_CAP, n));
}

function randomCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

let nextWormId = 1;

class Room {
  constructor(maxPlayers, isPrivate = true) {
    this.code = randomCode();
    this.maxPlayers = clampPlayerLimit(maxPlayers);
    this.isPrivate = !!isPrivate; // private = code-only entry; public = quick-play pool
    this.createdAt = Date.now();
    this.clients = new Map();      // wormId -> client entry {ws, worm, isBot, name}
    this.world = new World();
    this.world.ensureFood();

    // Delta snapshot bookkeeping (per connected human client)
    this.clientSync = new Map();   // wormId -> {lastAckTick, foodSeen:Set, pelletSeen:Set, vr}
    // Food ids deleted since the last broadcastSnapshot — broadcast to EVERYONE
    // so no client keeps "ghost" food that someone else already ate.
    this.foodDelRecent = [];

    this.tickNum = 0;
    this.tickTimer = null;
    this.netTimer = null;
    this.lastTickAt = 0;
    this.emptySince = Date.now();

    // Event feeds per client (consumed at NET_HZ)
    this.kills = [];               // {tick, killerName, victimName}

    // PERF: reused scratch arrays + cached leaderboard (zero per-tick alloc)
    this._wormsScratch = [];
    this._candScratch = [];
    this._lb = null;
    this._lbAt = 0;
  }

  humanCount() {
    let n = 0;
    for (const c of this.clients.values()) if (!c.isBot) n++;
    return n;
  }

  playerCount() {
    return this.clients.size;
  }

  isFull() {
    return this.clients.size >= this.maxPlayers;
  }

  addClient(ws, name, skin, isBot, hue) {
    if (this.isFull()) return null;
    const id = nextWormId++;
    const pos = this.pickSpawn();
    const h = (typeof hue === 'number' && isFinite(hue))
      ? ((Math.floor(hue) % 360) + 360) % 360
      : Math.floor(Math.random() * 360);
    const w = newWorm(id, name, h, skin, pos.x, pos.y);
    const entry = { ws, worm: w, isBot: !!isBot, name };
    this.clients.set(id, entry);
    this.clientSync.set(id, { lastAckTick: 0, foodSeen: new Set(), pelletSeen: new Set(), vr: 1600 });
    if (!isBot && ws) {
      ws.send(JSON.stringify({ t: 'welcome', id, roomCode: this.code, maxPlayers: this.maxPlayers, isPrivate: this.isPrivate, tickHz: CFG.TICK_HZ }));
      this.broadcastElse({ t: 'chat', name: 'SYSTEM', text: `${name} joined the arena`, hue: null }, id);
    }
    return entry;
  }

  // Remove a dead/gone worm's entries from the incremental body hash (the old
  // full rebuild did this implicitly every tick).
  purgeBodyIndex(w) {
    const pts = w.points;
    for (let i = 0; i < pts.length; i++) {
      if (w.ptIns[i]) this.world.removeBodyPoint(w, pts[i][0], pts[i][1]);
    }
  }

  removeClient(id) {
    const entry = this.clients.get(id);
    if (!entry) return;
    this.clients.delete(id);
    this.clientSync.delete(id);
    entry.worm.dead = true;
    this.purgeBodyIndex(entry.worm);
    if (!entry.isBot) {
      this.broadcast({ t: 'chat', name: 'SYSTEM', text: `${entry.name} left the arena`, hue: null });
    }
  }

  pickSpawn() {
    // Spawn NEAR existing players (arena me sab bahut door-door na bikhre —
    // warna naya player kisi ko dikhta hi nahi). Safe gap 600, anchor = random
    // existing worm ya arena center jab room khaali ho.
    let ax = 0, ay = 0;
    const others = [...this.clients.values()];
    if (others.length) {
      const anchor = others[Math.floor(Math.random() * others.length)].worm;
      ax = anchor.x; ay = anchor.y;
    }
    for (let tries = 0; tries < 24; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 700 + Math.random() * 900; // 700–1600 from anchor — view me aa jayega
      const x = ax + Math.cos(a) * r;
      const y = ay + Math.sin(a) * r;
      const d = Math.hypot(x, y);
      if (d > CFG.ARENA_R - 300) continue; // wall se door rakho
      let ok = true;
      for (const c of others) {
        const w = c.worm;
        if (Math.hypot(w.x - x, w.y - y) < 600) { ok = false; break; }
      }
      if (ok) return { x, y };
    }
    const a = Math.random() * Math.PI * 2;
    const r = CFG.SPAWN_RADIUS_MIN + Math.random() * (CFG.SPAWN_RADIUS_MAX - CFG.SPAWN_RADIUS_MIN);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }

  broadcast(msg, exceptWormId) {
    const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const [id, c] of this.clients) {
      if (exceptWormId !== undefined && id === exceptWormId) continue;
      if (c.isBot || !c.ws) continue;
      if (c.ws.readyState === 1) { try { c.ws.send(data); } catch (e) { /* ignore */ } }
    }
  }

  broadcastElse(msg, exceptWormId) {
    this.broadcast(msg, exceptWormId);
  }

  handleInput(w, msg) {
    if (msg.t === 'input') {
      if (typeof msg.dir === 'number' && isFinite(msg.dir)) steer(w, msg.dir);
      w.boostWish = !!msg.boost;
      // client-reported view radius (world units) — clamped server-side
      if (typeof msg.vr === 'number' && isFinite(msg.vr)) {
        const sync = this.clientSync.get(w.id);
        if (sync) sync.vr = clamp(msg.vr, 900, 3200);
      }
    } else if (msg.t === 'ack') {
      const sync = this.clientSync.get(w.id);
      if (sync && typeof msg.tick === 'number') sync.lastAckTick = Math.max(sync.lastAckTick, msg.tick | 0);
    } else if (msg.t === 'ping') {
      const c = this.clients.get(w.id);
      if (c && c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }));
    }
  }

  killWorm(w, killer, dropsOut) {
    if (w.dead) return;
    w.dead = true;
    this.world.spawnDeathPellets(w, dropsOut);
    if (killer && !killer.dead) {
      killer.kills++;
      gain(killer, Math.min(40, Math.floor(w.len * 0.15)));
    }
    this.kills.push({ tick: this.tickNum, killerName: killer ? killer.name : 'the wall', victimName: w.name });
    if (this.kills.length > 60) this.kills.splice(0, this.kills.length - 60);
  }

  tick(dt) {
    this.tickNum++;
    const drops = [];

    // 1) Move worms (heading -> boost economy -> advance -> trim)
    for (const c of this.clients.values()) {
      const w = c.worm;
      if (w.dead) continue;

      stepHeading(w, dt);

      // spawn protection countdown
      if (w.protectT > 0) w.protectT -= dt;

      // boost economy: drains length, drops pellets at tail
      w.boosting = false;
      if (w.boostWish && w.len > CFG.BOOST_MIN_LEN) {
        w.boosting = true;
        w.boostEmitT += dt;
        const drain = worm.boostDrainPerSec(w) * dt;
        w.len -= drain;
        if (w.boostEmitT >= CFG.BOOST_PELLET_EVERY) {
          w.boostEmitT = 0;
          const pel = this.world.spawnBoostPellet(w);
          drops.push(pel);
        }
      }

      const sp = speedAt(w.len) * (w.boosting ? CFG.BOOST_MULT : 1);
      advance(w, sp * dt);

      // PERF: INCREMENTAL body index — insert only the path points laid this
      // tick (~0-5/worm) instead of rebuilding every worm's full body (~500+
      // points) every tick at 30Hz. Identical coverage to the old rebuild.
      const bodyHash = this.world.bodyHash;
      const pts = w.points;
      for (let i = pts.length - 1; i >= 0 && w.ptIns[i] === 0; i--) {
        bodyHash.insert(w, pts[i][0], pts[i][1]);
        w.ptIns[i] = 1;
      }
      trimPath(w);
      // drop trimmed tail points out of the hash (exact, flag-driven)
      const rem = takeRemovedPoints();
      for (let i = 0; i < rem.points.length; i++) {
        if (rem.flags[i]) this.world.removeBodyPoint(w, rem.points[i][0], rem.points[i][1]);
      }

      // arena wall
      const d = Math.hypot(w.x, w.y);
      if (d > CFG.ARENA_R) {
        this.killWorm(w, null, drops);
      }
    }

    // 2) Head collisions against the incrementally maintained body index.
    // PERF: worm array + collision scratch built once (was two [...clients]
    // spreads + .map() per worm per tick).
    const wormsArr = this._wormsScratch;
    wormsArr.length = 0;
    for (const c of this.clients.values()) wormsArr.push(c.worm);
    for (const c of this.clients.values()) {
      const w = c.worm;
      if (w.dead) continue;
      const hit = this.world.collideHead(w, wormsArr, this.world.bodyHash);
      if (hit && w.protectT <= 0) {
        this.killWorm(w, hit, drops);
        // award score to killer via kill feed (len already gained in killWorm)
      }
    }

    // 3) Eating (food + pellets) near each head — hashes are maintained
    // incrementally now (spawn/eat/expire), so the old per-tick full rebuilds
    // (2600+ food inserts x 30Hz) are gone.
    const foodHash = this.world.foodHash;
    const pelHash = this.world.pelletHash;
    const cand = this._candScratch;
    for (const c of this.clients.values()) {
      const w = c.worm;
      if (w.dead) continue;
      const reach = radiusAt(w.len) + 30;
      const reach2 = reach * reach;
      foodHash.queryCircle(w.x, w.y, reach, cand);
      for (const f of cand) {
        if (f.dead) continue;
        const dx = f.x - w.x, dy = f.y - w.y;
        if (dx * dx + dy * dy < reach2) {
          f.dead = true;
          this.world.removeFood(f);
          this.foodDelRecent.push(f.id); // global delete broadcast
          gain(w, f.v);
          this.world.spawnFood(); // re-inserts itself into the hash
        }
      }
      pelHash.queryCircle(w.x, w.y, reach, cand);
      for (const p of cand) {
        if (p.dead) continue;
        const dx = p.x - w.x, dy = p.y - w.y;
        if (dx * dx + dy * dy < reach2) {
          p.dead = true;
          this.world.removePellet(p);
          gain(w, p.v);
        }
      }
    }

    // 4) Pellet lifetime
    this.world.prunePellets(Date.now());

    // 5) Remove dead worms from the room (clients already got death info via snapshot events)
    for (const [id, c] of this.clients) {
      if (c.worm.dead) {
        this.purgeBodyIndex(c.worm);
        if (!c.isBot && c.ws && c.ws.readyState === 1) {
          try { c.ws.send(JSON.stringify({ t: 'died', by: this.lastKillerOf(c.worm) })); } catch (e) { /* ignore */ }
        }
        this.clients.delete(id);
        this.clientSync.delete(id);
      }
    }

    this.lastDrops = drops; // consumed by broadcastSnapshot
  }

  lastKillerOf(w) {
    for (let i = this.kills.length - 1; i >= 0; i--) {
      if (this.kills[i].victimName === w.name) return this.kills[i].killerName;
    }
    return 'the arena';
  }

  leaderboard() {
    // PERF: cached for ~8 ticks (~266ms) — building + sorting the array at
    // 20Hz snapshot rate was redundant; it changes at most a few times/sec.
    if (this._lb && this.tickNum - this._lbAt < 8) return this._lb;
    const arr = [...this.clients.values()].map((c) => ({
      id: c.worm.id,
      name: c.name,
      score: Math.floor(c.worm.len),
      kills: c.worm.kills,
      hue: c.worm.hue,
    }));
    arr.sort((a, b) => b.score - a.score);
    const top = arr.slice(0, 10);
    this._lb = top;
    this._lbAt = this.tickNum;
    return top;
  }

  broadcastSnapshot() {
    const now = Date.now();
    const drops = this.lastDrops || [];
    this.lastDrops = [];

    // Food ids deleted since last broadcast — sent to EVERY client so nobody
    // keeps rendering "ghost" food that someone else already ate.
    const globalFoodDel = this.foodDelRecent;
    this.foodDelRecent = [];

    // Build compact worm list once
    const wormsPayload = [];
    for (const c of this.clients.values()) {
      const w = c.worm;
      wormsPayload.push([
        w.id, w.hue, w.skin,
        Math.round(w.x * 10) / 10, Math.round(w.y * 10) / 10,
        Math.round(w.dir * 1000) / 1000,
        Math.round(w.len),
        w.boosting ? 1 : 0,
        w.protectT > 0 ? 1 : 0,
      ]);
    }

    const lb = this.leaderboard();

    // PERF: per-BROADCAST hoisted work (was re-computed per client):
    // drops mapping, kills tail, global delete list.
    const killsTail = this.kills.slice(-5);
    const newPellets = new Array(drops.length);
    for (let i = 0; i < drops.length; i++) {
      const p = drops[i];
      newPellets[i] = { i: p.id, x: Math.round(p.x), y: Math.round(p.y), r: Math.round(p.r), v: p.v, h: p.hue };
    }

    for (const [id, c] of this.clients) {
      if (c.isBot || !c.ws || c.ws.readyState !== 1) continue;
      const sync = this.clientSync.get(id);
      if (!sync) continue;

      // Drops (new pellets) go to everyone — hoisted above

      // Delta food: send food within view the client hasn't seen yet, then
      // FORGET ids beyond view so returning to an area re-delivers its food
      // (the client prunes far food locally — without this, revisited areas
      // would show invisible "ghost-empty" patches you pass over).
      const w = c.worm;
      const view = sync.vr || 1600;
      const view2 = view * view;
      const foodHash = this.world.foodHash;
      const cand = [];
      foodHash.queryCircle(w.x, w.y, view, cand);
      const newFood = [];
      const seen = sync.foodSeen;
      for (const f of cand) {
        if (f.dead) continue; // deletions reach every client via global foodDel
        const dx = f.x - w.x, dy = f.y - w.y;
        if (dx * dx + dy * dy > view2) continue; // outside exact radius
        if (!seen.has(f.id)) {
          seen.add(f.id);
          newFood.push({ i: f.id, x: Math.round(f.x), y: Math.round(f.y), r: Math.round(f.r), v: f.v, h: f.hue });
        }
      }
      for (const fid of seen) {
        const f = this.world.food.get(fid);
        if (!f) { seen.delete(fid); continue; }
        const dx = f.x - w.x, dy = f.y - w.y;
        if (dx * dx + dy * dy > view2) seen.delete(fid);
      }
      // Deletes = every food removed since the last broadcast (global)
      const foodRemove = globalFoodDel; // shared, never mutated here
      for (const fid of globalFoodDel) seen.delete(fid);
      // Safety bound (in-view set is naturally ~2k max; this should rarely hit)
      if (seen.size > 6000) seen.clear();

      // Pellets: send all visible ones each time (they are transient)
      const pelCand = [];
      this.world.pelletHash.queryCircle(w.x, w.y, view, pelCand);
      const pellets = [];
      for (const p of pelCand) {
        if (p.dead) continue;
        pellets.push({ i: p.id, x: Math.round(p.x), y: Math.round(p.y), r: Math.round(p.r), v: p.v, h: p.hue });
      }

      const snap = {
        t: 'snap',
        tick: this.tickNum,
        you: id,
        youKills: c.worm.kills,
        time: now,
        worms: wormsPayload,
        foodNew: newFood,
        foodDel: foodRemove,
        pellets,
        pelNew: newPellets,
        lb,
        kills: killsTail,
      };
      try { c.ws.send(JSON.stringify(snap)); } catch (e) { /* ignore */ }
    }
  }

  start() {
    const tickMs = 1000 / CFG.TICK_HZ;
    const netMs = 1000 / CFG.NET_HZ;
    this.lastTickAt = Date.now();
    this.tickTimer = setInterval(() => {
      try {
        const now = Date.now();
        let dt = (now - this.lastTickAt) / 1000;
        this.lastTickAt = now;
        if (dt > 0.25) dt = 0.25;
        this.tick(dt);
      } catch (e) {
        console.error('[room tick error]', e);
      }
    }, tickMs);
    this.netTimer = setInterval(() => {
      try { this.broadcastSnapshot(); } catch (e) { console.error('[snapshot error]', e); }
    }, netMs);
  }

  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.netTimer) clearInterval(this.netTimer);
    this.tickTimer = null;
    this.netTimer = null;
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
    setInterval(() => this.gc(), 30000);
  }

  // Sockets parked on the death screen (worm gone) are NOT in room.clients —
  // track them separately so GC never strands a live player in a deleted room.
  trackSocket(room, ws) {
    if (!room.sockets) room.sockets = new Set();
    room.sockets.add(ws);
  }

  untrackSocket(room, ws) {
    if (room.sockets) room.sockets.delete(ws);
  }

  create(maxPlayers, isPrivate = true) {
    const room = new Room(maxPlayers, isPrivate);
    // avoid code collision
    while (this.rooms.has(room.code)) room.code = randomCode();
    this.rooms.set(room.code, room);
    room.start();
    return room;
  }

  // Quick-play matchmaking: join the busiest non-private room with space.
  // Private (code) rooms are NEVER matched into — they stay friends-only.
  findPublic() {
    let best = null;
    for (const room of this.rooms.values()) {
      if (room.isPrivate || room.isFull()) continue;
      if (!best || room.clients.size > best.clients.size) best = room;
    }
    return best;
  }

  get(code) {
    return this.rooms.get(String(code));
  }

  joinOrCreate(code, maxPlayers) {
    const existing = this.get(code);
    if (existing) return existing;
    return this.create(maxPlayers);
  }

  gc() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const sockets = room.sockets || new Set();
      let live = 0;
      for (const ws of sockets) if (ws.readyState === 1) live++;
      if (live === 0 && room.clients.size === 0 && now - room.emptySince > 120000) {
        room.stop();
        this.rooms.delete(code);
      } else if (live === 0 && room.clients.size === 0) {
        // remember when it became empty
        if (!room.emptySince || room.emptySince < now - 120000) room.emptySince = now;
      } else {
        room.emptySince = now;
      }
    }
  }

  stats() {
    let players = 0;
    for (const room of this.rooms.values()) players += room.clients.size;
    return { rooms: this.rooms.size, players };
  }
}

module.exports = { Room, RoomManager, clampPlayerLimit, randomCode };
