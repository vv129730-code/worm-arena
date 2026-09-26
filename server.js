'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { WebSocketServer } = require('ws');

const { CFG } = require('./src/game/constants');
const { RoomManager, clampPlayerLimit } = require('./src/game/room');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Crash guard: never die silently — log to .freebuff/server-crash.log
const CRASH_LOG = path.join(__dirname, '.freebuff', 'server-crash.log');
function logCrash(kind, err) {
  try {
    fs.appendFileSync(CRASH_LOG, `${new Date().toISOString()} ${kind}: ${err && err.stack ? err.stack : err}\n`);
  } catch (e) { /* ignore */ }
  console.error(`[${kind}]`, err);
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// PERF: static files cached in memory (mtime-invalidated) — the old code did
// fs.readFile for EVERY asset request; client.js is fetched by every player.
const staticCache = new Map(); // path -> {data, mtimeMs}
function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const serve = (data) => {
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  };
  fs.stat(filePath, (err, st) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const hit = staticCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs) { serve(hit.data); return; }
    fs.readFile(filePath, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      staticCache.set(filePath, { data, mtimeMs: st.mtimeMs });
      serve(data);
    });
  });
}

const manager = new RoomManager();

const server = http.createServer((req, res) => {
  if (req.url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manager.stats()));
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

function safeName(raw) {
  let name = String(raw || '').trim().slice(0, 16);
  if (!name) name = 'Worm';
  return name;
}

function safeHue(raw) {
  const n = Number(raw);
  return (Number.isFinite(n)) ? n : undefined;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;      // Room instance once joined
  ws.wormId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    const room = ws.room;
    if (!room) {
      if (msg.t === 'quick') {
        // Quick play: match into any open public room (never private ones).
        let target = manager.findPublic();
        if (!target) target = manager.create(clampPlayerLimit(msg.maxPlayers) || 10, false);
        attach(ws, target, msg);
      } else if (msg.t === 'create') {
        // Player-created rooms are always PRIVATE (code-only entry).
        const maxPlayers = clampPlayerLimit(msg.maxPlayers);
        const newRoom = manager.create(maxPlayers, true);
        attach(ws, newRoom, msg);
      } else if (msg.t === 'join') {
        const existing = manager.get(String(msg.code || ''));
        if (!existing) {
          ws.send(JSON.stringify({ t: 'error', msg: 'Room not found. Check the 6-digit code.' }));
          return;
        }
        if (existing.isFull()) {
          ws.send(JSON.stringify({ t: 'error', msg: `Room is full (max ${existing.maxPlayers}).` }));
          return;
        }
        attach(ws, existing, msg);
      }
      return;
    }

    if (msg.t === 'respawn') {
      if (!manager.get(room.code)) { // room was GC'd while player sat on death screen
        ws.send(JSON.stringify({ t: 'closed' }));
        ws.room = null;
        return;
      }
      if (ws.wormId && room.clients.has(ws.wormId)) return; // still alive
      if (room.isFull()) {
        ws.send(JSON.stringify({ t: 'error', msg: 'Room is full.' }));
        return;
      }
      ws.wormId = null;
      const entry = room.addClient(ws, safeName(msg.name || ws.lastName), msg.skin | 0, false, safeHue(msg.hue));
      if (entry) ws.wormId = entry.worm.id;
      return;
    }

    if (ws.wormId) {
      const entry = room.clients.get(ws.wormId);
      if (entry) room.handleInput(entry.worm, msg);
    }
  });

  ws.on('close', () => {
    if (ws.room) manager.untrackSocket(ws.room, ws);
    if (ws.room && ws.wormId) ws.room.removeClient(ws.wormId);
    ws.room = null;
    ws.wormId = null;
  });

  ws.on('error', () => { /* ignore socket errors */ });

  function attach(socket, roomObj, msg) {
    socket.room = roomObj;
    manager.trackSocket(roomObj, socket);
    socket.lastName = safeName(msg.name);
    const entry = roomObj.addClient(socket, socket.lastName, (msg.skin | 0) || 0, false, safeHue(msg.hue));
    if (!entry) {
      socket.send(JSON.stringify({ t: 'error', msg: 'Room is full.' }));
      socket.room = null;
      return;
    }
    socket.wormId = entry.worm.id;
  }
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);
heartbeat.unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[worm-arena] listening on http://0.0.0.0:${PORT}`);
  console.log('[worm-arena] LAN/internet play: forward this port on your router (see README.md)');
});
