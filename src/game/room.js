'use strict';

const crypto = require('crypto');
const { CFG } = require('./constants');
const worm = require('./worm');
const worldMod = require('./world');

const World = worldMod.World;
const {
  newWorm, advance, trimPath, steer, stepHeading,
  gain, speedAt, radiusAt, clamp,
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
  constructor(maxPlayers) {
    this.code = randomCode();
    this.maxPlayers = clampPlayerLimit(maxPlayers);
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

  addClient(ws, name, skin, isBot) {
    if (this.isFull()) return null;
    const id = nextWormId++;
    const pos = this.pickSpawn();
    const hue = Math.floor(Math.random() * 360);
    const w = newWorm(id, name, hue, skin, pos.x, pos.y);
    const entry = { ws, worm: w, isBot: !!isBot, name };
    this.clients.set(id, entry);
    this.clientSync.set(id, { lastAckTick: 0, foodSeen: new Set(), pelletSeen: new Set(), vr: 1600 });
    if (!isBot && ws) {
      ws.send(JSON.stringify({ t: 'welcome', id, roomCode: this.code, maxPlayers: this.maxPlayers, tickHz: CFG.TICK_HZ }));
      this.broadcastElse({ t: 'chat', name: 'SYSTEM', text: `${name} joined the arena`, hue: null }, id);
    }
    return entry;
  }

  removeClient(id) {
    const entry = this.clients.get(id);
    if (!entry) return;
    this.clients.delete(id);
    this.clientSync.delete(id);
    entry.worm.dead = true;
    if (!entry.isBot) {
      this.broadcast({ t: 'chat', name: 'SYSTEM', text: `${entry.name} left the arena`, hue: null });
    }
  }

  pickSpawn() {
    for (let tries = 0; tries < 24; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = CFG.SPAWN_RADIUS_MIN + Math.random() * (CFG.SPAWN_RADIUS_MAX - CFG.SPAWN_RADIUS_MIN);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      let ok = true;
      for (const c of this.clients.values()) {
        const w = c.worm;
        if (Math.hypot(w.x - x, w.y - y) < 380) { ok = false; break; }
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
      trimPath(w);

      // arena wall
      const d = Math.hypot(w.x, w.y);
      if (d > CFG.ARENA_R) {
        this.killWorm(w, null, drops);
      }
    }

    // 2) Body index + head collisions
    this.world.buildBodyIndex([...this.clients.values()].map((c) => c.worm));
    for (const c of this.clients.values()) {
      const w = c.worm;
      if (w.dead) continue;
      const hit = this.world.collideHead(w, [...this.clients.values()].map((x) => x.worm), this.world.bodyHash);
      if (hit && w.protectT <= 0) {
        this.killWorm(w, hit, drops);
        // award score to killer via kill feed (len already gained in killWorm)
      }
    }

    // 3) Eating (food + pellets) near each head
    const foodHash = this.world.rebuildFoodHash();
    const pelHash = this.world.rebuildPelletHash();
    for (const c of this.clients.values()) {
      const w = c.worm;
      if (w.dead) continue;
      const reach = radiusAt(w.len) + 30;
      const cand = [];
      foodHash.queryCircle(w.x, w.y, reach, cand);
      for (const f of cand) {
        if (f.dead) continue;
        if (Math.hypot(f.x - w.x, f.y - w.y) < reach) {
          f.dead = true;
          this.world.food.delete(f.id);
          this.foodDelRecent.push(f.id); // global delete broadcast
          gain(w, f.v);
          this.world.spawnFood();
        }
      }
      cand.length = 0;
      pelHash.queryCircle(w.x, w.y, reach, cand);
      for (const p of cand) {
        if (p.dead) continue;
        if (Math.hypot(p.x - w.x, p.y - w.y) < reach) {
          p.dead = true;
          this.world.pellets.delete(p.id);
          gain(w, p.v);
        }
      }
    }

    // 4) Pellet lifetime
    this.world.prunePellets(Date.now());

    // 5) Remove dead worms from the room (clients already got death info via snapshot events)
    for (const [id, c] of this.clients) {
      if (c.worm.dead) {
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
    const arr = [...this.clients.values()].map((c) => ({
      id: c.worm.id,
      name: c.name,
      score: Math.floor(c.worm.len),
      kills: c.worm.kills,
      hue: c.worm.hue,
    }));
    arr.sort((a, b) => b.score - a.score);
    return arr.slice(0, 10);
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

    for (const [id, c] of this.clients) {
      if (c.isBot || !c.ws || c.ws.readyState !== 1) continue;
      const sync = this.clientSync.get(id);
      if (!sync) continue;

      // Drops (new pellets) go to everyone
      const newPellets = drops.map((p) => ({ i: p.id, x: Math.round(p.x), y: Math.round(p.y), r: Math.round(p.r), v: p.v, h: p.hue }));

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
      const foodRemove = [...globalFoodDel];
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
        time: now,
        worms: wormsPayload,
        foodNew: newFood,
        foodDel: foodRemove,
        pellets,
        pelNew: newPellets,
        lb,
        kills: this.kills.slice(-5),
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

  create(maxPlayers) {
    const room = new Room(maxPlayers);
    // avoid code collision
    while (this.rooms.has(room.code)) room.code = randomCode();
    this.rooms.set(room.code, room);
    room.start();
    return room;
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
      if (room.clients.size === 0 && now - room.emptySince > 120000) {
        room.stop();
        this.rooms.delete(code);
      } else if (room.clients.size === 0) {
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
