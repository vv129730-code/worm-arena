'use strict';
/* End-to-end bot: connects like a real client over WebSocket.
   Run: node test/bot.js [roomCode] — if no code, creates a room. */

const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://127.0.0.1:3000';

const ws = new WebSocket(URL);
let myId = null;
let lastSnap = 0;
let snaps = 0;
let targetDir = Math.random() * Math.PI * 2;

ws.on('open', () => {
  const code = process.argv[2];
  if (code) {
    ws.send(JSON.stringify({ t: 'join', name: 'BotClient', code, skin: 0 }));
  } else {
    ws.send(JSON.stringify({ t: 'create', name: 'BotClient', maxPlayers: 8, skin: 0 }));
  }
  console.log(`[bot] connecting to ${URL}${code ? ` room ${code}` : ' (new room)'}`);
});

ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.t === 'welcome') {
    myId = msg.id;
    console.log(`[bot] joined room ${msg.roomCode} as worm #${msg.id}`);
  } else if (msg.t === 'error') {
    console.error(`[bot] server error: ${msg.msg}`);
    process.exit(1);
  } else if (msg.t === 'snap') {
    snaps++;
    lastSnap = Date.now();
    // wander: occasionally change heading; boost sometimes
    if (Math.random() < 0.02) targetDir = Math.random() * Math.PI * 2;
    const me = msg.worms.find((row) => row[0] === myId);
    if (me && Math.hypot(me[3], me[4]) > 3500) {
      targetDir = Math.atan2(-me[4], -me[3]); // steer to center near wall
    }
  } else if (msg.t === 'died') {
    console.log('[bot] died, respawning');
    setTimeout(() => ws.send(JSON.stringify({ t: 'respawn', name: 'BotClient', skin: 0 })), 500);
  }
});

// input stream at ~20Hz
setInterval(() => {
  if (ws.readyState === 1 && myId !== null) {
    ws.send(JSON.stringify({ t: 'input', dir: targetDir, boost: Math.random() < 0.05 }));
  }
}, 50);

// ack stream
setInterval(() => {
  if (ws.readyState === 1 && myId !== null) ws.send(JSON.stringify({ t: 'ack', tick: 0 }));
}, 500);

// report + exit
const RUN_MS = Number(process.env.BOT_RUN_MS) || 8000;
setTimeout(() => {
  const alive = lastSnap && (Date.now() - lastSnap < 2000);
  console.log(`[bot] received ${snaps} snapshots; last ${lastSnap ? Date.now() - lastSnap : 'never'}ms ago → ${alive ? 'LIVE ✅' : 'DEAD ❌'}`);
  process.exit(alive ? 0 : 1);
}, RUN_MS);

ws.on('error', (e) => {
  console.error('[bot] socket error:', e.message);
  process.exit(1);
});
