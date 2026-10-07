// Rebond — standalone server: serves the game, relays multiplayer presence over WebSocket and keeps the leaderboards.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// The game files normally live in ./public, but a flat upload (everything at the root) works too.
const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const ALLOWED = new Set(['.html', '.js', '.css', '.woff2', '.png', '.svg']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ---------- leaderboards: each player's best time per board (level + difficulty, or random layout) ----------
// Kept in memory and saved to lb.json (DATA_DIR or this folder). A free host that wipes its disk on
// restart loses it, but every player pushes their own best times back when they look at a board.
const LB_FILE = path.join(process.env.DATA_DIR || __dirname, 'lb.json');
const LB_KEY = /^[LG][0-9]{1,6}-[0-2]$/, LB_PID = /^[a-z0-9]{8,24}$/;
let boards = new Map();
try { const j = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); for (const k in j) if (LB_KEY.test(k)) boards.set(k, new Map(Object.entries(j[k]))); } catch (e) { /* first start */ }
let lbDirty = null;
function lbSave() {
  if (lbDirty) return;
  lbDirty = setTimeout(() => {
    lbDirty = null;
    const out = {};
    for (const [k, m] of boards) out[k] = Object.fromEntries(m);
    fs.writeFile(LB_FILE, JSON.stringify(out), () => {});
  }, 2000);
}
function lbList(k) {
  const m = boards.get(k);
  if (!m) return [];
  return [...m].map(([p, e]) => ({ p, n: e.n, c: e.c, t: e.t })).sort((a, b) => a.t - b.t).slice(0, 200);
}
function lbSubmit(b) {
  if (!b || typeof b !== 'object' || !LB_PID.test(String(b.p || '')) || !b.recs || typeof b.recs !== 'object') return false;
  const n = String(b.n || 'Joueur').replace(/[<>]/g, '').slice(0, 16) || 'Joueur', c = Math.max(0, Math.min(7, b.c | 0));
  let k = 0;
  for (const key in b.recs) {
    if (++k > 40) break;
    const t = Math.round(+b.recs[key]);
    if (!LB_KEY.test(key) || !(t >= 1500 && t <= 3600000)) continue;
    if (!boards.has(key)) { if (boards.size >= 5000) continue; boards.set(key, new Map()); }
    const m = boards.get(key), e = m.get(b.p);
    if (!e || t < e.t) { if (!e && m.size >= 500) continue; m.set(b.p, { n, c, t }); lbSave(); }
    else if (e.n !== n || e.c !== c) { e.n = n; e.c = c; lbSave(); }
  }
  return true;
}
function lbApi(req, res, query) {
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (req.method === 'GET') {
    const keys = String(query.get('keys') || '').split(',').filter(k => LB_KEY.test(k)).slice(0, 20);
    const out = {};
    for (const k of keys) out[k] = lbList(k);
    return json(200, { ok: true, boards: out });
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) req.destroy(); });
    req.on('end', () => { let b = null; try { b = JSON.parse(body); } catch (e) { /* bad body */ } json(lbSubmit(b) ? 200 : 400, { ok: true }); });
    return;
  }
  json(405, { ok: false });
}

const server = http.createServer((req, res) => {
  let url = '/';
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { /* keep / */ }
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/api/lb') return lbApi(req, res, new URL(req.url, 'http://x').searchParams);
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUB, url));
  if (!file.startsWith(PUB) || !ALLOWED.has(path.extname(file)) || /server\.js$|package/.test(file)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (url === '/index.html') {
        const here = fs.readdirSync(__dirname).join(', ');
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Le fichier index.html du jeu est introuvable sur le serveur.\nAjoute le dossier public (index.html, three.min.js, room-shim.js) dans le dépôt GitHub.\nFichiers présents : ' + here);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=86400'
    });
    res.end(data);
  });
});

// rooms: name -> Map(peer -> { ws, presence })
const rooms = new Map();
const ROOM_NAME = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const MAX_PER_ROOM = 64;

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(name, msg, exceptPeer) {
  const r = rooms.get(name);
  if (!r) return;
  const s = JSON.stringify(msg);
  for (const [peer, e] of r) if (peer !== exceptPeer && e.ws.readyState === 1) e.ws.send(s);
}
function cleanPresence(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
  return JSON.stringify(p).length <= 4096 ? p : null;
}
function leave(ws, name) {
  const r = rooms.get(name);
  if (!r || !r.has(ws.peer) || r.get(ws.peer).ws !== ws) return;
  r.delete(ws.peer);
  ws.rooms.delete(name);
  broadcast(name, { t: 'left', room: name, peer: ws.peer });
  if (!r.size) rooms.delete(name);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', ws => {
  ws.peer = null; ws.rooms = new Set(); ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', buf => {
    let m;
    try { m = JSON.parse(buf); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      ws.peer = String(m.peer || '').replace(/[^a-z0-9]/g, '').slice(0, 24) || Math.random().toString(36).slice(2, 12);
      return send(ws, { t: 'welcome', peer: ws.peer });
    }
    if (!ws.peer) return;
    if (m.t === 'join') {
      if (!ROOM_NAME.test(m.room || '')) return send(ws, { t: 'joinErr', room: m.room });
      const r = rooms.get(m.room) || new Map();
      if (r.size >= MAX_PER_ROOM && !r.has(ws.peer)) return send(ws, { t: 'joinErr', room: m.room });
      rooms.set(m.room, r);
      const presence = cleanPresence(m.presence) || {};
      r.set(ws.peer, { ws, presence });
      ws.rooms.add(m.room);
      send(ws, { t: 'peers', room: m.room, peers: [...r].map(([peer, e]) => ({ peer, presence: e.presence })) });
      return broadcast(m.room, { t: 'pres', room: m.room, peer: ws.peer, presence }, ws.peer);
    }
    if (m.t === 'leave') return leave(ws, m.room);
    if (m.t === 'presence') {
      const r = rooms.get(m.room), e = r && r.get(ws.peer);
      if (!e || e.ws !== ws) return;
      const presence = cleanPresence(m.presence);
      if (!presence) return;
      e.presence = presence;
      broadcast(m.room, { t: 'pres', room: m.room, peer: ws.peer, presence }, ws.peer);
    }
  });
  ws.on('close', () => { for (const name of [...ws.rooms]) leave(ws, name); });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 25000);

server.listen(PORT, () => console.log('Rebond is running on port ' + PORT + ', serving ' + PUB + ' (index.html ' + (fs.existsSync(path.join(PUB, 'index.html')) ? 'found' : 'MISSING') + ')'));
