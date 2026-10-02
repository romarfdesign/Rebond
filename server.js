// Rebond — standalone server: serves the game and relays multiplayer presence over WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let url = '/';
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { /* keep / */ }
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUB, url));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
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

server.listen(PORT, () => console.log('Rebond is running on port ' + PORT));
