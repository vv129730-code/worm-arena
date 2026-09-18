# 🐍 Worm Arena — Private Multiplayer

Slither.io / *Snake vs Worms* style game, **fully private**: sirf 6-digit room code wale hi join kar sakte hain. 2–50 players (host decide karta hai). No accounts, no public servers.

## Quick start

```bash
npm install
npm start
```

Server starts on **http://localhost:3000**.

- **Host**: name + player limit (2–50) daalo → room code generate hoga (6 digits).
- **Friends**: "Join" tab me name + room code daalo.

## Same Wi-Fi (LAN) pe khelna

1. Apna local IP nikalo:
   - Windows: `ipconfig` → "IPv4 Address" (e.g. `192.168.1.5`)
   - Mac/Linux: `ifconfig` ya `ip addr`
2. Friends browser me kholo: `http://192.168.1.5:3000`

Windows Firewall pehle baar block kar sakta hai — "Allow access" (Private networks) karo.

## Internet pe khelna (port-forwarding)

1. Router admin panel kholo (usually `http://192.168.1.1` ya `http://192.168.0.1`).
2. **Port Forwarding / Virtual Server** section me jao.
3. Rule banao:
   - External port: `3000` (ya koi bhi, e.g. `8080`)
   - Internal IP: tumhare PC ka local IP (step above)
   - Internal port: `3000`
   - Protocol: **TCP**
4. Save karo. Ab friends ko apna **public IP** do (google "what is my ip").
5. Link: `http://YOUR-PUBLIC-IP:3000`

Notes:
- Agar ISP CGNAT ke peeche hai (port forward kaam na kare), to Cloudflare Tunnel, ngrok, ya playit.gg use karo:
  ```bash
  npx ngrok http 3000
  ```
  Jo URL mile, wahi share karo.
- Port badalna ho: `PORT=8080 npm start` (Windows PowerShell: `$env:PORT=8080; npm start`)

## Cloud pe host karna (PC band ho tab bhi chale) ☁️

Repo GitHub pe push karo, phir Render free tier pe deploy karo — fixed public URL milega:

1. GitHub pe naya repo banao: [github.com/new](https://github.com/new) (e.g. `worm-arena`)
2. Push karo:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/worm-arena.git
   git push -u origin main
   ```
3. [render.com](https://render.com) → GitHub se sign-in → **New → Web Service** → repo select karo
4. `render.yaml` Blueprint sab settings auto-fill karta hai (region: Singapore, free instance) → **Create Web Service**
5. 2–3 min me live URL: `https://worm-arena-xxxx.onrender.com` — wahi friends ko share karo

Notes:
- Free tier: 15 min idle ke baad server so jata hai; agli visit pe ~50s "waking up", uske baad sab normal
- Rooms memory me hain — spin-down ke baad room code reset ho jata hai (naya bana lo)
- Koi code change nahi chahiye — client `wss://location.host` use karta hai, server `process.env.PORT` padhta hai

## Gameplay

- **Steer**: mouse (ya touch) — worm auto-forward chalta hai
- **Boost**: click/hold mouse ya **Space** — speed ×1.9, par length drain hoti hai (13 se kam length pe boost off)
- **Food**: dots khao → bade bano
- **Kill**: kisi ke body se takrao to tum maroge; **dusre ka head tumhare body se takraye to wo marega** — uski length pellets ban ke girti hai
- **Border**: red circle se bahar mat jao
- Mara to **Respawn** karo, ya naya room join karo

## Architecture

```
server.js              HTTP static + WebSocket + room manager
src/game/constants.js  tuning knobs (speeds, arena, economy)
src/game/worm.js       movement, path recording, boost economy
src/game/world.js      food/pellets, spatial hashes, death drops
src/game/room.js       30Hz tick, collisions, eating, snapshots, leaderboard
public/                client (canvas renderer, input, HUD, minimap)
test/smoke.js          logic tests (npm test)
test/bot.js            WebSocket end-to-end bot
```

- Tick rate: 30 Hz (server sim), 20 Hz snapshots, delta food, visible-only pellets
- Server-authoritative: client sirf input bhejta hai (steer dir + boost wish)
- Room GC: 2 min empty hone par room delete

## Tests

```bash
npm test          # pure logic smoke tests
node test/bot.js  # live server chahiye; joins, wanders, reports snapshot health
```
