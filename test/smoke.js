'use strict';
/* Smoke test: pure game-logic checks without network (run: npm test) */

const assert = require('assert');
const { CFG } = require('../src/game/constants');
const { Room, clampPlayerLimit, randomCode } = require('../src/game/room');
const { radiusAt, speedAt } = require('../src/game/worm');

function approx(a, b, eps) {
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`);
}

// --- room basics ---
const room = new Room(10);
assert.ok(/^\d{6}$/.test(room.code), 'room code is 6 digits');
assert.strictEqual(room.maxPlayers, 10);

// bot join
const bot = room.addClient(null, 'Bot1', 0, true);
assert.ok(bot, 'bot joined');

// tick the room by hand
for (let i = 0; i < 60; i++) room.tick(1 / 30);
const w = bot.worm;
assert.ok(w.len >= CFG.START_LEN, 'worm still at start-ish length');

// movement happened
assert.ok(w.points.length > 2, 'worm laid a path');

// wall death: teleport head outside arena
w.x = CFG.ARENA_R + 50;
w.y = 0;
room.tick(1 / 30);
assert.ok(w.dead, 'worm died at wall');
assert.ok(room.world.pellets.size > 0, 'death dropped pellets');

// --- kill collision: one worm slams into another's body ---
const room2 = new Room(4);
const a = room2.addClient(null, 'A', 0, true).worm;
const b = room2.addClient(null, 'B', 0, true).worm;
a.len = 60; // grow A so its body is long enough to be an obstacle
for (let i = 0; i < 90; i++) room2.tick(1 / 30); // lay path

// place B's head right on A's mid-body, heading straight into it
const mid = a.points[Math.floor(a.points.length / 2)];
b.x = mid[0]; b.y = mid[1];
b.dir = a.dir;
b.protectT = 0;
room2.tick(1 / 30);
assert.ok(b.dead, 'B died by hitting A body');
assert.strictEqual(a.kills, 1, 'A got the kill credit');
assert.ok(room2.kills.length > 0, 'kill feed recorded');

// --- boost economy: boosting drains length and drops pellets ---
const room3 = new Room(4);
const c = room3.addClient(null, 'C', 0, true).worm;
c.len = 40;
for (let i = 0; i < 60; i++) room3.tick(1 / 30);
const lenBefore = c.len;
const pelletsBefore = room3.world.pellets.size;
c.boostWish = true;
for (let i = 0; i < 30; i++) room3.tick(1 / 30);
assert.ok(c.len < lenBefore, 'boost drained length');
assert.ok(room3.world.pellets.size > pelletsBefore, 'boost dropped pellets');

// --- eating grows the worm ---
const room4 = new Room(4);
const d = room4.addClient(null, 'D', 0, true).worm;
// put food right at the head
const f0 = room4.world.food.values().next().value;
d.x = f0.x; d.y = f0.y;
const lenBeforeEat = d.len;
room4.tick(1 / 30);
assert.ok(d.len > lenBeforeEat, 'eating food grew the worm');

// --- room full check ---
const room5 = new Room(2);
assert.ok(room5.addClient(null, 'P1', 0, true), 'first player ok');
assert.ok(room5.addClient(null, 'P2', 0, true), 'second player ok');
assert.strictEqual(room5.addClient(null, 'P3', 0, true), null, 'third rejected when full');

// --- clamp + code helpers ---
assert.strictEqual(clampPlayerLimit(1), 2);
assert.strictEqual(clampPlayerLimit(99), 50);
assert.strictEqual(clampPlayerLimit('abc'), CFG.DEFAULT_MAX_PLAYERS);
assert.ok(/^\d{6}$/.test(randomCode()));

// --- sanity of tuning curves ---
assert.ok(radiusAt(10) < radiusAt(200), 'radius grows with length');
assert.ok(speedAt(10) > speedAt(300), 'speed drops slightly with length');

// --- growth/curve economy (post-taper tuning) ---
const { growthWeight } = require('../src/game/worm');
const { World } = require('../src/game/world');

// 1) Length must keep growing past the old 500 cap (soft-cap taper, no hard stop)
const wLong = { len: 700, score: 0 };
require('../src/game/worm').gain(wLong, 100);
assert.ok(wLong.len > 700, `length grows past 700 (got ${wLong.len})`);
assert.ok(wLong.len < 800, 'taper slows growth beyond soft cap');

// 2) Radius keeps creeping up but slowly at giant sizes (log phase)
const rSoft = radiusAt(240);   // taper boundary ~58
const rGiant = radiusAt(5000); // should be well under the old sqrt curve (~203)
assert.ok(rGiant > rSoft, 'giant worm still thicker than small');
assert.ok(rGiant < 110, `giant radius stays navigable (got ${rGiant.toFixed(1)})`);

// 3) Food respawn clusters near surviving food (fast local refill).
// Robust check: median distance-to-nearest-neighbor must be far below the
// arena radius when respawning a large batch (clustered), unlike uniform.
const world2 = new World();
world2.ensureFood();
const keep = 40;
let kept = 0;
for (const [id, f] of world2.food) { if (kept++ >= keep) world2.food.delete(id); }
for (let i = 0; i < 600; i++) world2.spawnFood();
const dists = [];
for (const f of world2.food.values()) {
  let best = Infinity;
  for (const g of world2.food.values()) {
    if (f.id === g.id) continue;
    const d = Math.hypot(f.x - g.x, f.y - g.y);
    if (d < best) best = d;
  }
  if (best < Infinity) dists.push(best);
}
dists.sort((a, b) => a - b);
const medianNN = dists[dists.length >> 1];
assert.ok(medianNN < CFG.ARENA_R * 0.15, `respawn clusters (median NN ${Math.round(medianNN)} < ${Math.round(CFG.ARENA_R * 0.15)})`);

// --- ghost-food fix: a deletion by one eater must reach every other client ---
const room6 = new Room(4);
const e1 = room6.addClient({ readyState: 1, sent: [], send(d) { this.sent.push(d); } }, 'Eater', 0, false);
const e2 = room6.addClient({ readyState: 1, sent: [], send(d) { this.sent.push(d); } }, 'Watcher', 0, false);
room6.tick(1 / 30);
room6.broadcastSnapshot();

// Both clients must have received a snapshot containing the shared food id
const snaps1 = e1.ws.sent.map(JSON.parse).filter((m) => m.t === 'snap');
assert.ok(snaps1.length > 0 && snaps1[0].foodNew && snaps1[0].foodNew.length > 0, 'first snapshot has food');
const sharedId = snaps1[0].foodNew[0].i;

// Eater teleports onto that food and eats it
const fEat = room6.world.food.get(sharedId);
e1.worm.x = fEat.x; e1.worm.y = fEat.y;
room6.tick(1 / 30);
assert.ok(!room6.world.food.has(sharedId), 'food deleted server-side');

// Next broadcast must tell BOTH clients to delete it (no ghost food anywhere)
room6.broadcastSnapshot();
const s1 = JSON.parse(e1.ws.sent[e1.ws.sent.length - 1]);
const s2 = JSON.parse(e2.ws.sent[e2.ws.sent.length - 1]);
assert.ok(s1.foodDel.includes(sharedId), 'eater told to delete');
assert.ok(s2.foodDel.includes(sharedId), 'watcher ALSO told to delete (ghost-food fix)');

// --- view-radius: server honors client-reported vr (clamped) ---
const room7 = new Room(4);
const v1 = room7.addClient({ readyState: 1, sent: [], send(d) { this.sent.push(d); } }, 'Zoomed', 0, false);
room7.handleInput(v1.worm, { t: 'input', dir: 0, boost: false, vr: 9999 });
room7.tick(1 / 30);
room7.broadcastSnapshot();
const vs = JSON.parse(v1.ws.sent[v1.ws.sent.length - 1]);
// A huge vr would stream the whole map; clamped to 3200 it must stay bounded
assert.ok(vs.foodNew.length < room7.world.food.size, 'vr clamp keeps snapshot bounded');

console.log('✅ smoke: all logic tests passed');
