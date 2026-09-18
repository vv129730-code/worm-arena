'use strict';
/* Food streaming probe: join a room, log per-snapshot foodNew/foodDel counts. Usage: node test/foodprobe.js [roomCode] */

const WebSocket = require('ws');
const code = process.argv[2] || '';
const ws = new WebSocket(`ws://127.0.0.1:3000/`);

let snaps = 0;
ws.on('open', () => {
  ws.send(JSON.stringify(code
    ? { t: 'join', code, name: 'Probe', skin: 0 }
    : { t: 'create', maxPlayers: 4, name: 'Probe', skin: 0 }));
  console.log('connected, joining...');
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t !== 'snap') return;
  snaps++;
  if (snaps <= 12 || snaps % 10 === 0) {
    console.log(`snap#${snaps} tick=${m.tick} worms=${m.worms.length} foodNew=${(m.foodNew||[]).length} foodDel=${(m.foodDel||[]).length} pellets=${(m.pellets||[]).length}`);
  }
  if (snaps >= 40) { console.log('done'); ws.close(); process.exit(0); }
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
setTimeout(() => { console.log('timeout'); process.exit(2); }, 12000);
