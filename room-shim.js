// Same API as the claude.ai `room` capability, backed by the server's WebSocket relay.
(function () {
  var peerId = (Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9]/g, '');
  var ws = null, open = false, backoff = 600;
  var connCbs = new Set();
  var rooms = new Map();
  var NAME = /^[a-z0-9][a-z0-9_.-]{0,47}$/;

  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); } return o; }
  function mkPeer(peer, presence, isMe) {
    return Object.freeze({ peer: peer, by: null, isMe: isMe, sameTab: isMe, kind: 'viewer', guest: false, presence: deepFreeze(presence || {}), updatedAt: Date.now() });
  }
  function wsSend(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
  function changed(st) {
    st.snap = null;
    var s = st.api.peers();
    st.cbs.forEach(function (f) { try { f({ peers: s, joined: [], left: [], updated: [] }); } catch (e) { /* ignore */ } });
  }
  function notifyConn() { connCbs.forEach(function (f) { try { f(open); } catch (e) { /* ignore */ } }); }

  function makeRoom(name) {
    var st = { name: name, map: new Map(), snap: null, cbs: new Set(), mine: {}, joined: false, waiters: [], pending: false };
    st.map.set(peerId, mkPeer(peerId, {}, true));
    var api = {
      name: name,
      emit: function () { return Promise.resolve(); },
      on: function () { return function () {}; },
      presence: function (patch) {
        for (var k in patch) { if (patch[k] === null) delete st.mine[k]; else st.mine[k] = patch[k]; }
        var s = JSON.stringify(st.mine);
        if (s.length > 4096) return Promise.reject({ code: 'invalid_argument', message: 'presence too large' });
        st.map.set(peerId, mkPeer(peerId, JSON.parse(s), true));
        changed(st);
        if (!st.pending) {
          st.pending = true;
          setTimeout(function () { st.pending = false; if (open && st.joined) wsSend({ t: 'presence', room: st.name, presence: st.mine }); }, 33);
        }
        return Promise.resolve();
      },
      peers: function () { return st.snap || (st.snap = Object.freeze(Array.from(st.map.values()))); },
      onPeers: function (fn, onErr) {
        st.cbs.add(fn);
        setTimeout(function () { var s = api.peers(); fn({ peers: s, joined: s, left: [], updated: [] }); }, 0);
        return function () { st.cbs.delete(fn); };
      },
      connected: function () { return open; },
      onConnection: function (fn) { connCbs.add(fn); setTimeout(function () { fn(open); }, 0); return function () { connCbs.delete(fn); }; },
      leave: function () { rooms.delete(name); if (open) wsSend({ t: 'leave', room: name }); return Promise.resolve(); },
      join: function (n) { return joinRoom(n); },
      sendToClaudeSession: function () { return Promise.reject({ code: 'claude_unavailable' }); },
      canSendToClaudeSession: function () { return Promise.resolve('off'); }
    };
    st.api = api;
    return st;
  }

  function joinRoom(n) {
    if (!NAME.test(n || '')) return Promise.reject({ code: 'invalid_argument', message: 'room name' });
    var existing = rooms.get(n);
    if (existing && existing.joined) return Promise.resolve(existing.api);
    var st = existing || makeRoom(n);
    rooms.set(n, st);
    return new Promise(function (resolve, reject) {
      st.waiters.push({ resolve: resolve, reject: reject });
      if (open) wsSend({ t: 'join', room: n, presence: st.mine });
      setTimeout(function () {
        if (!st.joined) {
          rooms.delete(n);
          st.waiters.splice(0).forEach(function (w) { w.reject({ code: 'upstream_error', message: 'no answer from the server' }); });
        }
      }, 12000);
    });
  }

  function connect() {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    try { ws = new WebSocket(url); } catch (e) { setTimeout(connect, backoff); return; }
    ws.onopen = function () { wsSend({ t: 'hello', peer: peerId }); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'welcome') {
        peerId = m.peer; open = true; backoff = 600;
        rooms.forEach(function (st) { wsSend({ t: 'join', room: st.name, presence: st.mine }); });
        notifyConn();
        return;
      }
      var st = rooms.get(m.room);
      if (!st) return;
      if (m.t === 'peers') {
        st.map = new Map();
        (m.peers || []).forEach(function (p) { if (p.peer !== peerId) st.map.set(p.peer, mkPeer(p.peer, p.presence, false)); });
        st.map.set(peerId, mkPeer(peerId, JSON.parse(JSON.stringify(st.mine)), true));
        st.joined = true;
        st.waiters.splice(0).forEach(function (w) { w.resolve(st.api); });
        changed(st);
      } else if (m.t === 'pres' && m.peer !== peerId) {
        st.map.set(m.peer, mkPeer(m.peer, m.presence, false)); changed(st);
      } else if (m.t === 'left') {
        if (st.map.delete(m.peer)) changed(st);
      } else if (m.t === 'joinErr') {
        rooms.delete(m.room);
        st.waiters.splice(0).forEach(function (w) { w.reject({ code: 'limit_reached', message: 'room unavailable' }); });
      }
    };
    ws.onclose = function () {
      var was = open; open = false;
      rooms.forEach(function (st) { st.joined = false; });
      if (was) notifyConn();
      setTimeout(connect, backoff); backoff = Math.min(backoff * 1.6, 5000);
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  rooms.set('lobby', makeRoom('lobby'));
  rooms.get('lobby').joined = false;
  connect();
  window.claude = { use: function (name) { return Promise.resolve(name === 'room' ? rooms.get('lobby').api : null); } };
})();
